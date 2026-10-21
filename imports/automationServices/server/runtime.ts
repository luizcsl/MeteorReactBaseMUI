import { createHash } from 'node:crypto';
import { OperationError } from '../../core/contracts/errors';
import {
	validateDefinition,
	parseRecipeData,
	parseRecipeFilters,
	type RecipeDefinition,
	type RecipeData
} from '../../core/recipes/definition';
import { authorizeLinkedAttachment } from '../../core/recipes/server/attachments';
import {
	recipeService,
	type RecipePorts,
	type RecipeIdentity,
	type RecipeScope
} from '../../core/recipes/server/engine';

export interface ServicesConfig {
	attachments?: { maxBytes: number; mimeTypes: string[] };
	csv?: { fields: string[]; maxRows: number };
	notifications?: { events: string[]; subjectTemplate: string; textTemplate: string };
	jobs?: { maxAttempts: number; leaseMs: number };
	search?: { fields: string[]; pageSize: number };
	audit?: { events: string[]; retentionDays: number };
	reports?: { metrics: { name: string; op: 'count' | 'sum'; field?: string }[] };
}
const invalid = (): never => {
	throw new OperationError('invalid-input');
};
const id = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : invalid());
function exact(v: unknown, keys: string[]): Record<string, unknown> {
	if (
		!v ||
		typeof v !== 'object' ||
		Array.isArray(v) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
		Reflect.ownKeys(v).some(
			(k) =>
				typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value')
		)
	)
		return invalid();
	return v as Record<string, unknown>;
}
/** Server composition only. Invocation userId and membership resolver must never originate in request DTOs. */
export function serviceAccess(definition: RecipeDefinition, ports: RecipePorts) {
	definition = validateDefinition(definition);
	const service = recipeService(definition, ports);
	return {
		service,
		async scope(userId: string | null, write = false): Promise<{ identity: RecipeIdentity; scope: RecipeScope }> {
			if (!userId) throw new OperationError('unauthenticated');
			const identity = await ports.resolveIdentity(id(userId));
			if (
				identity.userId !== userId ||
				!Array.isArray(identity.roles) ||
				identity.roles.some((r) => !['member', 'reviewer'].includes(r))
			)
				throw new OperationError('forbidden');
			const access = definition.permissions[write ? 'write' : 'read'];
			if (identity.tenantId !== undefined) id(identity.tenantId);
			if (['team', 'approval'].includes(definition.profile) && !identity.tenantId)
				throw new OperationError('forbidden');
			const team = access.some((r) => r !== 'owner' && identity.roles.includes(r));
			if (!team && !access.includes('owner')) throw new OperationError('forbidden');
			if (definition.profile === 'master-detail')
				throw new Error('needs-design: services require explicit parent scope; master-detail is not supported');
			const scope = team
				? { tenantId: id(identity.tenantId) }
				: identity.tenantId
					? { ownerId: userId, tenantId: identity.tenantId }
					: { ownerId: userId, tenantId: null };
			return { identity, scope };
		}
	};
}
async function scopedRecord(d: RecipeDefinition, ports: RecipePorts, scope: RecipeScope, documentId: string) {
	const row = await ports.repository.find(scope, documentId);
	if (
		!row ||
		row._id !== documentId ||
		row.deleted ||
		(scope.ownerId && row.ownerId !== scope.ownerId) ||
		(Object.hasOwn(scope, 'tenantId') && (row.tenantId ?? null) !== scope.tenantId)
	)
		throw new OperationError('not-found');
	parseRecipeData(d, row.data);
	return row;
}
export interface AttachmentStore {
	putPrivate(input: { ownerId: string; bytes: Uint8Array; mimeType: string; name: string }): Promise<{ id: string }>;
	removePrivate(fileId: string): Promise<void>;
	canReadFile(userId: string, fileId: string): Promise<boolean>;
	linked(documentId: string, fileId: string): Promise<boolean>;
	link(scope: RecipeScope, documentId: string, fileId: string): Promise<boolean>;
	readPrivate(fileId: string): Promise<Uint8Array>;
}
export function attachmentService(
	d: RecipeDefinition,
	config: NonNullable<ServicesConfig['attachments']>,
	ports: RecipePorts,
	store: AttachmentStore
) {
	const access = serviceAccess(d, ports);
	return {
		async upload(userId: string | null, raw: unknown) {
			const input = exact(raw, ['documentId', 'bytes', 'mimeType', 'name']);
			const documentId = id(input.documentId);
			if (
				!(input.bytes instanceof Uint8Array) ||
				input.bytes.byteLength < 1 ||
				input.bytes.byteLength > config.maxBytes ||
				typeof input.mimeType !== 'string' ||
				!config.mimeTypes.includes(input.mimeType) ||
				typeof input.name !== 'string' ||
				!/^[^/\\\x00-\x1f]{1,128}$/.test(input.name)
			)
				return invalid();
			const { scope, identity } = await access.scope(userId, true);
			await scopedRecord(d, ports, scope, documentId);
			const file = await store.putPrivate({
				ownerId: identity.userId,
				bytes: input.bytes,
				mimeType: input.mimeType,
				name: input.name
			});
			id(file.id);
			try {
				if (!(await store.link(scope, documentId, file.id))) throw new OperationError('conflict');
			} catch (error) {
				await store.removePrivate(file.id);
				throw error;
			}
			return { id: file.id };
		},
		async download(userId: string | null, raw: unknown) {
			const input = exact(raw, ['documentId', 'fileId']),
				documentId = id(input.documentId),
				fileId = id(input.fileId);
			const { scope } = await access.scope(userId);
			await authorizeLinkedAttachment(userId, documentId, fileId, {
				canReadDocument: async () => !!(await scopedRecord(d, ports, scope, documentId)),
				linked: store.linked.bind(store),
				canReadFile: store.canReadFile.bind(store)
			});
			const bytes = await store.readPrivate(fileId);
			if (bytes.byteLength > config.maxBytes) throw new Error('Attachment exceeds configured size');
			return bytes;
		}
	};
}
/** RFC4180 subset: comma separator, quoted newlines, UTF-8 text, strict column count. */
export function parseCsv(text: string, fields: string[], maxRows: number): string[][] {
	if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 5_000_000) return invalid();
	const rows: string[][] = [];
	let row: string[] = [],
		cell = '',
		quoted = false,
		closed = false;
	const endCell = () => {
		row.push(cell);
		cell = '';
		closed = false;
	};
	const endRow = () => {
		endCell();
		if (row.length !== fields.length) invalid();
		rows.push(row);
		row = [];
		if (rows.length > maxRows + 1) invalid();
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					quoted = false;
					closed = true;
				}
			} else cell += c;
		} else if (c === ',') endCell();
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			endRow();
		} else if (c === '"' && !cell && !closed) quoted = true;
		else {
			if (closed || c === '"') invalid();
			cell += c;
		}
	}
	if (quoted) invalid();
	if (cell || row.length || closed) endRow();
	if (!rows.length || rows[0].join('\0') !== fields.join('\0')) invalid();
	return rows.slice(1);
}
export function csvService(d: RecipeDefinition, config: NonNullable<ServicesConfig['csv']>, ports: RecipePorts) {
	const access = serviceAccess(d, ports);
	function parse(text: string): RecipeData[] {
		return parseCsv(text, config.fields, config.maxRows).map((row) =>
			parseRecipeData(d, {
				...Object.fromEntries(d.fields.map((f) => [f.name, null])),
				...Object.fromEntries(
					config.fields.map((field, i) => {
						const kind = d.fields.find((f) => f.name === field)!.type,
							value = row[i];
						return [
							field,
							value === ''
								? null
								: kind === 'integer' || kind === 'money'
									? Number(value)
									: kind === 'boolean'
										? value === 'true'
											? true
											: value === 'false'
												? false
												: invalid()
										: value
						];
					})
				)
			})
		);
	}
	return {
		parse,
		async import(userId: string | null, text: string, mutationPrefix: string) {
			id(mutationPrefix);
			await access.scope(userId, true);
			const rows = parse(text);
			let completed = 0;
			for (let i = 0; i < rows.length; i++) {
				try {
					await access.service.create(userId, {
						data: rows[i],
						parentId: null,
						mutationId: createHash('sha256')
							.update(mutationPrefix + ':' + i)
							.digest('hex')
					});
					completed++;
				} catch (error) {
					return {
						completed,
						total: rows.length,
						failedRow: i + 2,
						error: error instanceof OperationError ? error.code : 'internal-error'
					};
				}
			}
			return { completed, total: rows.length, failedRow: null };
		},
		async export(userId: string | null, filters: unknown = {}) {
			const { scope } = await access.scope(userId);
			const rows = await ports.repository.list(scope, parseRecipeFilters(d, filters), config.maxRows);
			if (rows.length > config.maxRows) throw new Error('Export bound exceeded');
			for (const row of rows) {
				if (
					row.deleted ||
					(scope.ownerId && row.ownerId !== scope.ownerId) ||
					(Object.hasOwn(scope, 'tenantId') && (row.tenantId ?? null) !== scope.tenantId)
				)
					throw new OperationError('forbidden');
				parseRecipeData(d, row.data);
			}
			const quote = (v: unknown) =>
				'"' +
				String(v ?? '')
					.replace(/^[=+\-@\t\r]/, "'$&")
					.replaceAll('"', '""') +
				'"';
			return [config.fields, ...rows.map((r) => config.fields.map((f) => r.data[f]))]
				.map((row) => row.map(quote).join(','))
				.join('\r\n');
		}
	};
}
export interface NotificationProvider {
	/** Revalidate recipients against scoped subscriptions. Return IDs, never client-chosen email addresses. */
	recipients(scope: RecipeScope, event: string, documentId: string): Promise<string[]>;
	send(input: { recipientId: string; subject: string; text: string; idempotencyKey: string }): Promise<void>;
}
export function notificationService(
	d: RecipeDefinition,
	config: NonNullable<ServicesConfig['notifications']>,
	ports: RecipePorts,
	provider: NotificationProvider
) {
	const access = serviceAccess(d, ports);
	return {
		async emit(userId: string | null, event: string, documentId: string, eventId: string) {
			id(eventId);
			id(documentId);
			if (!config.events.includes(event)) invalid();
			const { scope } = await access.scope(userId, true);
			const record = await scopedRecord(d, ports, scope, documentId);
			const render = (s: string) => {
				const rendered = s.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_m, key) => String(record.data[key] ?? ''));
				if (rendered.length > 100000) throw new Error('Rendered notification exceeds bound');
				return rendered;
			};
			const recipients = await provider.recipients(scope, event, documentId);
			if (recipients.length > 100) throw new Error('Recipient bound exceeded');
			for (const recipientId of new Set(recipients)) {
				id(recipientId);
				await provider.send({
					recipientId,
					subject: render(config.subjectTemplate).replace(/[\r\n]/g, ' '),
					text: render(config.textTemplate),
					idempotencyKey: createHash('sha256')
						.update(JSON.stringify([scope, event, documentId, eventId, recipientId]))
						.digest('hex')
				});
			}
			return { delivered: new Set(recipients).size };
		}
	};
}
export interface QueryPort {
	/** Must honor selector, projection, stable _id order and limit at the database. */
	find(
		selector: Record<string, unknown>,
		options: { sort: Record<string, 1 | -1>; limit: number; projection: Record<string, 1> }
	): Promise<Record<string, unknown>[]>;
	aggregate(pipeline: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
}
export function searchService(
	d: RecipeDefinition,
	config: NonNullable<ServicesConfig['search']>,
	ports: RecipePorts,
	query: QueryPort
) {
	const access = serviceAccess(d, ports);
	const indexScope = d.profile === 'owner' ? { ownerId: 1, tenantId: 1 } : { tenantId: 1 };
	return {
		indexes: [
			{ key: { ...indexScope, deleted: 1, _id: 1 } },
			...config.fields.map((field) => ({ key: { ...indexScope, deleted: 1, ['data.' + field]: 1, _id: 1 } }))
		],
		async page(userId: string | null, raw: unknown) {
			const input = exact(raw, ['filters', 'cursor', 'limit', 'order']);
			const filters = parseRecipeFilters(d, input.filters ?? {});
			if (Object.keys(filters).some((f) => !config.fields.includes(f))) invalid();
			const { scope } = await access.scope(userId);
			const limit = input.limit === undefined ? config.pageSize : input.limit;
			const order = input.order === undefined ? 'asc' : input.order;
			if (
				typeof limit !== 'number' ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > config.pageSize ||
				typeof order !== 'string' ||
				!['asc', 'desc'].includes(order)
			)
				invalid();
			const binding = createHash('sha256').update(JSON.stringify({ scope, filters, limit, order })).digest('hex');
			let after: string | undefined;
			if (input.cursor !== undefined && input.cursor !== null) {
				if (typeof input.cursor !== 'string' || input.cursor.length > 1024) invalid();
				try {
					const c = JSON.parse(Buffer.from(input.cursor as string, 'base64url').toString());
					if (c.binding !== binding) invalid();
					after = id(c.after);
				} catch {
					invalid();
				}
			}
			const selector: Record<string, unknown> = {
				...scope,
				deleted: false,
				...Object.fromEntries(Object.entries(filters).map(([k, v]) => ['data.' + k, v])),
				...(after ? { _id: { [order === 'asc' ? '$gt' : '$lt']: after } } : {})
			};
			const rows = await query.find(selector, {
				sort: { _id: order === 'asc' ? 1 : -1 },
				limit: (limit as number) + 1,
				projection: { _id: 1, version: 1, state: 1, data: 1 }
			});
			if (rows.length > (limit as number) + 1) throw new Error('Query adapter exceeded limit');
			const page = rows.slice(0, limit as number).map((r) => {
				if (
					!Number.isSafeInteger(r.version) ||
					Number(r.version) < 1 ||
					typeof r.state !== 'string' ||
					!d.states.includes(r.state)
				)
					throw new OperationError('invalid-input');
				return {
					id: id(r._id),
					parentId: null,
					version: r.version as number,
					state: r.state,
					data: parseRecipeData(d, r.data)
				};
			});
			return {
				items: page,
				nextCursor:
					rows.length > (limit as number)
						? Buffer.from(JSON.stringify({ binding, after: page.at(-1)!.id })).toString('base64url')
						: null
			};
		}
	};
}
export function reportService(
	d: RecipeDefinition,
	config: NonNullable<ServicesConfig['reports']>,
	ports: RecipePorts,
	query: QueryPort
) {
	const access = serviceAccess(d, ports);
	return {
		async run(userId: string | null, filters: unknown = {}) {
			const { scope } = await access.scope(userId);
			const parsed = parseRecipeFilters(d, filters);
			const group: Record<string, unknown> = { _id: null };
			for (const m of config.metrics) group[m.name] = { $sum: m.op === 'count' ? 1 : '$data.' + m.field };
			const rows = await query.aggregate([
				{
					$match: {
						...scope,
						deleted: false,
						...Object.fromEntries(Object.entries(parsed).map(([k, v]) => ['data.' + k, v]))
					}
				},
				{ $group: group },
				{ $limit: 1 }
			]);
			return Object.fromEntries(
				config.metrics.map((m) => {
					const value = rows[0]?.[m.name] ?? 0;
					if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid aggregate result');
					return [m.name, value];
				})
			);
		}
	};
}
export interface AuditPort {
	append(record: {
		scope: RecipeScope;
		actorId: string;
		event: string;
		documentId: string;
		at: Date;
		expiresAt: Date;
		changes: RecipeData;
	}): Promise<void>;
	list(
		scope: RecipeScope,
		documentId: string,
		limit: number
	): Promise<{ actorId: string; event: string; at: Date; changes: RecipeData }[]>;
}
export function auditService(
	d: RecipeDefinition,
	config: NonNullable<ServicesConfig['audit']>,
	ports: RecipePorts,
	audit: AuditPort
) {
	const access = serviceAccess(d, ports);
	return {
		indexes: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
		async append(userId: string | null, event: string, documentId: string, changes: unknown) {
			if (!config.events.includes(event)) invalid();
			id(documentId);
			const { scope, identity } = await access.scope(userId, true);
			await scopedRecord(d, ports, scope, documentId);
			const data = parseRecipeData(d, changes);
			const at = new Date();
			await audit.append({
				scope,
				actorId: identity.userId,
				event,
				documentId,
				at,
				expiresAt: new Date(at.getTime() + config.retentionDays * 86400000),
				changes: data
			});
		},
		async history(userId: string | null, documentId: string) {
			id(documentId);
			const { scope } = await access.scope(userId);
			await scopedRecord(d, ports, scope, documentId);
			const rows = await audit.list(scope, documentId, 100);
			if (rows.length > 100) throw new Error('Audit bound exceeded');
			return rows.map((r) => {
				if (!config.events.includes(r.event) || !(r.at instanceof Date) || !Number.isFinite(r.at.getTime()))
					throw new OperationError('invalid-input');
				return { actorId: id(r.actorId), event: r.event, at: r.at, changes: parseRecipeData(d, r.changes) };
			});
		}
	};
}

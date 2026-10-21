import { createHash } from 'node:crypto';
import { OperationError } from '../../contracts/errors';
import {
	parseRecipeData,
	parseRecipeFilters,
	validateDefinition,
	type Access,
	type RecipeData,
	type RecipeDefinition
} from '../definition';
export interface RecipeIdentity {
	userId: string;
	tenantId?: string;
	roles: readonly ('member' | 'reviewer')[];
}
export interface RecipeScope {
	ownerId?: string;
	tenantId?: string | null;
	parentId?: string;
}
export interface RecipeRecord {
	creationFingerprint: string;
	deleted: boolean;
	_id: string;
	ownerId: string;
	tenantId?: string;
	parentId?: string;
	version: number;
	state: string;
	data: RecipeData;
	/** Trusted server timestamp; legacy records may omit it. Never projected in DTOs. */
	updatedAt?: Date;
}
export interface RecipeDTO {
	id: string;
	parentId: string | null;
	version: number;
	state: string;
	data: RecipeData;
}
/** Server-only compiled-query adapter. Callers MUST build authorized selectors; never expose raw queries over DDP. */
export interface RecipeQueryPort {
	find(
		selector: Record<string, unknown>,
		options: { sort: Record<string, 1 | -1>; limit: number; projection: Record<string, 1> }
	): Promise<Record<string, unknown>[]>;
	aggregate(pipeline: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
}
export interface RecipeRepository {
	query?: RecipeQueryPort;
	observeChanges?: (invalidate: () => void) => Promise<{ stop(): void | Promise<void> }>;
	find(scope: RecipeScope, id: string): Promise<RecipeRecord | null>;
	list(scope: RecipeScope, filters: RecipeData, limit: number): Promise<RecipeRecord[]>;
	insert(record: RecipeRecord): Promise<RecipeRecord>;
	compareAndSet(
		scope: RecipeScope,
		id: string,
		version: number,
		next: Pick<RecipeRecord, 'data' | 'state' | 'version' | 'updatedAt'>
	): Promise<boolean>;
	remove(scope: RecipeScope, id: string, version: number): Promise<boolean>;
}
export interface RecipePorts {
	repository: RecipeRepository;
	/** Server-only repository decoration, applied once before registration. */
	configureRepository?: (repository: RecipeRepository) => RecipeRepository;
	/** Must atomically check relationships AND delete the versioned root in one transaction. */
	removeWithRelations?: (scope: RecipeScope, row: RecipeRecord, expectedVersion: number) => Promise<boolean>;
	/** Trusted clock and workflow hook, never invocation-controlled. */
	now?: () => Date;
	beforeTransition?: (context: {
		identity: RecipeIdentity;
		scope: RecipeScope;
		row: RecipeRecord;
		to: string;
		now: Date;
	}) => void | Promise<void>;
	resolveIdentity: (userId: string) => Promise<RecipeIdentity>;
	/** Mandatory for reactive registration: observe account, membership, and policy revocation. */
	observeIdentity?: (userId: string, invalidate: () => void) => Promise<{ stop(): void | Promise<void> }>;
	parentExists?: (scope: RecipeScope, id: string) => Promise<boolean>;
	/** Required for reactive master/detail: invalidate on parent visibility/lifecycle changes. */
	observeDependencies?: (invalidate: () => void) => Promise<{ stop(): void | Promise<void> }>;
	/** Must scope the target to this verified identity, never just test its existence. */
	referenceExists?: (identity: RecipeIdentity, target: string, id: string) => Promise<boolean>;
}
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const input = (v: unknown, keys: string[]): Record<string, unknown> => {
	if (
		!v ||
		typeof v !== 'object' ||
		Array.isArray(v) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
		Reflect.ownKeys(v).length !== keys.length ||
		Reflect.ownKeys(v).some((k) => typeof k !== 'string' || !keys.includes(k))
	)
		throw new OperationError('invalid-input');
	return v as Record<string, unknown>;
};
const version = (v: unknown): number => {
	if (!Number.isSafeInteger(v) || Number(v) < 1) throw new OperationError('invalid-input');
	return Number(v);
};
/** Server-only service. resolveIdentity MUST revalidate active account and current membership per call. */
export function recipeService(raw: RecipeDefinition, ports: RecipePorts) {
	const d = validateDefinition(raw);
	const now = (): Date => {
		const value = ports.now ? ports.now() : new Date();
		if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new OperationError('invalid-input');
		return new Date(value.getTime());
	};
	if (d.profile === 'master-detail' && !ports.parentExists)
		throw new Error('Master/detail requires a scoped parent repository');
	if (d.fields.some((f) => f.type === 'reference') && !ports.referenceExists)
		throw new Error('References require a scoped referenceExists port');
	async function references(who: RecipeIdentity, data: RecipeData) {
		for (const field of d.fields.filter((f) => f.type === 'reference')) {
			const id = data[field.name];
			if (id !== null && !(await ports.referenceExists!(who, field.target!, id as string)))
				throw new OperationError('not-found');
		}
	}
	async function identity(userId: string | null): Promise<RecipeIdentity> {
		if (!userId) throw new OperationError('unauthenticated');
		const who = await ports.resolveIdentity(userId);
		if (
			who.userId !== userId ||
			!validId(who.userId) ||
			!Array.isArray(who.roles) ||
			who.roles.some((r) => !['member', 'reviewer'].includes(r))
		)
			throw new OperationError('forbidden');
		if (
			(who.tenantId !== undefined && !validId(who.tenantId)) ||
			(['team', 'approval'].includes(d.profile) && !validId(who.tenantId))
		)
			throw new OperationError('forbidden');
		return { ...who, roles: [...who.roles] };
	}
	const scope = (who: RecipeIdentity, rights: Access[]): RecipeScope => {
		const team = rights.some((r) => r !== 'owner' && who.roles.includes(r));
		if (team) {
			if (!who.tenantId) throw new OperationError('forbidden');
			return { tenantId: who.tenantId };
		}
		if (rights.includes('owner'))
			return who.tenantId ? { tenantId: who.tenantId, ownerId: who.userId } : { ownerId: who.userId, tenantId: null };
		throw new OperationError('forbidden');
	};
	const matchesScope = (scope: RecipeScope, row: RecipeRecord) =>
		(!scope.ownerId || row.ownerId === scope.ownerId) &&
		(!Object.hasOwn(scope, 'tenantId') || (row.tenantId ?? null) === scope.tenantId) &&
		(!scope.parentId || row.parentId === scope.parentId);
	const project = (row: RecipeRecord): RecipeDTO => {
		if (
			!validId(row._id) ||
			!validId(row.ownerId) ||
			row.deleted !== false ||
			(row.tenantId !== undefined && !validId(row.tenantId)) ||
			!Number.isSafeInteger(row.version) ||
			row.version < 1 ||
			row.version >= Number.MAX_SAFE_INTEGER ||
			typeof row.state !== 'string' ||
			!d.states.includes(row.state) ||
			(d.profile === 'master-detail' ? !validId(row.parentId) : row.parentId !== undefined)
		)
			throw new OperationError('invalid-input');
		return {
			id: row._id,
			parentId: row.parentId ?? null,
			version: row.version,
			state: row.state,
			data: parseRecipeData(d, row.data)
		};
	};
	async function get(who: RecipeIdentity, id: unknown, rights: Access[]) {
		if (!validId(id)) throw new OperationError('invalid-input');
		const s = scope(who, rights);
		const row = await ports.repository.find(s, id);
		if (!row || row._id !== id || row.deleted || !matchesScope(s, row)) throw new OperationError('not-found');
		if (
			d.profile === 'master-detail' &&
			(!row.parentId || !(await ports.parentExists!(scope(who, ['owner']), row.parentId)))
		)
			throw new OperationError('not-found');
		project(row); // Reject corrupted persisted DTOs before a mutation can execute.
		if (row.version >= Number.MAX_SAFE_INTEGER - 1) throw new OperationError('conflict');
		return { s, row };
	}
	return {
		async list(userId: string | null, value: unknown) {
			const v = input(value, d.profile === 'master-detail' ? ['filters', 'limit', 'parentId'] : ['filters', 'limit']);
			if (!Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 100)
				throw new OperationError('invalid-input');
			const who = await identity(userId),
				s = scope(who, d.permissions.read);
			if (d.profile === 'master-detail') {
				if (!validId(v.parentId) || !(await ports.parentExists!(scope(who, ['owner']), v.parentId)))
					throw new OperationError('not-found');
				s.parentId = v.parentId;
			}
			const rows = await ports.repository.list(s, parseRecipeFilters(d, v.filters), Number(v.limit));
			if (rows.length > Number(v.limit) || rows.some((r) => r.deleted || !matchesScope(s, r)))
				throw new OperationError('forbidden');
			return rows.map(project);
		},
		async create(userId: string | null, value: unknown) {
			const v = input(value, ['data', 'parentId', 'mutationId']);
			const who = await identity(userId);
			scope(who, d.permissions.write);
			const data = parseRecipeData(d, v.data);
			await references(who, data);
			if (d.profile === 'master-detail') {
				if (!validId(v.parentId) || !(await ports.parentExists!(scope(who, ['owner']), v.parentId)))
					throw new OperationError('not-found');
			} else if (v.parentId !== null) throw new OperationError('invalid-input');
			if (!validId(v.mutationId)) throw new OperationError('invalid-input');
			const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
			const creationFingerprint = digest([data, v.parentId]);
			const row: RecipeRecord = {
				_id: digest([d.name, who.userId, who.tenantId ?? null, v.mutationId]),
				creationFingerprint,
				deleted: false,
				ownerId: who.userId,
				version: 1,
				state: d.states[0],
				updatedAt: now(),
				data,
				...(who.tenantId ? { tenantId: who.tenantId } : {}),
				...(typeof v.parentId === 'string' ? { parentId: v.parentId } : {})
			};
			const stored = await ports.repository.insert(row);
			if (
				stored._id !== row._id ||
				stored.ownerId !== who.userId ||
				stored.tenantId !== who.tenantId ||
				stored.creationFingerprint !== creationFingerprint ||
				stored.deleted
			)
				throw new OperationError('conflict');
			return project(stored);
		},
		async update(userId: string | null, value: unknown) {
			const v = input(value, ['id', 'version', 'data']);
			const who = await identity(userId);
			const { s, row } = await get(who, v.id, d.permissions.write);
			if (row.version !== version(v.version)) throw new OperationError('conflict');
			if (d.profile === 'approval' && row.state !== d.states[0]) throw new OperationError('forbidden');
			const data = parseRecipeData(d, v.data);
			await references(who, data);
			const updatedAt = now();
			if (
				!(await ports.repository.compareAndSet(s, row._id, row.version, {
					data,
					state: row.state,
					updatedAt,
					version: row.version + 1
				}))
			)
				throw new OperationError('conflict');
			return project({ ...row, data, version: row.version + 1 });
		},
		async transition(userId: string | null, value: unknown) {
			const v = input(value, ['id', 'version', 'to']);
			const who = await identity(userId);
			const { s, row } = await get(who, v.id, d.permissions.read);
			if (row.version !== version(v.version)) throw new OperationError('conflict');
			await references(who, row.data);
			const t = d.transitions.find((t) => t.from === row.state && t.to === v.to);
			if (!t) throw new OperationError('invalid-input');
			const permitted = t.roles.some((r) =>
				r === 'owner' ? row.ownerId === who.userId : who.roles.includes(r as 'member' | 'reviewer')
			);
			if (!permitted || (d.profile === 'approval' && t.roles.includes('reviewer') && row.ownerId === who.userId))
				throw new OperationError('forbidden');
			const updatedAt = now();
			await ports.beforeTransition?.({ identity: who, scope: s, row, to: t.to, now: updatedAt });
			if (
				!(await ports.repository.compareAndSet(s, row._id, row.version, {
					data: row.data,
					state: t.to,
					updatedAt,
					version: row.version + 1
				}))
			)
				throw new OperationError('conflict');
			return project({ ...row, state: t.to, version: row.version + 1 });
		},
		async remove(userId: string | null, value: unknown) {
			const v = input(value, ['id', 'version']);
			const who = await identity(userId);
			const { s, row } = await get(who, v.id, d.permissions.write);
			if (d.profile === 'approval' && row.state !== d.states[0]) throw new OperationError('forbidden');
			const expectedVersion = version(v.version);
			if (row.version !== expectedVersion) throw new OperationError('conflict');
			const removed = ports.removeWithRelations
				? await ports.removeWithRelations(s, row, expectedVersion)
				: await ports.repository.remove(s, row._id, expectedVersion);
			if (!removed) throw new OperationError('conflict');
			return { removed: true as const };
		}
	};
}

import { OperationError } from '../../contracts/errors';
import { isPlainDenseArray, parseRecipeData, validateDefinition, type RecipeDefinition } from '../definition';
import type { RecipePorts, RecipeRecord, RecipeRepository, RecipeScope } from './engine';

export interface IncomingRelationship {
	name: string;
	source: string;
	/** parentId is the immutable master/detail link; otherwise a named data reference. */
	field: string;
	policy: 'restrict' | 'cascade' | 'set-null';
	maxAffected: number;
}
export interface RelationshipConfiguration {
	incoming: IncomingRelationship[];
	outgoing: { field: string; target: string }[];
	/** Includes the root and distinct cascaded or nullified records. */
	maxTotal: number;
}
export interface RelationshipModule {
	definition: RecipeDefinition;
	relationships: RelationshipConfiguration;
	collection: string;
}
export type RelationshipNext = Pick<RecipeRecord, 'data' | 'state' | 'version' | 'updatedAt'>;
/** Every operation is bound to the SAME transaction and same serialized scope fence. */
export interface RelationshipTransaction {
	find(module: string, scope: RecipeScope, id: string): Promise<RecipeRecord | null>;
	references(
		module: string,
		scope: RecipeScope,
		field: string,
		targetId: string,
		limit: number
	): Promise<RecipeRecord[]>;
	insert(module: string, record: RecipeRecord): Promise<RecipeRecord>;
	compareAndSet(
		module: string,
		scope: RecipeScope,
		id: string,
		version: number,
		next: RelationshipNext
	): Promise<boolean>;
	remove(module: string, scope: RecipeScope, id: string, version: number): Promise<boolean>;
}
export interface RelationshipAdapter {
	readonly modules: readonly RelationshipModule[];
	/** No non-transactional fallback. Serialize ALL registry writes by tenant (personal: owner), before any reads. */
	run<T>(scope: RecipeScope, work: (transaction: RelationshipTransaction) => Promise<T>): Promise<T>;
}
const bad = (message: string): never => {
	throw new Error(`relationships: ${message}`);
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const moduleName = (value: unknown): value is string =>
	typeof value === 'string' && /^[a-z][a-z0-9]{2,31}$/.test(value);
const fieldName = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[a-z][A-Za-z0-9]{0,39}$/.test(value) &&
	!['constructor', 'prototype', '__proto__', 'ownerId', 'tenantId', 'version', 'state', 'deleted'].includes(value);
function exact(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		return bad('expected plain object');
	if (
		Reflect.ownKeys(value).length !== keys.length ||
		Reflect.ownKeys(value).some(
			(key) =>
				typeof key !== 'string' ||
				!keys.includes(key) ||
				!Object.getOwnPropertyDescriptor(value, key)!.enumerable ||
				!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')
		)
	)
		return bad('unknown or missing property');
	return value as Record<string, unknown>;
}
export function validateRelationships(raw: unknown, rawDefinition: RecipeDefinition): RelationshipConfiguration {
	const definition = validateDefinition(rawDefinition),
		value = exact(raw, ['incoming', 'outgoing', 'maxTotal']);
	if (definition.fields.some((field) => field.name === 'parentId' && field.type === 'reference'))
		return bad('parentId is reserved for the master/detail envelope');
	if (!isPlainDenseArray(value.incoming, 30) || !isPlainDenseArray(value.outgoing, 31))
		return bad('expected bounded dense lists');
	if (!Number.isSafeInteger(value.maxTotal) || Number(value.maxTotal) < 1 || Number(value.maxTotal) > 500)
		return bad('maxTotal must be 1..500');
	const names = new Set<string>(),
		links = new Set<string>();
	const incoming = value.incoming.map((rawLink) => {
		const link = exact(rawLink, ['name', 'source', 'field', 'policy', 'maxAffected']);
		if (
			!fieldName(link.name) ||
			!moduleName(link.source) ||
			!fieldName(link.field) ||
			!['restrict', 'cascade', 'set-null'].includes(String(link.policy)) ||
			!Number.isSafeInteger(link.maxAffected) ||
			Number(link.maxAffected) < 1 ||
			Number(link.maxAffected) > 100
		)
			return bad('invalid incoming policy');
		if (link.field === 'parentId' && link.policy === 'set-null') return bad('master/detail parent cannot be nullified');
		const key = `${link.source}:${link.field}`;
		if (names.has(link.name) || links.has(key)) return bad('duplicate incoming policy');
		names.add(link.name);
		links.add(key);
		return {
			name: link.name,
			source: link.source,
			field: link.field,
			policy: link.policy,
			maxAffected: link.maxAffected
		} as IncomingRelationship;
	});
	const fields = new Set<string>();
	const outgoing = value.outgoing.map((rawLink) => {
		const link = exact(rawLink, ['field', 'target']);
		if (!fieldName(link.field) || !moduleName(link.target) || fields.has(link.field))
			return bad('invalid or duplicate outgoing relationship');
		const field = definition.fields.find((field) => field.name === link.field);
		if (
			link.field === 'parentId'
				? definition.profile !== 'master-detail'
				: !field || field.type !== 'reference' || field.target !== link.target
		)
			return bad('outgoing link must match the definition');
		fields.add(link.field);
		return { field: link.field, target: link.target } as { field: string; target: string };
	});
	if (
		definition.fields.some((field) => field.type === 'reference' && !fields.has(field.name)) ||
		(definition.profile === 'master-detail' && !fields.has('parentId'))
	)
		return bad('every reference and master/detail parent requires an outgoing declaration');
	return { incoming, outgoing, maxTotal: Number(value.maxTotal) };
}
function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}
/** Validate both sides and snapshot the complete participating graph before exposing mutation ports. */
export function validateRelationshipRegistry(raw: readonly RelationshipModule[]): readonly RelationshipModule[] {
	if (!isPlainDenseArray(raw, 30) || !raw.length) return bad('registry requires 1..30 modules');
	const modules = raw.map((item) => {
		exact(item, ['definition', 'relationships', 'collection']);
		const definition = validateDefinition(item.definition);
		if (
			typeof item.collection !== 'string' ||
			!/^[a-z][a-z0-9_]{2,63}$/.test(item.collection) ||
			item.collection === 'recipe_relationship_fences'
		)
			return bad('invalid collection');
		return {
			definition,
			relationships: validateRelationships(item.relationships, definition),
			collection: item.collection
		};
	});
	if (
		new Set(modules.map((item) => item.definition.name)).size !== modules.length ||
		new Set(modules.map((item) => item.collection)).size !== modules.length
	)
		return bad('duplicate registry module or collection');
	for (const module of modules) {
		for (const link of module.relationships.outgoing) {
			const target = modules.find((item) => item.definition.name === link.target);
			if (
				!target?.relationships.incoming.some(
					(policy) => policy.source === module.definition.name && policy.field === link.field
				)
			)
				return bad('outgoing relationship requires a registered inverse policy');
		}
		for (const policy of module.relationships.incoming) {
			const source = modules.find((item) => item.definition.name === policy.source);
			if (
				!source?.relationships.outgoing.some(
					(link) => link.target === module.definition.name && link.field === policy.field
				)
			)
				return bad('incoming policy requires its registered source');
			if (
				policy.policy === 'set-null' &&
				source.definition.fields.find((field) => field.name === policy.field)?.required !== false
			)
				return bad('set-null requires an optional reference field');
		}
	}
	return freeze(JSON.parse(JSON.stringify(modules)) as RelationshipModule[]);
}
/** Explicit null tenant is mandatory for personal scope; owner alone must never span tenants. */
export function assertRelationshipScope(scope: RecipeScope): void {
	if (
		!scope ||
		typeof scope !== 'object' ||
		![Object.prototype, null].includes(Object.getPrototypeOf(scope)) ||
		Reflect.ownKeys(scope).some(
			(key) =>
				!['ownerId', 'tenantId', 'parentId'].includes(String(key)) ||
				!Object.getOwnPropertyDescriptor(scope, key)!.enumerable ||
				!Object.hasOwn(Object.getOwnPropertyDescriptor(scope, key)!, 'value')
		)
	)
		throw new OperationError('forbidden');
	if (
		!Object.hasOwn(scope, 'tenantId') ||
		!(scope.tenantId === null || id(scope.tenantId)) ||
		(scope.ownerId !== undefined && !id(scope.ownerId)) ||
		(scope.tenantId === null && !id(scope.ownerId)) ||
		(scope.parentId !== undefined && !id(scope.parentId))
	)
		throw new OperationError('forbidden');
}
export const relationshipScopeMatches = (scope: RecipeScope, row: RecipeRecord): boolean =>
	(!scope.ownerId || row.ownerId === scope.ownerId) &&
	(row.tenantId ?? null) === scope.tenantId &&
	(!scope.parentId || row.parentId === scope.parentId);
const ownedScope = (row: RecipeRecord): RecipeScope => ({ ownerId: row.ownerId, tenantId: row.tenantId ?? null });
function validateRow(module: RelationshipModule, scope: RecipeScope, row: RecipeRecord): void {
	if (
		!row ||
		!id(row._id) ||
		!id(row.ownerId) ||
		row.deleted !== false ||
		!relationshipScopeMatches(scope, row) ||
		!Number.isSafeInteger(row.version) ||
		row.version < 1 ||
		row.version >= Number.MAX_SAFE_INTEGER - 1 ||
		!module.definition.states.includes(row.state) ||
		(module.definition.profile === 'master-detail' ? !id(row.parentId) : row.parentId !== undefined)
	)
		throw new OperationError('conflict');
	parseRecipeData(module.definition, row.data);
}

/** Wrap every writer; installing only the removal hook is not a valid relationship integration. */
export function withRelationshipPorts<P extends Omit<RecipePorts, 'repository'>>(
	base: P,
	definition: RecipeDefinition,
	configuration: RelationshipConfiguration,
	adapter: RelationshipAdapter
): P & Omit<RecipePorts, 'repository'> {
	if (!adapter || typeof adapter.run !== 'function') return bad('approved transactional adapter is required');
	if (base.removeWithRelations || base.configureRepository)
		return bad('relationship repository wrappers cannot be composed implicitly');
	const registry = validateRelationshipRegistry(adapter.modules),
		byName = new Map(registry.map((item) => [item.definition.name, item]));
	const root = byName.get(definition.name),
		config = validateRelationships(configuration, definition);
	if (
		!root ||
		JSON.stringify(root.definition) !== JSON.stringify(validateDefinition(definition)) ||
		JSON.stringify(root.relationships) !== JSON.stringify(config)
	)
		return bad('generated contract differs from registered transaction graph');
	const moduleFor = (name: string): RelationshipModule => {
		const module = byName.get(name);
		if (!module) return bad('unregistered module');
		return module;
	};
	async function checkReferences(tx: RelationshipTransaction, module: RelationshipModule, row: RecipeRecord) {
		const scope = ownedScope(row);
		assertRelationshipScope(scope);
		validateRow(module, scope, row);
		for (const link of module.relationships.outgoing) {
			const targetId = link.field === 'parentId' ? row.parentId : row.data[link.field];
			if (targetId === null) continue;
			if (!id(targetId)) throw new OperationError('invalid-input');
			const target = await tx.find(link.target, scope, targetId);
			if (!target || target._id !== targetId || target.deleted || !relationshipScopeMatches(scope, target))
				throw new OperationError('not-found');
			validateRow(moduleFor(link.target), scope, target);
		}
	}
	async function remove(scope: RecipeScope, expected: RecipeRecord, expectedVersion: number): Promise<boolean> {
		assertRelationshipScope(scope);
		if (!id(expected._id) || expected.version !== expectedVersion) throw new OperationError('conflict');
		return adapter.run(scope, async (tx) => {
			const row = await tx.find(root!.definition.name, scope, expected._id);
			if (!row || row._id !== expected._id || row.version !== expectedVersion) throw new OperationError('conflict');
			const deletes = new Map<string, { module: RelationshipModule; row: RecipeRecord }>();
			const nulls = new Map<string, { module: RelationshipModule; row: RecipeRecord; fields: Set<string> }>();
			// ParentId only scopes the requested root. Child queries inherit owner/tenant, not an unrelated parent's ID.
			const relationScope: RecipeScope = {
				...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
				tenantId: scope.tenantId
			};
			const key = (name: string, id: string) => `${name}:${id}`;
			const bounded = () => {
				if (new Set([...deletes.keys(), ...nulls.keys()]).size > config.maxTotal) throw new OperationError('conflict');
			};
			async function visit(module: RelationshipModule, row: RecipeRecord, depth: number): Promise<void> {
				validateRow(module, relationScope, row);
				if (module.definition.profile === 'approval' && row.state !== module.definition.states[0])
					throw new OperationError('forbidden');
				const rowKey = key(module.definition.name, row._id);
				if (deletes.has(rowKey)) return;
				if (depth > 32) throw new OperationError('conflict');
				deletes.set(rowKey, { module, row });
				bounded();
				for (const policy of module.relationships.incoming) {
					const related = await tx.references(
						policy.source,
						relationScope,
						policy.field,
						row._id,
						policy.maxAffected + 1
					);
					if (!Array.isArray(related) || related.length > policy.maxAffected) throw new OperationError('conflict');
					const source = moduleFor(policy.source),
						seen = new Set<string>();
					for (const child of related) {
						validateRow(source, relationScope, child);
						if (
							(policy.field === 'parentId' ? child.parentId : child.data[policy.field]) !== row._id ||
							seen.has(child._id)
						)
							throw new OperationError('conflict');
						seen.add(child._id);
					}
					if (policy.policy === 'restrict' && related.length) throw new OperationError('conflict');
					for (const child of related) {
						if (policy.policy === 'cascade') await visit(source, child, depth + 1);
						else if (policy.policy === 'set-null') {
							if (source.definition.profile === 'approval' && child.state !== source.definition.states[0])
								throw new OperationError('forbidden');
							const childKey = key(policy.source, child._id),
								existing = nulls.get(childKey);
							if (existing && existing.row.version !== child.version) throw new OperationError('conflict');
							if (!existing) nulls.set(childKey, { module: source, row: child, fields: new Set([policy.field]) });
							else existing.fields.add(policy.field);
							bounded();
						}
					}
				}
			}
			validateRow(root!, scope, row);
			await visit(root!, row, 0);
			for (const [rowKey, change] of nulls) {
				if (deletes.has(rowKey)) continue;
				const data = { ...change.row.data };
				for (const field of change.fields) data[field] = null;
				parseRecipeData(change.module.definition, data);
				if (
					!(await tx.compareAndSet(change.module.definition.name, relationScope, change.row._id, change.row.version, {
						data,
						state: change.row.state,
						version: change.row.version + 1,
						updatedAt: new Date()
					}))
				)
					throw new OperationError('conflict');
			}
			// Children first, root last. Any failed CAS throws and aborts the entire transaction.
			for (const change of [...deletes.values()].reverse()) {
				if (!(await tx.remove(change.module.definition.name, relationScope, change.row._id, change.row.version)))
					throw new OperationError('conflict');
			}
			return true;
		});
	}
	const configureRepository = (repository: RecipeRepository): RecipeRepository => ({
		...repository,
		insert: async (record) =>
			adapter.run(ownedScope(record), async (tx) => {
				await checkReferences(tx, root!, record);
				return tx.insert(definition.name, record);
			}),
		compareAndSet: async (scope, id, version, next) => {
			assertRelationshipScope(scope);
			return adapter.run(scope, async (tx) => {
				const row = await tx.find(definition.name, scope, id);
				if (!row || row._id !== id || row.version !== version) return false;
				validateRow(root!, scope, row);
				if (next.version !== version + 1) throw new OperationError('conflict');
				await checkReferences(tx, root!, { ...row, ...next });
				return tx.compareAndSet(definition.name, scope, id, version, next);
			});
		},
		remove: async (scope, id, version) => remove(scope, { _id: id, version } as RecipeRecord, version)
	});
	return { ...base, configureRepository, removeWithRelations: remove };
}

import { createHash } from 'node:crypto';
import type { ClientSession, Db, Filter } from 'mongodb';
import { OperationError } from '../../contracts/errors';
import type { RecipeRecord, RecipeScope } from './engine';
import {
	assertRelationshipScope,
	relationshipScopeMatches,
	validateRelationshipRegistry,
	type RelationshipAdapter,
	type RelationshipModule,
	type RelationshipTransaction
} from './relationships';

export interface MongoRelationshipOptions {
	/** Database and sessions MUST belong to the same reviewed Mongo client. Replica set/sharded transactions are required. */
	database: Db;
	startSession: () => ClientSession;
	modules: readonly RelationshipModule[];
}
/**
 * Real native-driver transaction adapter. There is deliberately no standalone-Mongo fallback.
 * All participating writers MUST use withRelationshipPorts. Snapshot isolation alone would
 * allow a reference insert between an absence check and deletion; a shared fence serializes
 * every registry insert/update/delete for a tenant (personal scope: owner) BEFORE reads.
 * No external side effects are allowed in the transaction callback, which Mongo may retry.
 */
export function createMongoRelationshipAdapter(options: MongoRelationshipOptions): RelationshipAdapter {
	const modules = validateRelationshipRegistry(options.modules);
	if (
		!options.database ||
		typeof options.database.collection !== 'function' ||
		typeof options.startSession !== 'function'
	)
		throw new Error('relationships: approved database and session factory required');
	const collections = new Map(
		modules.map((module) => [module.definition.name, options.database.collection<RecipeRecord>(module.collection)])
	);
	const fences = options.database.collection<{ _id: string; epoch: number }>('recipe_relationship_fences');
	const collectionFor = (module: string) => {
		const collection = collections.get(module);
		if (!collection) throw new Error('relationships: unregistered module');
		return collection;
	};
	const selector = (scope: RecipeScope, id?: string): Filter<RecipeRecord> => {
		assertRelationshipScope(scope);
		if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
			throw new OperationError('invalid-input');
		return {
			...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
			...(scope.tenantId === null ? { tenantId: { $exists: false } } : { tenantId: scope.tenantId! }),
			...(scope.parentId ? { parentId: scope.parentId } : {}),
			deleted: false,
			...(id !== undefined ? { _id: id } : {})
		};
	};
	return {
		modules,
		async run<T>(scope: RecipeScope, work: (transaction: RelationshipTransaction) => Promise<T>): Promise<T> {
			assertRelationshipScope(scope);
			const fenceId = createHash('sha256')
				.update(JSON.stringify(scope.tenantId === null ? ['personal', scope.ownerId] : ['tenant', scope.tenantId]))
				.digest('hex');
			// Initialize before the transaction. The unique _id protects concurrent first use;
			// only a numeric fence is written here, never any business record or relationship.
			try {
				await fences.updateOne({ _id: fenceId }, { $setOnInsert: { epoch: 0 } }, { upsert: true });
			} catch (error) {
				if ((error as { code?: number }).code !== 11000) throw error;
			}
			const session = options.startSession();
			let completed = false,
				result: T;
			try {
				await session.withTransaction(
					async () => {
						completed = false;
						const locked = await fences.updateOne({ _id: fenceId }, { $inc: { epoch: 1 } }, { session });
						if (locked.matchedCount !== 1) throw new OperationError('conflict');
						// Recheck that callback operations cannot escape the fence's tenant/personal owner.
						const scoped = (candidate: RecipeScope) => {
							assertRelationshipScope(candidate);
							if (candidate.tenantId !== scope.tenantId || (scope.ownerId && candidate.ownerId !== scope.ownerId))
								throw new OperationError('forbidden');
							return candidate;
						};
						const tx: RelationshipTransaction = {
							find: async (module, candidate, id) =>
								collectionFor(module).findOne(selector(scoped(candidate), id), { session }),
							references: async (module, candidate, field, targetId, limit) => {
								const declaration = modules
									.find((item) => item.definition.name === module)
									?.relationships.outgoing.find((link) => link.field === field);
								if (
									!declaration ||
									!Number.isSafeInteger(limit) ||
									limit < 1 ||
									limit > 101 ||
									typeof targetId !== 'string' ||
									!/^[A-Za-z0-9_-]{1,128}$/.test(targetId)
								)
									throw new OperationError('invalid-input');
								const query = {
									...selector(scoped(candidate)),
									[field === 'parentId' ? 'parentId' : `data.${field}`]: targetId
								};
								return collectionFor(module).find(query, { session }).sort({ _id: 1 }).limit(limit).toArray();
							},
							insert: async (module, record) => {
								const recordScope = scoped({ ownerId: record.ownerId, tenantId: record.tenantId ?? null });
								const collection = collectionFor(module),
									existing = await collection.findOne({ _id: record._id }, { session });
								if (existing) {
									if (!relationshipScopeMatches(recordScope, existing)) throw new OperationError('conflict');
									return existing;
								}
								await collection.insertOne(record, { session });
								return record;
							},
							compareAndSet: async (module, candidate, id, version, next) => {
								if (
									!Number.isSafeInteger(version) ||
									version < 1 ||
									version >= Number.MAX_SAFE_INTEGER - 1 ||
									next.version !== version + 1
								)
									throw new OperationError('conflict');
								return (
									(
										await collectionFor(module).updateOne(
											{ ...selector(scoped(candidate), id), version },
											{ $set: next },
											{ session }
										)
									).modifiedCount === 1
								);
							},
							remove: async (module, candidate, id, version) => {
								if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER - 1)
									throw new OperationError('conflict');
								return (
									(
										await collectionFor(module).updateOne(
											{ ...selector(scoped(candidate), id), version },
											{ $set: { deleted: true, data: {}, version: version + 1 } },
											{ session }
										)
									).modifiedCount === 1
								);
							}
						};
						result = await work(tx);
						completed = true;
					},
					{
						readConcern: { level: 'snapshot' },
						writeConcern: { w: 'majority' },
						readPreference: 'primary',
						maxCommitTimeMS: 10000
					}
				);
				if (!completed) throw new Error('relationships: transaction did not complete');
				return result!;
			} finally {
				await session.endSession();
			}
		}
	};
}

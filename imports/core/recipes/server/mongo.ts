import { Mongo } from 'meteor/mongo';
import type { RecipeRecord, RecipeRepository, RecipeScope } from './engine';
/** Only this server adapter builds database selectors. DTOs never supply operators. */
export function mongoRecipeRepository(name: string): RecipeRepository {
	if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) throw new Error('Invalid collection name');
	const collection = new Mongo.Collection<RecipeRecord>(name);
	const selector = (scope: RecipeScope, id?: string) => {
		const { tenantId, ...rest } = scope;
		return {
			...rest,
			...(tenantId === null ? { tenantId: { $exists: false } } : tenantId !== undefined ? { tenantId } : {}),
			deleted: false,
			...(id ? { _id: id } : {})
		};
	};
	return {
		observeChanges: async (invalidate) => collection.find({}, { fields: { _id: 1, version: 1 } }).observeChanges({ added: invalidate, changed: invalidate, removed: invalidate }),
		find: async (scope, id) => (await collection.findOneAsync(selector(scope, id))) ?? null,
		list: async (scope, filters, limit) => {
			const filter = Object.fromEntries(Object.entries(filters).map(([key, value]) => [`data.${key}`, value]));
			return collection.find({ ...selector(scope), ...filter }, { limit, sort: { _id: 1 } }).fetchAsync();
		},
		insert: async (record) => {
			try {
				await collection.insertAsync(record);
				return record;
			} catch (error) {
				if ((error as { code?: number }).code !== 11000) throw error;
				const existing = await collection.findOneAsync(record._id);
				if (!existing) throw error;
				return existing;
			}
		},
		compareAndSet: async (scope, id, version, next) =>
			(await collection.updateAsync({ ...selector(scope, id), version }, { $set: next })) === 1,
		remove: async (scope, id, version) =>
			(await collection.updateAsync(
				{ ...selector(scope, id), version },
				{ $set: { deleted: true, data: {}, version: version + 1 } }
			)) === 1
	};
}

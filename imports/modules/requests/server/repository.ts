import { Mongo } from 'meteor/mongo';
import type { RequestRecord, RequestRepository } from './service';
export const RequestsCollection = new Mongo.Collection<RequestRecord>('ai_requests');
RequestsCollection.deny({ insert: () => true, update: () => true, remove: () => true });
const scope = (userId: string) => ({ $or: [{ ownerId: userId }, { reviewerId: userId }] });
export const requestRepository: RequestRepository = {
	async insert(row) {
		try {
			await RequestsCollection.insertAsync(row);
			return row;
		} catch (error) {
			if ((error as { code?: number }).code !== 11000) throw error;
			const stored = await RequestsCollection.findOneAsync({ _id: row._id, ownerId: row.ownerId });
			if (!stored) throw error;
			return stored;
		}
	},
	async get(userId, id) {
		return (await RequestsCollection.findOneAsync({ _id: id, ...scope(userId) })) ?? null;
	},
	async list(userId, limit) {
		return RequestsCollection.find(scope(userId), { sort: { _id: 1 }, limit }).fetchAsync();
	},
	async compareAndSet(userId, id, version, next) {
		return (await RequestsCollection.updateAsync({ _id: id, version, ...scope(userId) }, { $set: next })) === 1;
	}
};
export async function ensureRequestIndexes() {
	await RequestsCollection.createIndexAsync({ ownerId: 1, _id: 1 });
	await RequestsCollection.createIndexAsync({ reviewerId: 1, _id: 1 });
}

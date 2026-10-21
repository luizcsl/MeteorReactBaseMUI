import { Mongo } from 'meteor/mongo';
import { scopeSelector, type Scope } from '../../../core/server/policy';
export interface TaskRecord { _id: string; ownerId: string; tenantId: string | null; title: string; status: 'open' | 'done'; version: number; createdAt: number; updatedAt: number; mutationId: string; creationTitle: string; deletedAt: number | null }
export interface TaskRepository {
  insert(record: TaskRecord): Promise<TaskRecord>;
  get(scope: Scope, id: string): Promise<TaskRecord | null>;
  list(scope: Scope, after: string | null, limit: number): Promise<TaskRecord[]>;
  update(scope: Scope, id: string, version: number, patch: Pick<TaskRecord, 'title' | 'status' | 'updatedAt'>): Promise<boolean>;
  remove(scope: Scope, id: string, version: number): Promise<boolean>;
}
export const TasksCollection = new Mongo.Collection<TaskRecord>('ai_tasks');
TasksCollection.deny({ insert: () => true, update: () => true, remove: () => true });
export const taskRepository: TaskRepository = {
  async insert(record) {
    try { await TasksCollection.insertAsync(record); return record; }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // The deterministic primary key provides uniqueness without an index startup race.
      const existing = await TasksCollection.findOneAsync({ _id: record._id, ownerId: record.ownerId, tenantId: null });
      if (!existing) throw error;
      return existing;
    }
  },
  async get(scope, id) { return await TasksCollection.findOneAsync({ _id: id, deletedAt: null, ...scopeSelector(scope) }) ?? null; },
  async list(scope, after, limit) {
    return TasksCollection.find({ ...scopeSelector(scope), deletedAt: null, ...(after === null ? {} : { _id: { $gt: after } }) }, { sort: { _id: 1 }, limit }).fetchAsync();
  },
  async update(scope, id, version, patch) {
    // Scope + version in the atomic write, not a read-then-write check.
    return await TasksCollection.updateAsync({ _id: id, version, deletedAt: null, ...scopeSelector(scope) }, { $set: patch, $inc: { version: 1 } }) === 1;
  },
  async remove(scope, id, version) { return await TasksCollection.updateAsync({ _id: id, version, deletedAt: null, ...scopeSelector(scope) }, { $set: { deletedAt: Date.now() }, $inc: { version: 1 } }) === 1; }
};
export async function ensureTaskIndexes(): Promise<void> {
  await TasksCollection.createIndexAsync({ ownerId: 1, tenantId: 1, _id: 1 });
}

import { createHash } from 'node:crypto';
import { OperationError, type Operation, type TrustedContext } from '../../../core/server/operations';
import { ownerScope } from '../../../core/server/policy';
import { taskCreate, taskDelete, taskDeleted, taskDto, taskGet, taskList, taskPage, taskUpdate, TASKS_METHODS } from '../contracts';
import { normalizeTaskTitle, projectTask } from '../domain/task';
import type { TaskRepository } from './repository';
import type { Infer } from '../../../core/contracts/schema';
const authenticatedOwner = async (ctx: TrustedContext) => { ownerScope(ctx); };
export function createTaskOperations(repository: TaskRepository, now = Date.now) {
  const create: Operation<Infer<typeof taskCreate>, Infer<typeof taskDto>> = {
    name: TASKS_METHODS.create, input: taskCreate, output: taskDto, effect: 'write', policy: authenticatedOwner,
    async handler(ctx, input) {
      const timestamp = now();
      const title = normalizeTaskTitle(input.title);
      const id = createHash('sha256').update(JSON.stringify([ctx.userId, input.mutationId])).digest('hex');
      const record = { _id: id, ownerId: ctx.userId, tenantId: null, mutationId: input.mutationId, creationTitle: title, deletedAt: null, title, status: 'open' as const, version: 1, createdAt: timestamp, updatedAt: timestamp };
      const stored = await repository.insert(record);
      if (stored.ownerId !== ctx.userId || stored.tenantId !== null || stored.mutationId !== input.mutationId || stored.creationTitle !== title) throw new OperationError('conflict');
      if (stored.deletedAt !== null) throw new OperationError('not-found');
      return projectTask(stored);
    }
  };
  const get: Operation<Infer<typeof taskGet>, Infer<typeof taskDto>> = {
    name: TASKS_METHODS.get, input: taskGet, output: taskDto, effect: 'read', policy: authenticatedOwner,
    async handler(ctx, input) { const record = await repository.get(ownerScope(ctx), input.id); if (!record) throw new OperationError('not-found'); return projectTask(record); }
  };
  const list: Operation<Infer<typeof taskList>, Infer<typeof taskPage>> = {
    name: TASKS_METHODS.list, input: taskList, output: taskPage, effect: 'read', policy: authenticatedOwner,
    async handler(ctx, input) {
      const rows = await repository.list(ownerScope(ctx), input.after, input.limit + 1);
      const items = rows.slice(0, input.limit).map(projectTask);
      return { items, next: rows.length > input.limit ? items[items.length - 1].id : null };
    }
  };
  const update: Operation<Infer<typeof taskUpdate>, Infer<typeof taskDto>> = {
    name: TASKS_METHODS.update, input: taskUpdate, output: taskDto, effect: 'write', policy: authenticatedOwner,
    async handler(ctx, input) {
      const scope = ownerScope(ctx);
      if (!await repository.update(scope, input.id, input.version, { title: normalizeTaskTitle(input.title), status: input.status, updatedAt: now() })) throw new OperationError('conflict');
      const record = await repository.get(scope, input.id);
      if (!record) throw new OperationError('not-found'); return projectTask(record);
    }
  };
  const remove: Operation<Infer<typeof taskDelete>, Infer<typeof taskDeleted>> = {
    name: TASKS_METHODS.remove, input: taskDelete, output: taskDeleted, effect: 'write', policy: authenticatedOwner,
    async handler(ctx, input) { if (!await repository.remove(ownerScope(ctx), input.id, input.version)) throw new OperationError('conflict'); return { deleted: true }; }
  };
  return { create, get, list, update, remove };
}

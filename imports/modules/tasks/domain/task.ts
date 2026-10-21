import type { TaskDto } from '../contracts';
import { OperationError } from '../../../core/contracts/errors';
export function normalizeTaskTitle(title: string): string {
  const result = title.trim();
  if (!result) throw new OperationError('invalid-input');
  return result;
}
/** Explicit allowlist projection: never spread a persistence document into a response. */
export function projectTask(task: { _id: string; title: string; status: 'open' | 'done'; version: number; createdAt: number; updatedAt: number }): TaskDto {
  return { id: task._id, title: task.title, status: task.status, version: task.version, createdAt: task.createdAt, updatedAt: task.updatedAt };
}

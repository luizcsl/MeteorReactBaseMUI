import { Meteor } from 'meteor/meteor';
import { registerOperation } from '../../../core/server/meteor';
import type { ContextBuilder } from '../../../core/server/operations';
import { createTaskOperations } from './operations';
import { ensureTaskIndexes, taskRepository } from './repository';
let registered = false;
export function registerTasks(taskContext: ContextBuilder): void {
  if (registered) return;
  const operations = createTaskOperations(taskRepository);
  registerOperation(operations.create, taskContext);
  registerOperation(operations.get, taskContext);
  registerOperation(operations.list, taskContext);
  registerOperation(operations.update, taskContext);
  registerOperation(operations.remove, taskContext);
  registered = true;
  Meteor.startup(ensureTaskIndexes);
}

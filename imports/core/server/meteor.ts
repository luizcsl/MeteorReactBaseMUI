import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { operationHandler, OperationError, type Operation, type ContextBuilder } from './operations';
/** No client stubs: writes and authorization execute only on the server. */
export function registerOperation<I, O>(operation: Operation<I, O>, buildContext: ContextBuilder): void {
  if (!Meteor.isServer) throw new Error('Server registration imported on client');
  const invoke = operationHandler(operation, buildContext);
  Meteor.methods({ [operation.name]: async function(...args: unknown[]) {
    try { return await invoke.apply(this, args); } catch (error) {
      if (error instanceof OperationError) throw new Meteor.Error(error.code, error.message);
      // Do not expose validation output, Mongo errors or internal implementation details.
      throw new Meteor.Error('internal-error', 'Operation failed');
    }
  } });
  DDPRateLimiter.addRule({ type: 'method', name: operation.name, connectionId: () => true }, 60, 60_000);
  DDPRateLimiter.addRule({ type: 'method', name: operation.name, userId: (value: string | null) => !!value }, 120, 60_000);
}

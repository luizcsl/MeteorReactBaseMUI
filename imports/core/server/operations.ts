import { ContractError, type Schema } from '../contracts/schema';
import { OperationError } from '../contracts/errors';
export { OperationError } from '../contracts/errors';
export interface TrustedContext { readonly userId: string; readonly requestId: string }
export interface Invocation { userId: string | null }
export interface Operation<I, O> {
  readonly name: string;
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly effect: 'read' | 'write';
  readonly policy: (ctx: TrustedContext, input: I) => Promise<void>;
  readonly handler: (ctx: TrustedContext, input: I) => Promise<O>;
}
/** Context builder must only consult server-side identity/status, never the DTO. */
export type ContextBuilder = (invocation: Invocation) => Promise<TrustedContext>;
export function operationHandler<I, O>(operation: Operation<I, O>, buildContext: ContextBuilder) {
  if (!operation.policy || !operation.input || !operation.output || !['read', 'write'].includes(operation.effect)) throw new Error('Incomplete operation contract');
  return async function(this: Invocation, ...args: unknown[]): Promise<O> {
    if (args.length !== 1) throw new OperationError('invalid-input');
    let input: I;
    try { input = operation.input.parse(args[0]); } catch (error) {
      if (error instanceof ContractError) throw new OperationError('invalid-input'); throw error;
    }
    const ctx = Object.freeze(await buildContext({ userId: this.userId }));
    if (!ctx.userId || ctx.userId !== this.userId) throw new OperationError('unauthenticated');
    await operation.policy(ctx, input);
    // Output validation deliberately fails closed; handlers must project before returning.
    return operation.output.parse(await operation.handler(ctx, input));
  };
}

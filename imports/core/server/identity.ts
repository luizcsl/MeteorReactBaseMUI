import { OperationError, type ContextBuilder } from './operations';
/** The composition root supplies SERVER lookups. Email matching is not identity proof.
 * Use verified account IDs (including explicitly linked IDs) to find active profiles.
 */
export function activeAccountContext(isActiveAccount: (accountId: string) => Promise<boolean>, requestId: () => string): ContextBuilder {
  return async ({ userId }) => {
    if (!userId) throw new OperationError('unauthenticated');
    if (!await isActiveAccount(userId)) throw new OperationError('forbidden');
    return { userId, requestId: requestId() };
  };
}

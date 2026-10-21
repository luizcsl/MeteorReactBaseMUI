/** Optional transaction port. The adapter must bind every repository to the SAME session.
 * Never implement this as a fallback that silently runs non-transactionally.
 * External side effects belong in a transactionally persisted outbox, not this callback.
 */
export interface TransactionRunner<Repositories> {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
export interface MongoSession {
  withTransaction<T>(work: () => Promise<T>): Promise<T | undefined>;
  endSession(): Promise<void>;
}
export function transactionRunner<R>(startSession: () => MongoSession, bind: (session: MongoSession) => R): TransactionRunner<R> {
  return { async run<T>(work: (repositories: R) => Promise<T>): Promise<T> {
    const session = startSession();
    try {
      let completed = false;
      let result: T;
      await session.withTransaction(async () => { result = await work(bind(session)); completed = true; return result; });
      if (!completed) throw new Error('Transaction did not complete');
      return result!;
    } finally { await session.endSession(); }
  } };
}

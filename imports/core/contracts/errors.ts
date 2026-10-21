export class OperationError extends Error {
  readonly code: 'unauthenticated' | 'forbidden' | 'not-found' | 'conflict' | 'invalid-input';
  constructor(code: OperationError['code'], message: string = code) { super(message); this.code = code; }
}

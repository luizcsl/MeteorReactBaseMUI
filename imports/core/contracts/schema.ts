/** Small, dependency-free runtime contract vocabulary. No coercion or unknown fields. */
export class ContractError extends Error {
  readonly code = 'invalid-input';
  constructor(message = 'Input does not match the contract') { super(message); }
}
export interface Schema<T> { parse(value: unknown): T }
export type Infer<S> = S extends Schema<infer T> ? T : never;
export const string = (min = 1, max = 200): Schema<string> => ({ parse(value) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new ContractError('Invalid string length');
  return value;
} });
export const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Schema<number> => ({ parse(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ContractError('Invalid integer');
  return value;
} });
export const literal = <T extends string | boolean | null>(expected: T): Schema<T> => ({ parse(value) {
  if (value !== expected) throw new ContractError('Invalid literal'); return expected;
} });
export const enumeration = <T extends string>(values: readonly T[]): Schema<T> => ({ parse(value) {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ContractError('Invalid enum value'); return value as T;
} });
export const nullable = <T>(schema: Schema<T>): Schema<T | null> => ({ parse: value => value === null ? null : schema.parse(value) });
export const array = <T>(schema: Schema<T>, max = 100): Schema<T[]> => ({ parse(value) {
  if (!Array.isArray(value) || value.length > max) throw new ContractError('Invalid array'); return Array.from(value, item => schema.parse(item));
} });
export const strictObject = <S extends Record<string, Schema<unknown>>>(shape: S): Schema<{ [K in keyof S]: Infer<S[K]> }> => ({ parse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ContractError('Expected plain object');
  const input = value as Record<string, unknown>;
  if (Reflect.ownKeys(input).length !== Object.keys(shape).length || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(shape, key))) throw new ContractError('Unknown or missing fields');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) throw new ContractError('Missing field');
    result[key] = shape[key].parse(input[key]);
  }
  return result as { [K in keyof S]: Infer<S[K]> };
} });
export const id = string(1, 128);

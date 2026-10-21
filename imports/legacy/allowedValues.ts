import type { ISchema } from '../typings/ISchema';
/** Values are a domain constraint. UI options may label them but never grant authority. */
export type AllowedValue = string | number | boolean;
export class LegacyValueError extends Error {
	constructor(
		readonly field: string,
		readonly rule: 'invalid-value' | 'required' | 'configuration' | 'ignored-constraint'
	) {
		super(`${rule}: ${field}`);
	}
}
function dense(value: unknown): value is unknown[] {
	return (
		Array.isArray(value) &&
		Object.getPrototypeOf(value) === Array.prototype &&
		Reflect.ownKeys(value).length === value.length + 1 &&
		Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(
			(d) => d?.enumerable && Object.hasOwn(d, 'value')
		)
	);
}
/** Runs on RAW input, before legacy coercion/dropping, including fields excluded from Match. */
export function assertAllowedValues(
	schema: ISchema<any>,
	document: Record<string, unknown>,
	ignored: readonly string[] = [],
	prefix = '',
	depth = 0
): void {
	if (depth > 8) throw new LegacyValueError(prefix, 'configuration');
	for (const [name, field] of Object.entries(schema)) {
		const path = prefix + name,
			present = Object.hasOwn(document, name),
			value = document[name];
		if (field.allowedValues !== undefined) {
			const allowed = field.allowedValues;
			const array = field.type === Array || Array.isArray(field.type);
			const scalar = Array.isArray(field.type) ? field.type[0] : field.type;
			const expected =
				scalar === String
					? 'string'
					: scalar === Number
						? 'number'
						: scalar === Boolean
							? 'boolean'
							: scalar === Array
								? undefined
								: 'unsupported';
			if (
				!dense(allowed) ||
				!allowed.length ||
				allowed.length > 100 ||
				new Set(allowed).size !== allowed.length ||
				expected === 'unsupported' ||
				(Array.isArray(field.type) && field.type.length !== 1) ||
				allowed.some(
					(v) =>
						!['string', 'number', 'boolean'].includes(typeof v) ||
						(typeof v === 'number' && !Number.isFinite(v)) ||
						(expected !== undefined && typeof v !== expected)
				)
			)
				throw new LegacyValueError(path, 'configuration');
			if (ignored.includes(name)) throw new LegacyValueError(path, 'ignored-constraint');
			const visible = !field.visibilityFunction || field.visibilityFunction(document);
			if (!present || value === undefined || value === null || value === '') {
				if (!field.optional && visible) throw new LegacyValueError(path, 'required');
				// Optional clears are explicit; hidden supplied values still cannot bypass membership below.
				if (field.optional || !present || value === undefined) continue;
			}
			if (array) {
				if (
					!dense(value) ||
					(!field.optional && visible && !value.length) ||
					value.some((v) => !allowed.includes(v as AllowedValue))
				)
					throw new LegacyValueError(path, 'invalid-value');
			} else if (!allowed.includes(value as AllowedValue)) throw new LegacyValueError(path, 'invalid-value');
		}
		if (field.subSchema && present && value !== null && value !== undefined) {
			if (Array.isArray(value))
				for (const [index, item] of value.entries()) {
					if (!item || typeof item !== 'object' || Array.isArray(item))
						throw new LegacyValueError(path + '.' + index, 'invalid-value');
					assertAllowedValues(
						field.subSchema,
						item as Record<string, unknown>,
						ignored.includes(name) ? Object.keys(field.subSchema) : [],
						`${path}.${index}.`,
						depth + 1
					);
				}
			else if (typeof value === 'object')
				assertAllowedValues(
					field.subSchema,
					value as Record<string, unknown>,
					ignored.includes(name) ? Object.keys(field.subSchema) : [],
					path + '.',
					depth + 1
				);
		}
	}
}

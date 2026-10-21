import type { ISchema } from '../typings/ISchema';
/** Explicit inclusion list; never derive public fields from all schema keys. */
export function legacyProjection(fields: readonly string[]): Record<string, 1> {
	if (
		!fields.length ||
		new Set(fields).size !== fields.length ||
		fields.some((field) => !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(field))
	)
		throw new Error('Invalid explicit legacy projection');
	return Object.fromEntries(fields.map((field) => [field, 1]));
}
export function pickLegacySchema<T extends ISchema<any>>(schema: T, fields: readonly string[]): ISchema<any> {
	legacyProjection(fields);
	const output: ISchema<any> = {};
	for (const field of fields) {
		if (!Object.hasOwn(schema, field)) throw new Error(`Missing reduced-schema field: ${field}`);
		output[field] = schema[field];
	}
	return output;
}

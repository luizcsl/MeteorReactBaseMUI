import { ContractError } from '../contracts/schema';
export type RecipeProfile = 'owner' | 'team' | 'master-detail' | 'approval';
export type Access = 'owner' | 'member' | 'reviewer';
export interface RecipeField {
	name: string;
	label: string;
	type: 'string' | 'integer' | 'boolean' | 'enum';
	required: boolean;
	maxLength?: number;
	min?: number;
	max?: number;
	values?: string[];
}
export interface RecipeDefinition {
	schemaVersion: 1;
	name: string;
	profile: RecipeProfile;
	fields: RecipeField[];
	filters: string[];
	states: string[];
	transitions: { from: string; to: string; roles: string[] }[];
	permissions: { read: Access[]; write: Access[] };
}
export type RecipeData = Record<string, string | number | boolean | null>;
const bad = (message: string): never => {
	throw new ContractError(message);
};
const exact = (value: unknown, keys: string[], required = keys): Record<string, unknown> => {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		return bad('Expected plain object');
	const object = value as Record<string, unknown>;
	if (
		Reflect.ownKeys(object).some((k) => {
			const descriptor = Object.getOwnPropertyDescriptor(object, k)!;
			return (
				typeof k !== 'string' || !keys.includes(k) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
			);
		}) ||
		required.some((k) => !Object.hasOwn(object, k))
	)
		return bad('Unknown or missing fields');
	return object;
};
const identifier = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[a-z][A-Za-z0-9]{0,39}$/.test(value) &&
	![
		'constructor',
		'prototype',
		'__proto__',
		'ownerId',
		'tenantId',
		'userId',
		'version',
		'state',
		'roles',
		'password',
		'token'
	].includes(value);
export const isPlainDenseArray = (value: unknown, max: number): value is unknown[] =>
	Array.isArray(value) &&
	Object.getPrototypeOf(value) === Array.prototype &&
	value.length <= max &&
	Reflect.ownKeys(value).length === value.length + 1 &&
	Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(
		(descriptor) => !!descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
	);
const strings = (value: unknown, max: number): value is string[] =>
	isPlainDenseArray(value, max) &&
	value.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 80) &&
	new Set(value).size === value.length;
export function validateDefinition(value: unknown): RecipeDefinition {
	const d = exact(value, [
		'schemaVersion',
		'name',
		'profile',
		'fields',
		'filters',
		'states',
		'transitions',
		'permissions'
	]);
	if (
		d.schemaVersion !== 1 ||
		!identifier(d.name) ||
		!/^[a-z][a-z0-9]{2,31}$/.test(d.name) ||
		typeof d.profile !== 'string' ||
		!['owner', 'team', 'master-detail', 'approval'].includes(d.profile)
	)
		return bad('Unsupported recipe');
	if (!isPlainDenseArray(d.fields, 30) || d.fields.length < 1) return bad('Expected 1–30 fields');
	const names = new Set<string>();
	for (const raw of d.fields) {
		const f = exact(
			raw,
			['name', 'label', 'type', 'required', 'maxLength', 'min', 'max', 'values'],
			['name', 'label', 'type', 'required']
		);
		if (
			!identifier(f.name) ||
			names.has(f.name) ||
			typeof f.label !== 'string' ||
			!f.label.length ||
			f.label.length > 100 ||
			typeof f.required !== 'boolean'
		)
			return bad('Invalid field');
		names.add(f.name);
		if (f.type === 'string') {
			if (
				!Number.isSafeInteger(f.maxLength) ||
				Number(f.maxLength) < 1 ||
				Number(f.maxLength) > 2000 ||
				Object.hasOwn(f, 'min') ||
				Object.hasOwn(f, 'max') ||
				Object.hasOwn(f, 'values')
			)
				return bad('String requires bounded maxLength');
		} else if (f.type === 'integer') {
			if (
				!Number.isSafeInteger(f.min) ||
				!Number.isSafeInteger(f.max) ||
				Number(f.min) > Number(f.max) ||
				Object.hasOwn(f, 'maxLength') ||
				Object.hasOwn(f, 'values')
			)
				return bad('Integer requires bounds');
		} else if (f.type === 'enum') {
			if (
				!strings(f.values, 30) ||
				f.values.length < 1 ||
				Object.hasOwn(f, 'min') ||
				Object.hasOwn(f, 'max') ||
				Object.hasOwn(f, 'maxLength')
			)
				return bad('Enum requires values');
		} else if (f.type === 'boolean') {
			if (['min', 'max', 'maxLength', 'values'].some((k) => Object.hasOwn(f, k)))
				return bad('Boolean options unsupported');
		} else return bad('Unsupported field type');
	}
	if (
		!strings(d.filters, 10) ||
		d.filters.some((f) => !names.has(f)) ||
		!strings(d.states, 20) ||
		!d.states.length ||
		d.states.some((s) => !identifier(s))
	)
		return bad('Invalid filters/states');
	if (!isPlainDenseArray(d.transitions, 40)) return bad('Too many transitions');
	const transitions = new Set<string>();
	for (const raw of d.transitions) {
		const t = exact(raw, ['from', 'to', 'roles']);
		if (
			typeof t.from !== 'string' ||
			typeof t.to !== 'string' ||
			!(d.states as string[]).includes(t.from) ||
			!(d.states as string[]).includes(t.to) ||
			t.from === t.to ||
			!strings(t.roles, 10) ||
			!t.roles.length ||
			t.roles.some((r) => !['owner', 'member', 'reviewer'].includes(r)) ||
			transitions.has(`${t.from}:${t.to}`)
		)
			return bad('Invalid transition');
		transitions.add(`${t.from}:${t.to}`);
	}
	const p = exact(d.permissions, ['read', 'write']);
	for (const key of ['read', 'write'])
		if (
			!strings(p[key], 3) ||
			!(p[key] as string[]).length ||
			(p[key] as string[]).some((r) => !['owner', 'member', 'reviewer'].includes(r))
		)
			return bad('Invalid permissions');
	if (d.profile === 'owner' || d.profile === 'master-detail') {
		if (
			(p.read as string[]).some((r) => r !== 'owner') ||
			(p.write as string[]).some((r) => r !== 'owner') ||
			(d.transitions as { roles: string[] }[]).some((t) => t.roles.some((r) => r !== 'owner'))
		)
			return bad('Owner profile cannot grant team access');
	}
	// A detached JSON copy prevents later mutation of the accepted input object.
	return JSON.parse(JSON.stringify(d)) as RecipeDefinition;
}
export function parseRecipeData(definition: RecipeDefinition, value: unknown): RecipeData {
	const d = validateDefinition(definition);
	const input = exact(
		value,
		d.fields.map((f) => f.name)
	);
	const output: RecipeData = {};
	for (const f of d.fields) {
		const value = input[f.name];
		if (value === null && !f.required) {
			output[f.name] = null;
			continue;
		}
		if (
			f.type === 'string' &&
			typeof value === 'string' &&
			value.length <= f.maxLength! &&
			(!f.required || value.trim().length > 0)
		)
			output[f.name] = value;
		else if (
			f.type === 'integer' &&
			typeof value === 'number' &&
			Number.isSafeInteger(value) &&
			value >= f.min! &&
			value <= f.max!
		)
			output[f.name] = value;
		else if (f.type === 'boolean' && typeof value === 'boolean') output[f.name] = value;
		else if (f.type === 'enum' && typeof value === 'string' && f.values!.includes(value)) output[f.name] = value;
		else bad(`Invalid field: ${f.name}`);
	}
	return output;
}
export function parseRecipeFilters(definition: RecipeDefinition, value: unknown): RecipeData {
	const input = exact(value, definition.filters, []);
	const result: RecipeData = {};
	for (const name of Object.keys(input)) {
		const field = definition.fields.find((f) => f.name === name)!;
		const one = {
			...definition,
			fields: [field],
			filters: [],
			transitions: [],
			permissions: { read: ['owner'], write: ['owner'] },
			profile: 'owner'
		} as RecipeDefinition;
		result[name] = parseRecipeData(one, { [name]: input[name] })[name];
	}
	return result;
}
export const initialRecipeData = (d: RecipeDefinition): RecipeData =>
	Object.fromEntries(
		validateDefinition(d).fields.map((f) => [
			f.name,
			!f.required
				? null
				: f.type === 'boolean'
					? false
					: f.type === 'integer'
						? f.min!
						: f.type === 'enum'
							? f.values![0]
							: ''
		])
	);

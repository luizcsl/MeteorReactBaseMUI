import { ContractError } from '../contracts/schema';
export type RecipeProfile = 'owner' | 'team' | 'master-detail' | 'approval';
export type Access = 'owner' | 'member' | 'reviewer';
export interface RecipeField {
	name: string;
	label: string;
	type: 'string' | 'integer' | 'boolean' | 'enum' | 'date' | 'money' | 'reference';
	required: boolean;
	maxLength?: number;
	min?: number;
	max?: number;
	values?: string[];
	currency?: string;
	scale?: number;
	target?: string;
}
export interface RecipeDefinition {
	schemaVersion: 1;
	name: string;
	profile: RecipeProfile;
	fields: RecipeField[];
	rules?: { kind: 'lte'; left: string; right: string }[];
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
	const d = exact(
		value,
		['schemaVersion', 'name', 'profile', 'fields', 'filters', 'states', 'transitions', 'permissions', 'rules'],
		['schemaVersion', 'name', 'profile', 'fields', 'filters', 'states', 'transitions', 'permissions']
	);
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
			['name', 'label', 'type', 'required', 'maxLength', 'min', 'max', 'values', 'currency', 'scale', 'target'],
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
		const allowedOptions: Record<string, string[]> = {
			string: ['maxLength'],
			integer: ['min', 'max'],
			boolean: [],
			enum: ['values'],
			date: [],
			money: ['min', 'max', 'currency', 'scale'],
			reference: ['target']
		};
		if (
			typeof f.type !== 'string' ||
			!Object.hasOwn(allowedOptions, f.type) ||
			['maxLength', 'min', 'max', 'values', 'currency', 'scale', 'target'].some(
				(k) => Object.hasOwn(f, k) && !allowedOptions[f.type as string].includes(k)
			)
		)
			return bad(`Invalid options for field: ${f.name}`);
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
		} else if (f.type === 'integer' || f.type === 'money') {
			if (
				f.type === 'money' &&
				(typeof f.currency !== 'string' ||
					!/^[A-Z]{3}$/.test(f.currency) ||
					!Number.isSafeInteger(f.scale) ||
					Number(f.scale) < 0 ||
					Number(f.scale) > 4)
			)
				return bad(`Invalid money metadata: ${f.name}`);
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
		} else if (f.type === 'reference') {
			if (typeof f.target !== 'string' || !/^[a-z][a-z0-9]{2,31}$/.test(f.target))
				return bad(`Invalid reference target: ${f.name}`);
		} else if (f.type !== 'date') return bad('Unsupported field type');
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
	if (d.rules !== undefined) {
		if (!isPlainDenseArray(d.rules, 20)) return bad('Expected at most 20 rules');
		const seen = new Set<string>();
		for (const raw of d.rules) {
			const rule = exact(raw, ['kind', 'left', 'right']);
			const left = (d.fields as RecipeField[]).find((f) => f.name === rule.left);
			const right = (d.fields as RecipeField[]).find((f) => f.name === rule.right);
			const key = `${rule.left}:${rule.right}`;
			if (
				rule.kind !== 'lte' ||
				!left ||
				!right ||
				left === right ||
				left.type !== right.type ||
				!['integer', 'money', 'date'].includes(left.type) ||
				(left.type === 'money' && (left.currency !== right.currency || left.scale !== right.scale)) ||
				seen.has(key)
			)
				return bad('Invalid cross-field rule');
			seen.add(key);
		}
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
			(f.type === 'integer' || f.type === 'money') &&
			typeof value === 'number' &&
			Number.isSafeInteger(value) &&
			value >= f.min! &&
			value <= f.max!
		)
			output[f.name] = value;
		else if (f.type === 'date' && isRecipeDate(value)) output[f.name] = value;
		else if (f.type === 'reference' && typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))
			output[f.name] = value;
		else if (f.type === 'boolean' && typeof value === 'boolean') output[f.name] = value;
		else if (f.type === 'enum' && typeof value === 'string' && f.values!.includes(value)) output[f.name] = value;
		else bad(`Invalid field: ${f.name}`);
	}
	for (const rule of d.rules ?? []) {
		const left = output[rule.left],
			right = output[rule.right];
		if (left !== null && right !== null && left > right) bad(`Rule failed: ${rule.left} <= ${rule.right}`);
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
			rules: [],
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
					: f.type === 'integer' || f.type === 'money'
						? f.min!
						: f.type === 'enum'
							? f.values![0]
							: ''
		])
	);

/** Civil dates stay ISO strings across JSON/DDP/Mongo; no timezone conversion. */
export function isRecipeDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
	const date = new Date(value + 'T00:00:00.000Z');
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Convert decimal text to exact integer minor units, without floating point rounding. */
export function parseMoneyText(value: string, scale: number): number {
	if (
		!Number.isInteger(scale) ||
		scale < 0 ||
		scale > 4 ||
		value.length > 24 ||
		!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
	)
		return bad('Invalid money');
	const [whole, fraction = ''] = value.replace('-', '').split('.');
	if (fraction.length > scale) return bad('Too many decimal places');
	const amount = BigInt(whole + fraction.padEnd(scale, '0')) * (value.startsWith('-') ? -1n : 1n);
	const number = Number(amount);
	if (!Number.isSafeInteger(number)) return bad('Money outside safe integer range');
	return number;
}
export function formatMoney(value: number, scale: number): string {
	if (!Number.isSafeInteger(value) || !Number.isInteger(scale) || scale < 0 || scale > 4) return bad('Invalid money');
	const digits = BigInt(value < 0 ? -value : value)
		.toString()
		.padStart(scale + 1, '0');
	return (value < 0 ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}

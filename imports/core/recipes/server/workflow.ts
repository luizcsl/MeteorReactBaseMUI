import { OperationError } from '../../contracts/errors';
import { ContractError } from '../../contracts/schema';
import {
	isPlainDenseArray,
	isRecipeDate,
	parseRecipeData,
	validateDefinition,
	type RecipeData,
	type RecipeDefinition,
	type RecipeField
} from '../definition';
import type { RecipePorts, RecipeRecord } from './engine';

export interface WorkflowCondition {
	field: string;
	op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
	value: string | number | boolean | null;
}
export interface WorkflowDeadline {
	anchor: 'updatedAt';
	afterMs: number;
	mode: 'before' | 'after';
}
export interface WorkflowTransition {
	from: string;
	to: string;
	conditions?: WorkflowCondition[];
	deadline?: WorkflowDeadline;
}
export interface WorkflowConfig {
	transitions: WorkflowTransition[];
}
export interface WorkflowTransitionStatus {
	from: string;
	to: string;
	conditionsMet: boolean;
	allowed: boolean;
	blockedBy: 'conditions' | 'deadline' | null;
	deadline: { dueAt: string; due: boolean; mode: WorkflowDeadline['mode'] } | null;
}
type WorkflowRecord = Pick<RecipeRecord, 'state' | 'data'> & { updatedAt?: Date };
const fail = (message: string): never => {
	throw new ContractError(`workflow: ${message}`);
};
function object(value: unknown, keys: string[], required = keys): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		return fail('expected plain object');
	if (
		Reflect.ownKeys(value).some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			return (
				typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
			);
		}) ||
		required.some((key) => !Object.hasOwn(value, key))
	)
		return fail('unknown or missing property');
	return value as Record<string, unknown>;
}
function literal(field: RecipeField, value: unknown): boolean {
	if (value === null) return !field.required;
	switch (field.type) {
		case 'string':
			return (
				typeof value === 'string' && value.length <= field.maxLength! && (!field.required || value.trim().length > 0)
			);
		case 'integer':
		case 'money':
			return typeof value === 'number' && Number.isSafeInteger(value) && value >= field.min! && value <= field.max!;
		case 'boolean':
			return typeof value === 'boolean';
		case 'enum':
			return typeof value === 'string' && field.values!.includes(value);
		case 'date':
			return isRecipeDate(value);
		case 'reference':
			return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
	}
}
/** One bounded DSL validator is shared by generation and runtime. No expressions or implicit authority. */
export function validateWorkflowConfig(raw: unknown, definition: RecipeDefinition): WorkflowConfig {
	const d = validateDefinition(definition);
	const config = object(raw, ['transitions']);
	if (!isPlainDenseArray(config.transitions, 40) || config.transitions.length < 1)
		return fail('expected 1..40 transition rules');
	const fields = new Map(d.fields.map((field) => [field.name, field]));
	const seen = new Set<string>();
	for (const rawRule of config.transitions) {
		const rule = object(rawRule, ['from', 'to', 'conditions', 'deadline'], ['from', 'to']);
		if (!d.transitions.some((transition) => transition.from === rule.from && transition.to === rule.to))
			return fail('rule must select an existing transition');
		const key = `${rule.from}:${rule.to}`;
		if (seen.has(key)) return fail('duplicate transition rule');
		seen.add(key);
		if (!Object.hasOwn(rule, 'conditions') && !Object.hasOwn(rule, 'deadline')) return fail('empty transition rule');
		if (Object.hasOwn(rule, 'conditions')) {
			if (!isPlainDenseArray(rule.conditions, 20) || rule.conditions.length < 1)
				return fail('expected 1..20 AND conditions');
			const conditions = new Set<string>();
			for (const rawCondition of rule.conditions) {
				const condition = object(rawCondition, ['field', 'op', 'value']);
				const field = typeof condition.field === 'string' ? fields.get(condition.field) : undefined;
				if (
					!field ||
					typeof condition.op !== 'string' ||
					!['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(condition.op)
				)
					return fail('unknown field or comparison');
				if (!literal(field, condition.value)) return fail('comparison literal does not match field');
				if (
					!['eq', 'ne'].includes(condition.op) &&
					(!['integer', 'money', 'date'].includes(field.type) || condition.value === null)
				)
					return fail('ordered comparisons require numeric or date values');
				const conditionKey = JSON.stringify([condition.field, condition.op, condition.value]);
				if (conditions.has(conditionKey)) return fail('duplicate condition');
				conditions.add(conditionKey);
			}
		}
		if (Object.hasOwn(rule, 'deadline')) {
			const deadline = object(rule.deadline, ['anchor', 'afterMs', 'mode']);
			if (
				deadline.anchor !== 'updatedAt' ||
				!Number.isSafeInteger(deadline.afterMs) ||
				Number(deadline.afterMs) < 1 ||
				Number(deadline.afterMs) > 31_536_000_000 ||
				!['before', 'after'].includes(deadline.mode as string)
			)
				return fail('deadline requires updatedAt, 1..31536000000 ms, and before/after mode');
		}
	}
	return JSON.parse(JSON.stringify(config)) as WorkflowConfig;
}
function matches(condition: WorkflowCondition, data: RecipeData): boolean {
	const left = data[condition.field],
		right = condition.value;
	if (condition.op === 'eq') return left === right;
	if (condition.op === 'ne') return left !== right;
	// Optional missing values never pass an ordered comparison; no JavaScript coercion.
	if (
		left === null ||
		right === null ||
		typeof left !== typeof right ||
		typeof left === 'boolean' ||
		typeof right === 'boolean'
	)
		return false;
	switch (condition.op) {
		case 'lt':
			return left < right;
		case 'lte':
			return left <= right;
		case 'gt':
			return left > right;
		case 'gte':
			return left >= right;
	}
}
function timestamp(value: unknown): number {
	if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length)
		throw new OperationError('conflict');
	const time = Date.prototype.getTime.call(value);
	if (!Number.isSafeInteger(time)) throw new OperationError('conflict');
	return time;
}
function snapshot(definition: RecipeDefinition, row: WorkflowRecord): RecipeData {
	if (!row || typeof row !== 'object' || !Object.hasOwn(row, 'state') || !Object.hasOwn(row, 'data'))
		throw new OperationError('conflict');
	for (const key of ['state', 'data', 'updatedAt']) {
		const descriptor = Object.getOwnPropertyDescriptor(row, key);
		if (descriptor && (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')))
			throw new OperationError('conflict');
	}
	if (!definition.states.includes(row.state)) throw new OperationError('conflict');
	try {
		return parseRecipeData(definition, row.data);
	} catch {
		throw new OperationError('conflict');
	}
}
function status(
	rule: WorkflowTransition | undefined,
	row: WorkflowRecord,
	data: RecipeData,
	to: string,
	now: Date
): WorkflowTransitionStatus {
	const conditionsMet = (rule?.conditions ?? []).every((condition) => matches(condition, data));
	let deadline: WorkflowTransitionStatus['deadline'] = null;
	let timeAllowed = true;
	if (rule?.deadline) {
		const anchor = timestamp(Object.getOwnPropertyDescriptor(row, 'updatedAt')?.value),
			current = timestamp(now),
			dueAt = anchor + rule.deadline.afterMs;
		if (current < anchor || !Number.isSafeInteger(dueAt) || !Number.isFinite(new Date(dueAt).getTime()))
			throw new OperationError('conflict');
		const due = current >= dueAt;
		deadline = { dueAt: new Date(dueAt).toISOString(), due, mode: rule.deadline.mode };
		timeAllowed = rule.deadline.mode === 'before' ? !due : due;
	}
	return {
		from: row.state,
		to,
		conditionsMet,
		allowed: conditionsMet && timeAllowed,
		blockedBy: !conditionsMet ? 'conditions' : !timeAllowed ? 'deadline' : null,
		deadline
	};
}
/** Pure read-only status for a previously authorized row. This is not an authorization API or scheduler. */
export function workflowStatus(
	definition: RecipeDefinition,
	config: WorkflowConfig,
	row: WorkflowRecord,
	now: Date
): WorkflowTransitionStatus[] {
	const d = validateDefinition(definition),
		workflow = validateWorkflowConfig(config, d),
		data = snapshot(d, row);
	return d.transitions
		.filter((transition) => transition.from === row.state)
		.map((transition) =>
			status(
				workflow.transitions.find((rule) => rule.from === row.state && rule.to === transition.to),
				row,
				data,
				transition.to,
				now
			)
		);
}
/** Enforced against the same trusted row/version used by the engine's compare-and-set. */
export function evaluateWorkflow(
	definition: RecipeDefinition,
	config: WorkflowConfig,
	row: WorkflowRecord,
	to: string,
	now: Date
): WorkflowTransitionStatus {
	const d = validateDefinition(definition),
		workflow = validateWorkflowConfig(config, d),
		data = snapshot(d, row);
	if (!d.transitions.some((transition) => transition.from === row.state && transition.to === to))
		throw new OperationError('conflict');
	const result = status(
		workflow.transitions.find((rule) => rule.from === row.state && rule.to === to),
		row,
		data,
		to,
		now
	);
	if (!result.conditionsMet) throw new OperationError('forbidden');
	if (!result.allowed) throw new OperationError('conflict');
	return result;
}
export function createWorkflowGuard(
	definition: RecipeDefinition,
	config: WorkflowConfig
): NonNullable<RecipePorts['beforeTransition']> {
	// Detach trusted configuration once: subsequent caller mutations cannot remove guards.
	const d = validateDefinition(definition),
		workflow = validateWorkflowConfig(config, d);
	return async ({ row, to, now }) => {
		evaluateWorkflow(d, workflow, row, to, now);
	};
}

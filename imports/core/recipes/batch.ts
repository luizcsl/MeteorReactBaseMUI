import { ContractError } from '../contracts/schema';
import { isPlainDenseArray, parseRecipeData, type RecipeDefinition, type RecipeData } from './definition';
/** Parse the entire bounded import before any caller performs writes. CSV formula text is not evaluated. */
export function prepareImport(definition: RecipeDefinition, rows: unknown): RecipeData[] {
	if (!isPlainDenseArray(rows, 100) || rows.length < 1)
		throw new ContractError('Import must contain 1–100 bounded rows');
	// Serialize only detached, validated values; never invoke caller-controlled toJSON hooks.
	const parsed = rows.map((row) => parseRecipeData(definition, row));
	if (JSON.stringify(parsed).length > 200000) throw new ContractError('Import payload is too large');
	return parsed;
}
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export function jobTransition(current: JobState, next: JobState): JobState {
	const allowed: Record<JobState, JobState[]> = {
		queued: ['running', 'cancelled'],
		running: ['succeeded', 'failed', 'cancelled'],
		succeeded: [],
		failed: [],
		cancelled: []
	};
	if (!allowed[current]?.includes(next)) throw new ContractError('Invalid job transition');
	return next;
}

import { ContractError, type Schema } from '../core/contracts/schema';
import {
	parseRecipeData,
	parseRecipeFilters,
	type RecipeData,
	type RecipeDefinition
} from '../core/recipes/definition';
export interface ServiceContractConfig {
	attachments?: { maxBytes: number; mimeTypes: readonly string[] };
	csv?: { maxRows: number };
	notifications?: { events: readonly string[] };
	search?: { fields: readonly string[]; pageSize: number };
	reports?: { metrics: readonly { name: string; op: string; field?: string }[] };
	audit?: { events: readonly string[] };
}
export interface SearchInput {
	filters: RecipeData;
	cursor: string | null;
	limit: number;
	order: 'asc' | 'desc';
}
export interface SearchRow {
	id: string;
	parentId: null;
	version: number;
	state: string;
	data: RecipeData;
}
export interface SearchOutput {
	items: SearchRow[];
	nextCursor: string | null;
}
export interface ReportInput {
	filters: RecipeData;
}
export interface HistoryInput {
	documentId: string;
}
export interface HistoryRow {
	actorId: string;
	event: string;
	at: string;
	changes: RecipeData;
}
export interface ImportInput {
	text: string;
	mutationPrefix: string;
}
export interface ImportOutput {
	completed: number;
	total: number;
	failedRow: number | null;
	error?: string;
}
export interface ExportInput {
	filters: RecipeData;
}
export interface UploadInput {
	documentId: string;
	bytes: Uint8Array;
	mimeType: string;
	name: string;
}
export interface UploadOutput {
	id: string;
}
export interface DownloadInput {
	documentId: string;
	fileId: string;
}
export interface NotifyInput {
	event: string;
	documentId: string;
	eventId: string;
}
export interface NotifyOutput {
	delivered: number;
}
const bad = (): never => {
	throw new ContractError('Invalid service contract');
};
function obj(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== 'object' ||
		Array.isArray(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		return bad();
	if (
		Reflect.ownKeys(raw).length !== keys.length ||
		Reflect.ownKeys(raw).some(
			(k) =>
				typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, k)!, 'value')
		)
	)
		return bad();
	return raw as Record<string, unknown>;
}
const text = (v: unknown, max: number): string =>
	typeof v === 'string' && v.length > 0 && v.length <= max ? v : bad();
const id = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : bad());
const int = (v: unknown, min: number, max: number): number =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad();
function dense(v: unknown, max: number): unknown[] {
	if (
		!Array.isArray(v) ||
		v.length > max ||
		Reflect.ownKeys(v).length !== v.length + 1 ||
		Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i))).some(
			(d) => !d || !Object.hasOwn(d, 'value')
		)
	)
		return bad();
	return v;
}
export function serviceSchemas(d: RecipeDefinition, config: ServiceContractConfig) {
	const filters = (v: unknown) => parseRecipeFilters(d, v);
	const cursor = (v: unknown) => (v === null ? null : text(v, 1024));
	const bytes = (v: unknown) => {
		if (!(v instanceof Uint8Array) || !v.byteLength || v.byteLength > (config.attachments?.maxBytes ?? 0)) return bad();
		return new Uint8Array(v);
	};
	const searchInput: Schema<SearchInput> = {
		parse(raw) {
			const v = obj(raw, ['filters', 'cursor', 'limit', 'order']);
			const parsed = filters(v.filters);
			if (
				!config.search ||
				Object.keys(parsed).some((k) => !config.search!.fields.includes(k)) ||
				typeof v.order !== 'string' ||
				!['asc', 'desc'].includes(v.order)
			)
				return bad();
			return {
				filters: parsed,
				cursor: cursor(v.cursor),
				limit: int(v.limit, 1, config.search.pageSize),
				order: v.order as 'asc' | 'desc'
			};
		}
	};
	const searchOutput: Schema<SearchOutput> = {
		parse(raw) {
			const v = obj(raw, ['items', 'nextCursor']);
			return {
				items: dense(v.items, config.search?.pageSize ?? 0).map((raw) => {
					const row = obj(raw, ['id', 'parentId', 'version', 'state', 'data']);
					if (row.parentId !== null || typeof row.state !== 'string' || !d.states.includes(row.state)) return bad();
					return {
						id: id(row.id),
						parentId: null,
						version: int(row.version, 1, Number.MAX_SAFE_INTEGER),
						state: row.state,
						data: parseRecipeData(d, row.data)
					};
				}),
				nextCursor: cursor(v.nextCursor)
			};
		}
	};
	const reportInput: Schema<ReportInput> = {
		parse(raw) {
			const v = obj(raw, ['filters']);
			return { filters: filters(v.filters) };
		}
	};
	const reportOutput: Schema<Record<string, number>> = {
		parse(raw) {
			const names = (config.reports?.metrics ?? []).map((m) => m.name),
				v = obj(raw, names);
			return Object.fromEntries(
				names.map((name) => [name, int(v[name], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)])
			);
		}
	};
	const historyInput: Schema<HistoryInput> = {
		parse(raw) {
			const v = obj(raw, ['documentId']);
			return { documentId: id(v.documentId) };
		}
	};
	const historyOutput: Schema<HistoryRow[]> = {
		parse(raw) {
			return dense(raw, 100).map((raw) => {
				const v = obj(raw, ['actorId', 'event', 'at', 'changes']);
				if (typeof v.event !== 'string' || !config.audit?.events.includes(v.event)) return bad();
				const at = v.at instanceof Date ? v.at : typeof v.at === 'string' ? new Date(v.at) : null;
				if (!at || !Number.isFinite(at.getTime())) return bad();
				return { actorId: id(v.actorId), event: v.event, at: at.toISOString(), changes: parseRecipeData(d, v.changes) };
			});
		}
	};
	const importInput: Schema<ImportInput> = {
		parse(raw) {
			const v = obj(raw, ['text', 'mutationPrefix']);
			return { text: text(v.text, 5_000_000), mutationPrefix: id(v.mutationPrefix) };
		}
	};
	const importOutput: Schema<ImportOutput> = {
		parse(raw) {
			const hasError = !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'error');
			const v = obj(raw, hasError ? ['completed', 'total', 'failedRow', 'error'] : ['completed', 'total', 'failedRow']);
			const total = int(v.total, 0, config.csv?.maxRows ?? 0),
				completed = int(v.completed, 0, total);
			if (v.failedRow === null) {
				if (hasError || completed !== total) return bad();
				return { completed, total, failedRow: null };
			}
			const failedRow = int(v.failedRow, 2, total + 1);
			if (
				!hasError ||
				typeof v.error !== 'string' ||
				!['unauthenticated', 'forbidden', 'not-found', 'conflict', 'invalid-input', 'internal-error'].includes(
					v.error
				) ||
				completed !== failedRow - 2
			)
				return bad();
			return { completed, total, failedRow, error: String(v.error) };
		}
	};
	const exportInput: Schema<ExportInput> = reportInput;
	const exportOutput: Schema<string> = { parse: (raw) => text(raw, 25_000_000) };
	const uploadInput: Schema<UploadInput> = {
		parse(raw) {
			const v = obj(raw, ['documentId', 'bytes', 'mimeType', 'name']);
			if (
				typeof v.mimeType !== 'string' ||
				!config.attachments?.mimeTypes.includes(v.mimeType) ||
				typeof v.name !== 'string' ||
				!/^[^/\\\x00-\x1f]{1,128}$/.test(v.name)
			)
				return bad();
			return { documentId: id(v.documentId), bytes: bytes(v.bytes), mimeType: v.mimeType, name: v.name };
		}
	};
	const uploadOutput: Schema<UploadOutput> = {
		parse(raw) {
			const v = obj(raw, ['id']);
			return { id: id(v.id) };
		}
	};
	const downloadInput: Schema<DownloadInput> = {
		parse(raw) {
			const v = obj(raw, ['documentId', 'fileId']);
			return { documentId: id(v.documentId), fileId: id(v.fileId) };
		}
	};
	const downloadOutput: Schema<Uint8Array> = { parse: bytes };
	const notifyInput: Schema<NotifyInput> = {
		parse(raw) {
			const v = obj(raw, ['event', 'documentId', 'eventId']);
			if (typeof v.event !== 'string' || !config.notifications?.events.includes(v.event)) return bad();
			return { event: v.event, documentId: id(v.documentId), eventId: id(v.eventId) };
		}
	};
	const notifyOutput: Schema<NotifyOutput> = {
		parse(raw) {
			const v = obj(raw, ['delivered']);
			return { delivered: int(v.delivered, 0, 100) };
		}
	};
	return {
		searchInput,
		searchOutput,
		reportInput,
		reportOutput,
		historyInput,
		historyOutput,
		importInput,
		importOutput,
		exportInput,
		exportOutput,
		uploadInput,
		uploadOutput,
		downloadInput,
		downloadOutput,
		notifyInput,
		notifyOutput
	};
}

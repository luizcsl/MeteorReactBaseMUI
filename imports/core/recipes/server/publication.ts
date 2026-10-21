import { OperationError } from '../../contracts/errors';
import type { RecipeDTO } from './engine';
export interface PublicationContext {
	userId: string | null;
	added(collection: string, id: string, fields: Record<string, unknown>): void;
	changed(collection: string, id: string, fields: Record<string, unknown>): void;
	removed(collection: string, id: string): void;
	ready(): void;
	error(error: Error): void;
	onStop(callback: () => void): void;
}
type Observer = { stop(): void | Promise<void> };
/** Reuse the method's exact list authorization and projection. Invalidation clears the snapshot before async revalidation. */
export async function startRecipePublication(
	context: PublicationContext, collection: string,
	service: { list(userId: string | null, input: unknown): Promise<RecipeDTO[]> }, value: unknown,
	ports: {
		observeIdentity(userId: string, invalidate: () => void): Promise<Observer>;
		observeRecords(invalidate: () => void): Promise<Observer>;
		observeDependencies?: (invalidate: () => void) => Promise<Observer>;
		error(): Error;
	}
): Promise<void> {
	const input = value as { subscriptionId?: unknown; query?: unknown };
	if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 2 ||
		Reflect.ownKeys(input).some((key) => !['subscriptionId', 'query'].includes(String(key)) ||
			!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) ||
		!Object.hasOwn(input, 'query') || typeof input.subscriptionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.subscriptionId))
		throw new OperationError('invalid-input');
	if (!context.userId) throw new OperationError('unauthenticated');
	const id = input.subscriptionId;
	let stopped = false, published = false, revision = 0, scheduled = false, initialized = false;
	const observers: Observer[] = [];
	const clear = () => { if (published) context.removed(collection, id); published = false; };
	const stop = () => {
		if (stopped) return;
		stopped = true; revision++; clear();
		for (const observer of observers) void observer.stop();
	};
	context.onStop(stop);
	const refresh = async () => {
		scheduled = false;
		if (stopped || !initialized) return;
		const generation = revision;
		try {
			const rows = await service.list(context.userId, input.query);
			if (stopped || generation !== revision) return;
			context.added(collection, id, { rows }); published = true; context.ready();
		} catch {
			if (stopped || generation !== revision) return;
			stop(); context.error(ports.error());
		}
	};
	const invalidate = () => {
		if (stopped) return;
		revision++; clear();
		if (!scheduled && initialized) { scheduled = true; void Promise.resolve().then(refresh); }
	};
	const attach = async (start: () => Promise<Observer>) => {
		const observer = await start();
		if (stopped) await observer.stop(); else observers.push(observer);
	};
	try {
		await attach(() => ports.observeIdentity(context.userId!, invalidate));
		if (stopped) return;
		await attach(() => ports.observeRecords(invalidate));
		if (stopped) return;
		if (ports.observeDependencies) await attach(() => ports.observeDependencies!(invalidate));
		if (stopped) return;
		initialized = true;
		await refresh();
	} catch {
		if (!stopped) { stop(); context.error(ports.error()); }
	}
}

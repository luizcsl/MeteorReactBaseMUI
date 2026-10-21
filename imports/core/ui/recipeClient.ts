import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { callMethod } from '../../api/methodTransport';
import { subscribe } from '../../api/subscriptionTransport';
import type { RecipeDefinition } from '../recipes/definition';
import type { RecipeClient, RecipeRow } from './RecipePage';
const views = new Map<string, Mongo.Collection<{ _id: string; rows: RecipeRow[] }>>();
/** Reactive mode requires a server-approved identity observer at registration. */
export function createRecipeClient(definition: RecipeDefinition, reactive = false): RecipeClient {
	const query = (filters: unknown, limit: number, parentId?: string | null) => ({ filters, limit, ...(definition.profile === 'master-detail' ? { parentId } : {}) });
	const client: RecipeClient = {
		list: (filters, limit, parentId) => callMethod(`${definition.name}.list`, query(filters, limit, parentId)),
		create: (data, parentId, mutationId) => callMethod(`${definition.name}.create`, { data, parentId, mutationId }),
		update: (id, version, data) => callMethod(`${definition.name}.update`, { id, version, data }),
		transition: (id, version, to) => callMethod(`${definition.name}.transition`, { id, version, to }),
		remove: (id, version) => callMethod(`${definition.name}.remove`, { id, version })
	};
	if (reactive) client.subscribe = (filters, limit, parentId, onState) => {
		const name = `recipe_view_${definition.name}`;
		if (!views.has(name)) views.set(name, new Mongo.Collection(name));
		const collection = views.get(name)!;
		const subscriptionId = crypto.randomUUID();
		let stopped = false, terminal = false;
		onState({ rows: [], loading: true, error: null });
		const handle = subscribe(`${definition.name}.records`, { subscriptionId, query: query(filters, limit, parentId) }, {
			onStop(error?: Error) { terminal = true; if (!stopped) onState({ rows: [], loading: false, error: error ?? new Error('Subscription stopped') }); }
		});
		const computation = Tracker.autorun(() => {
			const snapshot = collection.findOne(subscriptionId);
			if (!stopped && !terminal) onState({ rows: snapshot?.rows ?? [], loading: !handle.ready() || !snapshot, error: null });
		});
		return { stop() { stopped = true; computation.stop(); handle.stop(); } };
	};
	return client;
}

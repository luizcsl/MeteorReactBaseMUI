/** Isolated browser fixture. Never imported by the application or registered as a route. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { RecipePage, type RecipeClient, type RecipeRow } from '../../imports/core/ui/RecipePage';
import {
	validateDefinition,
	type RecipeData,
	type RecipeDefinition,
	type RecipeProfile
} from '../../imports/core/recipes/definition';

type Method = keyof RecipeClient;
type Call = { id: number; method: Method; args: unknown[]; status: 'pending' | 'resolved' | 'rejected' };
type Pending = { call: Call; run: () => unknown; resolve: (value: unknown) => void; reject: (error: Error) => void };
type Options = { profile?: RecipeProfile; rows?: RecipeRow[]; hold?: Method[]; parentId?: string | null };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function definition(profile: RecipeProfile): RecipeDefinition {
	return validateDefinition({
		schemaVersion: 1,
		name: 'browserrecipes',
		profile,
		fields: [
			{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 40 },
			{ name: 'quantity', label: 'Quantity', type: 'integer', required: true, min: 1, max: 5 },
			{ name: 'active', label: 'Active', type: 'boolean', required: true },
			{ name: 'category', label: 'Category', type: 'enum', required: true, values: ['general', 'urgent'] },
			{ name: 'note', label: 'Note', type: 'string', required: false, maxLength: 60 }
		],
		filters: ['title', 'quantity', 'active', 'category'],
		states: profile === 'approval' ? ['draft', 'pending', 'approved', 'rejected'] : ['draft', 'complete'],
		transitions:
			profile === 'approval'
				? [
						{ from: 'draft', to: 'pending', roles: ['owner'] },
						{ from: 'pending', to: 'approved', roles: ['reviewer'] },
						{ from: 'pending', to: 'rejected', roles: ['reviewer'] }
					]
				: [{ from: 'draft', to: 'complete', roles: ['owner'] }],
		permissions: { read: ['owner'], write: ['owner'] }
	});
}

/** A controllable remote adapter, NOT a server/security implementation. */
class ControlledClient {
	calls: Call[] = [];
	rows: RecipeRow[];
	held: Set<Method>;
	pending = new Map<number, Pending>();
	private sequence = 0;
	private receipts = new Map<string, RecipeRow>();
	constructor(options: Options) {
		this.rows = clone(options.rows ?? []);
		this.held = new Set(options.hold ?? []);
	}
	private request<T>(method: Method, args: unknown[], run: () => T): Promise<T> {
		const call: Call = { id: ++this.sequence, method, args: clone(args), status: 'pending' };
		this.calls.push(call);
		return new Promise<T>((resolve, reject) => {
			const pending: Pending = {
				call,
				run,
				resolve: (value) => {
					call.status = 'resolved';
					resolve(clone(value) as T);
				},
				reject: (error) => {
					call.status = 'rejected';
					reject(error);
				}
			};
			this.pending.set(call.id, pending);
			if (!this.held.has(method)) queueMicrotask(() => this.release(call.id));
		});
	}
	release(id: number, result?: unknown) {
		const pending = this.pending.get(id);
		if (!pending) throw new Error(`No pending request ${id}`);
		this.pending.delete(id);
		try {
			pending.resolve(result === undefined ? pending.run() : result);
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}
	reject(id: number, commit = false) {
		const pending = this.pending.get(id);
		if (!pending) throw new Error(`No pending request ${id}`);
		this.pending.delete(id);
		if (commit) pending.run(); // Simulate a committed write whose acknowledgement was lost.
		pending.reject(new Error('Controlled remote rejection'));
	}
	private current(id: string, version: number) {
		const row = this.rows.find((row) => row.id === id);
		if (!row || row.version !== version) throw new Error('Conflict');
		return row;
	}
	client: RecipeClient = {
		list: (filters, limit, parentId = null) => {
			const snapshot = clone(
				this.rows
					.filter(
						(row) =>
							row.parentId === parentId && Object.entries(filters).every(([name, value]) => row.data[name] === value)
					)
					.slice(0, limit)
			);
			return this.request('list', [filters, limit, parentId], () => snapshot);
		},
		create: (data, parentId, mutationId) =>
			this.request('create', [data, parentId, mutationId], () => {
				const replay = this.receipts.get(mutationId);
				if (replay) return replay;
				const row: RecipeRow = {
					id: `created-${this.receipts.size + 1}`,
					parentId,
					version: 1,
					state: 'draft',
					data: clone(data)
				};
				this.rows.push(row);
				this.receipts.set(mutationId, clone(row));
				return row;
			}),
		update: (id, version, data) =>
			this.request('update', [id, version, data], () => {
				const row = this.current(id, version);
				Object.assign(row, { data: clone(data), version: version + 1 });
				return row;
			}),
		transition: (id, version, to) =>
			this.request('transition', [id, version, to], () => {
				const row = this.current(id, version);
				Object.assign(row, { state: to, version: version + 1 });
				return row;
			}),
		remove: (id, version) =>
			this.request('remove', [id, version], () => {
				this.current(id, version);
				this.rows = this.rows.filter((row) => row.id !== id);
				return { removed: true };
			})
	};
}

const root = createRoot(document.getElementById('root')!);
const theme = createTheme();
let generation = 0;
let controlled: ControlledClient;
let previous: ControlledClient | undefined;
let currentOptions: Options = {};
const renderFixture = () => root.render(<Fixture key={generation} options={currentOptions} remote={controlled} />);
function Fixture({ options, remote }: { options: Options; remote: ControlledClient }) {
	const profile = options.profile ?? 'owner';
	const [parentId, setParentId] = useState(options.parentId ?? (profile === 'master-detail' ? 'parent-a' : null));
	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			<Box component="main" sx={{ maxWidth: 1000, mx: 'auto', p: 3 }} data-fixture-generation={generation}>
				{profile === 'master-detail' && (
					<label>
						Parent record
						<select
							aria-label="Parent record"
							value={parentId ?? ''}
							onChange={(event) => setParentId(event.target.value || null)}>
							<option value="">No parent</option>
							<option value="parent-a">Parent A</option>
							<option value="parent-b">Parent B</option>
						</select>
					</label>
				)}
				<RecipePage definition={definition(profile)} client={remote.client} parentId={parentId} />
			</Box>
		</ThemeProvider>
	);
}

const fixture = {
	reset(options: Options = {}) {
		controlled = new ControlledClient(options);
		previous = undefined;
		currentOptions = options;
		generation++;
		renderFixture();
		return generation;
	},
	/** Replace the authenticated adapter without remounting the wrapper or changing the parent. */
	switchClient(options: Options = {}) {
		previous = controlled;
		currentOptions = { ...currentOptions, ...options };
		controlled = new ControlledClient(options);
		renderFixture();
	},
	changeDefinition(profile: RecipeProfile) {
		currentOptions = { ...currentOptions, profile };
		renderFixture();
	},
	rerender() {
		renderFixture();
	},
	get previousCalls() {
		return clone(previous?.calls ?? []);
	},
	releasePrevious(id: number) {
		if (!previous) throw new Error('No previous client');
		previous.release(id);
	},
	get calls() {
		return clone(controlled.calls);
	},
	get rows() {
		return clone(controlled.rows);
	},
	hold(method: Method, held = true) {
		if (held) controlled.held.add(method);
		else controlled.held.delete(method);
	},
	release(id: number, result?: unknown) {
		controlled.release(id, result);
	},
	reject(id: number, commit = false) {
		controlled.reject(id, commit);
	},
	/** Explicitly emulate a newer server version for conflict tests. */
	change(id: string, data: RecipeData) {
		const row = controlled.rows.find((row) => row.id === id);
		if (!row) throw new Error(`Unknown record ${id}`);
		row.data = clone(data);
		row.version++;
	}
};
declare global {
	interface Window {
		recipeFixture: typeof fixture;
	}
}
window.recipeFixture = fixture;
fixture.reset();

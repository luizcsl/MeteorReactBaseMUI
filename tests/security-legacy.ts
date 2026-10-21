import assert from 'assert';
import { Meteor } from 'meteor/meteor';
import { ApiBase } from '../imports/api/base';

if (Meteor.isServer) {
	describe('legacy trust boundaries (real method registrations and Mongo writes)', function () {
		let api: any;
		let context: any;
		const prefix = 'security-legacy-';
		const previousSyncFlag = process.env.EXPERIMENTAL_EXAMPLE_SYNC;
		before(async function () {
			api = (await import('../imports/modules/example/api/exampleServerApi')).exampleServerApi;
			process.env.EXPERIMENTAL_EXAMPLE_SYNC = 'true';
			context = {
				user: { _id: 'security-test-user', roles: ['Administrador'], status: 'active' },
				validador: { lancarErroSeHouver() {} }
			};
		});
		after(function () {
			if (previousSyncFlag === undefined) delete process.env.EXPERIMENTAL_EXAMPLE_SYNC;
			else process.env.EXPERIMENTAL_EXAMPLE_SYNC = previousSyncFlag;
		});
		afterEach(async function () {
			await api.getCollectionInstance().removeAsync({ _id: { $regex: `^${prefix}` } });
			await api.tombstones.removeAsync({ documentId: { $regex: `^${prefix}` } });
		});

		it('rejects argument-shift and anonymous replay over a real DDP connection', async function () {
			this.timeout(15000);
			const { DDP } = require('meteor/ddp-client');
			const connection = DDP.connect(Meteor.absoluteUrl(), { retry: false });
			const call = (name: string, ...args: unknown[]) =>
				new Promise((resolve, reject) => {
					const timeout = setTimeout(() => reject(new Error(`DDP call timed out: ${name}`)), 10000);
					connection.call(name, ...args, (error: Error | null, result: unknown) => {
						clearTimeout(timeout);
						if (error) reject(error);
						else resolve(result);
					});
				});
			const id = `${prefix}ddp-private`;
			await api
				.getCollectionInstance()
				.insertAsync({ _id: id, title: 'Private document', type: 'Categoria A', typeMulti: 'alta', _syncRevision: 1 });
			try {
				await assert.rejects(
					call('example.exportCollection', { user: { roles: ['Administrador'] } }),
					(error: any) => error.error === 'invalid-arguments'
				);
				await assert.rejects(
					call('example.update', { _id: id }, { user: { roles: ['Administrador'] } }),
					(error: any) => error.error === 'invalid-arguments'
				);
				await assert.rejects(
					call('example.mobileUpsert', { document: { _id: id }, mutationId: 'anonymous-replay' }),
					(error: any) => error.error === 'Acesso negado' || error.error === 'not-authorized'
				);
				assert.strictEqual((await api.getCollectionInstance().findOneAsync(id)).title, 'Private document');
			} finally {
				connection.disconnect();
			}
		});
		it('rejects forged context before invoking the real export handler', async function () {
			const handler = (Meteor as any).server.method_handlers['example.exportCollection'];
			await assert.rejects(
				handler.call({}, { user: { roles: ['Administrador'] } }),
				(error: any) => error.error === 'invalid-arguments'
			);
		});
		it('rejects trailing context injection for CRUD', async function () {
			const handler = (Meteor as any).server.method_handlers['example.update'];
			await assert.rejects(
				handler.call({}, { _id: 'x' }, context),
				(error: any) => error.error === 'invalid-arguments'
			);
		});
		it('pads omitted optional inputs and places trusted context at a fixed position', async function () {
			const original = api._createContext;
			api._createContext = async () => context;
			try {
				api.registerMethod('securityBoundaryTest', (input: unknown, trusted: unknown) => ({ input, trusted }), 1, 0);
				const handler = (Meteor as any).server.method_handlers['example.securityBoundaryTest'];
				const result = await handler.call({});
				assert.strictEqual(result.input, undefined);
				assert.strictEqual(result.trusted, context);
			} finally {
				api._createContext = original;
			}
		});
		it('transaction registrations also reject injected contexts', async function () {
			api.registerTransactionMethod('securityTransactionTest', () => true, 0);
			const handler = (Meteor as any).server.method_handlers['example.securityTransactionTest'];
			await assert.rejects(handler.call({}, context), (error: any) => error.error === 'invalid-arguments');
		});
		it('rejects retired last-write-wins sync and unsupported legacy transactions', async function () {
			await assert.rejects(api.serverSync({}, context), (error: any) => error.error === 'sync-protocol-required');
			for (const method of ['serverInsert', 'serverUpdate', 'serverUpsert', 'serverRemove']) {
				await assert.rejects(
					api[method]({}, { ...context, session: {} }),
					(error: any) => error.error === 'transaction-repository-required'
				);
			}
		});
		it('denies missing policies instead of silently granting access', async function () {
			const original = api.defaultResources;
			api.defaultResources = {};
			try {
				await assert.rejects(api.beforeUpdate({}, context), (error: any) => error.error === 'missing-policy');
			} finally {
				api.defaultResources = original;
			}
		});
		it('authorizes mobileUpsert before any document read or replay return', async function () {
			const original = api.getCollectionInstance;
			let read = false;
			api.getCollectionInstance = () => {
				read = true;
				throw new Error('Unexpected read');
			};
			try {
				await assert.rejects(
					api.mobileUpsert(
						{ document: { _id: `${prefix}private` }, mutationId: 'mutation-private' },
						{ user: { roles: [] } }
					)
				);
				assert.strictEqual(read, false);
			} finally {
				api.getCollectionInstance = original;
			}
		});
		it('settles disconnected promises immediately with a stable error', async function () {
			const status = Meteor.status;
			(Meteor as any).status = () => ({ connected: false });
			try {
				const client = Object.create(ApiBase.prototype);
				client.collectionName = 'example';
				await assert.rejects(client.callMethodWithPromise('update', {}), (error: any) => error.error === 'offline');
			} finally {
				Meteor.status = status;
			}
		});
		it('disables experimental sync by default before touching storage', async function () {
			delete process.env.EXPERIMENTAL_EXAMPLE_SYNC;
			try {
				await assert.rejects(
					api.mobileUpsert({}, context),
					(error: any) => error.error === 'experimental-sync-disabled'
				);
				await assert.rejects(api.mobilePull({}, context), (error: any) => error.error === 'experimental-sync-disabled');
			} finally {
				process.env.EXPERIMENTAL_EXAMPLE_SYNC = 'true';
			}
		});
		it('rejects nontransactional deletion while experimental sync is enabled', async function () {
			await assert.rejects(
				api.serverRemove({ _id: `${prefix}delete` }, context),
				(error: any) => error.error === 'experimental-sync-delete-unsupported'
			);
		});
		it('paginates more than 500 equal timestamps with independent document/deletion checkpoints', async function () {
			const at = new Date(Date.now() - 1000);
			await api
				.getCollectionInstance()
				.rawCollection()
				.insertMany(
					Array.from({ length: 505 }, (_, i) => ({ _id: `${prefix}${String(i).padStart(4, '0')}`, lastupdate: at }))
				);
			await api.tombstones.rawCollection().insertMany(
				Array.from({ length: 505 }, (_, i) => ({
					_id: `${prefix}${String(i).padStart(4, '0')}`,
					documentId: `${prefix}deleted-${i}`,
					deletedAt: at
				}))
			);
			let since: any = new Date(at.getTime() - 1);
			const documents = new Set<string>();
			const deletions = new Set<string>();
			for (let page = 0; page < 10; page++) {
				const result = await api.mobilePull({ since }, context);
				result.documents.forEach((doc: any) => documents.add(doc._id));
				result.deletedIds.forEach((id: string) => deletions.add(id));
				since = result.cursor;
				if (!result.hasMore) break;
			}
			assert.strictEqual([...documents].filter((id) => id.startsWith(prefix)).length, 505);
			assert.strictEqual([...deletions].filter((id) => id.startsWith(prefix)).length, 505);
		});
		it('uses a shared revision across web, mobile, upload and removal touch operations even when time reverses', async function () {
			// Direct server-service integration has no Meteor MethodInvocation. Stub only audit
			// identity lookup; authorization, schema checks, Mongo pipeline and CAS stay real.
			const originalAudit = api._includeAuditData;
			api._includeAuditData = async (doc: any, action: string) => {
				if (action === 'insert') {
					doc.createdby = context.user._id;
					doc.createdat = new Date();
				}
				doc.updatedby = context.user._id;
				doc.lastupdate = new Date();
			};
			try {
				const id = `${prefix}mixed`;
				const document = { _id: id, title: 'Original', type: 'Categoria A', typeMulti: 'alta' };
				await api.serverInsert(document, context);
				let current = await api.getCollectionInstance().findOneAsync(id);
				assert.strictEqual(current._syncRevision, 1);
				// Deliberately put the persisted wall time in the future to simulate a regressed clock.
				const future = new Date(Date.now() + 60000);
				await api.getCollectionInstance().updateAsync(id, { $set: { lastupdate: future } });
				await api.serverUpdate({ ...document, title: 'Web change' }, context);
				current = await api.getCollectionInstance().findOneAsync(id);
				assert.strictEqual(current._syncRevision, 2);
				assert(current.lastupdate.getTime() > future.getTime());
				await assert.rejects(
					api.mobileUpsert({ document, baseRevision: 1, mutationId: 'mutation-stale-web' }, context),
					(error: any) => error.error === 'sync-conflict'
				);
				// The same primitive is invoked by upload completion and asset removal.
				for (const actor of ['upload-completion', 'asset-removal']) {
					const previous = current;
					await api.commitRevision(id, { updatedby: actor });
					current = await api.getCollectionInstance().findOneAsync(id);
					assert.strictEqual(current._syncRevision, previous._syncRevision + 1);
					assert(current.lastupdate.getTime() > previous.lastupdate.getTime());
					await assert.rejects(
						api.mobileUpsert(
							{ document, baseRevision: previous._syncRevision, mutationId: `mutation-${actor}` },
							context
						),
						(error: any) => error.error === 'sync-conflict'
					);
				}
				const baseRevision = current._syncRevision;
				const input = (n: number) => ({
					document: { ...document, title: `Mobile ${n}` },
					baseRevision,
					mutationId: `mutation-race-${n}`
				});
				const results = await Promise.allSettled([
					api.mobileUpsert(input(1), context),
					api.mobileUpsert(input(2), context)
				]);
				assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
				const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
				assert.strictEqual(rejected.reason.error, 'sync-conflict');
				const winner = results.findIndex((result) => result.status === 'fulfilled') + 1;
				const before = await api.getCollectionInstance().findOneAsync(id);
				await api.mobileUpsert(input(winner), context);
				assert.deepStrictEqual(await api.getCollectionInstance().findOneAsync(id), before);
			} finally {
				api._includeAuditData = originalAudit;
			}
		});
	});
}

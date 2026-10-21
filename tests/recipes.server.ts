/// <reference types="mocha" />
/** Real authenticated DDP and Mongo qualification. Synthetic identities only; no production registration. */
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { registerRecipe } from '../imports/core/recipes/server/register';
import { OperationError } from '../imports/core/contracts/errors';
import type { RecipeDefinition } from '../imports/core/recipes/definition';
import type { RecipeDTO, RecipeIdentity } from '../imports/core/recipes/server/engine';

if (Meteor.isServer)
	describe('structured recipes over authenticated DDP and Mongo', function () {
		this.timeout(30_000);
		const base: RecipeDefinition = {
			schemaVersion: 1,
			name: 'recipeddptest',
			profile: 'owner',
			fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
			filters: ['title'],
			states: ['draft', 'submitted', 'approved'],
			transitions: [{ from: 'draft', to: 'submitted', roles: ['owner'] }],
			permissions: { read: ['owner'], write: ['owner'] }
		};
		const names = ['recipeddptest', 'recipeteamtest', 'recipeapprovaltest', 'recipechildtest', 'recipedomaintest'];
		const identities = new Map<string, RecipeIdentity>();
		const connections: Record<string, any> = {};
		const ids: Record<string, string> = {};
		const parents = new Set<string>();
		const database = new Mongo.Collection('recipe_test_cleanup').rawDatabase();
		const call = (who: string, module: string, operation: string, ...args: unknown[]) =>
			new Promise<any>((resolve, reject) =>
				connections[who].call(`${module}.${operation}`, ...args, (error: unknown, result: unknown) =>
					error ? reject(error) : resolve(result)
				)
			);
		before(async () => {
			const { Accounts } = require('meteor/accounts-base');
			const { DDP } = require('meteor/ddp-client');
			const { Random } = require('meteor/random');
			const resolver = async (userId: string) => {
				const identity = identities.get(userId);
				if (!identity || !(await Meteor.users.findOneAsync(userId))) throw new OperationError('forbidden');
				return identity;
			};
			registerRecipe(base, { resolveIdentity: resolver });
			registerRecipe(
				{ ...base, name: names[1], profile: 'team', permissions: { read: ['member'], write: ['member'] } },
				{ resolveIdentity: resolver }
			);
			registerRecipe(
				{
					...base,
					name: names[2],
					profile: 'approval',
					permissions: { read: ['owner', 'reviewer'], write: ['owner'] },
					transitions: [...base.transitions, { from: 'submitted', to: 'approved', roles: ['reviewer'] }]
				},
				{ resolveIdentity: resolver }
			);
			registerRecipe(
				{ ...base, name: names[3], profile: 'master-detail' },
				{
					resolveIdentity: resolver,
					parentExists: async (scope, id) => parents.has(`${scope.ownerId}:${scope.tenantId}:${id}`)
				}
			);
			registerRecipe(
				{
					...base,
					name: names[4],
					fields: [
						{ name: 'start', label: 'Start', type: 'date', required: true },
						{ name: 'end', label: 'End', type: 'date', required: true },
						{
							name: 'amount',
							label: 'Amount',
							type: 'money',
							required: true,
							currency: 'BRL',
							scale: 2,
							min: 0,
							max: 100000
						},
						{ name: 'supplier', label: 'Supplier', type: 'reference', required: true, target: base.name }
					],
					filters: ['start', 'amount'],
					rules: [{ kind: 'lte', left: 'start', right: 'end' }]
				},
				{
					resolveIdentity: resolver,
					referenceExists: async (who, target, id) =>
						target === base.name &&
						Boolean(
							await database
								.collection('recipe_' + base.name)
								.findOne({ _id: id, ownerId: who.userId, tenantId: who.tenantId, deleted: false } as any)
						)
				}
			);
			for (const name of names) await database.collection(`recipe_${name}`).deleteMany({});
			for (const label of ['alice', 'bob', 'reviewer', 'outsider']) {
				const id = `recipe-${Random.id()}`;
				ids[label] = id;
				await Meteor.users.insertAsync({ _id: id, emails: [{ address: `${id}@example.test`, verified: true }] });
				identities.set(id, {
					userId: id,
					tenantId: label === 'outsider' ? 'other' : 'tenant',
					roles: label === 'reviewer' || label === 'alice' ? ['member', 'reviewer'] : ['member']
				});
				const token = Accounts._generateStampedLoginToken();
				await Accounts._insertLoginToken(id, token);
				connections[label] = DDP.connect(Meteor.absoluteUrl(), { retry: false });
				await new Promise<void>((resolve, reject) =>
					connections[label].call('login', { resume: token.token }, (error: unknown) =>
						error ? reject(error) : resolve()
					)
				);
			}
			connections.anonymous = DDP.connect(Meteor.absoluteUrl(), { retry: false });
		});
		after(async () => {
			for (const connection of Object.values(connections)) connection.close();
			for (const name of names) await database.collection(`recipe_${name}`).deleteMany({});
			await Meteor.users.removeAsync({ _id: { $in: Object.values(ids) } });
		});
		it('rejects anonymous, extra arguments and selector injection on the real wire', async () => {
			await assert.rejects(call('anonymous', names[0], 'list', { filters: {}, limit: 10 }), {
				error: 'unauthenticated'
			});
			await assert.rejects(call('alice', names[0], 'list', { filters: {}, limit: 10 }, { userId: ids.bob }), {
				error: 'invalid-input'
			});
			await assert.rejects(call('alice', names[0], 'list', { filters: { title: { $regex: '.*' } }, limit: 10 }), {
				error: 'invalid-input'
			});
		});
		it('deduplicates concurrent creation, performs Mongo CAS and retains deletion tombstones', async () => {
			const input = { mutationId: 'one', data: { title: 'private' }, parentId: null };
			const [a, b] = (await Promise.all([
				call('alice', names[0], 'create', input),
				call('alice', names[0], 'create', input)
			])) as RecipeDTO[];
			assert.equal(a.id, b.id);
			assert.equal(await database.collection(`recipe_${names[0]}`).countDocuments({ _id: a.id }), 1);
			assert.deepEqual(Object.keys(a).sort(), ['data', 'id', 'parentId', 'state', 'version']);
			assert.deepEqual(await call('bob', names[0], 'list', { filters: { title: 'private' }, limit: 10 }), []);
			await assert.rejects(call('bob', names[0], 'update', { id: a.id, version: 1, data: { title: 'stolen' } }), {
				error: 'not-found'
			});
			await assert.rejects(call('alice', names[0], 'create', { ...input, data: { title: 'different' } }), {
				error: 'conflict'
			});
			const results = await Promise.allSettled(
				['a', 'b'].map((title) => call('alice', names[0], 'update', { id: a.id, version: 1, data: { title } }))
			);
			assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
			await call('alice', names[0], 'remove', { id: a.id, version: 2 });
			await assert.rejects(call('alice', names[0], 'create', input), { error: 'conflict' });
			assert.equal((await database.collection(`recipe_${names[0]}`).findOne({ _id: a.id } as any))?.deleted, true);
			assert.deepEqual(await call('alice', names[0], 'list', { filters: {}, limit: 10 }), []);
		});
		it('enforces tenant isolation and current membership after revocation', async () => {
			await call('alice', names[1], 'create', { mutationId: 'team1', data: { title: 'shared' }, parentId: null });
			assert.equal((await call('bob', names[1], 'list', { filters: {}, limit: 10 })).length, 1);
			assert.deepEqual(await call('outsider', names[1], 'list', { filters: {}, limit: 10 }), []);
			const old = identities.get(ids.bob)!;
			identities.delete(ids.bob);
			try {
				await assert.rejects(call('bob', names[1], 'list', { filters: {}, limit: 10 }), { error: 'forbidden' });
			} finally {
				identities.set(ids.bob, old);
			}
		});
		it('isolates the same owner across tenant and personal contexts on Mongo selectors', async () => {
			const old = identities.get(ids.alice)!;
			try {
				const tenant = await call('alice', names[0], 'create', {
					mutationId: 'scope',
					data: { title: 'tenant scoped' },
					parentId: null
				});
				identities.set(ids.alice, { ...old, tenantId: 'other' });
				assert.deepEqual(await call('alice', names[0], 'list', { filters: { title: 'tenant scoped' }, limit: 10 }), []);
				identities.set(ids.alice, { userId: ids.alice, roles: [] });
				assert.deepEqual(await call('alice', names[0], 'list', { filters: { title: 'tenant scoped' }, limit: 10 }), []);
				await assert.rejects(
					call('alice', names[0], 'update', { id: tenant.id, version: 1, data: { title: 'stolen' } }),
					{ error: 'not-found' }
				);
				const personal = await call('alice', names[0], 'create', {
					mutationId: 'scope',
					data: { title: 'personal scoped' },
					parentId: null
				});
				assert.notEqual(personal.id, tenant.id);
				identities.set(ids.alice, old);
				assert.deepEqual(
					await call('alice', names[0], 'list', { filters: { title: 'personal scoped' }, limit: 10 }),
					[]
				);
				await assert.rejects(call('alice', names[0], 'remove', { id: personal.id, version: 1 }), {
					error: 'not-found'
				});
			} finally {
				identities.set(ids.alice, old);
			}
		});
		it('rejects corrupt storage envelopes without mutating them', async () => {
			const row = await call('alice', names[0], 'create', {
				mutationId: 'corrupt',
				data: { title: 'corrupt probe' },
				parentId: null
			});
			const collection = database.collection(`recipe_${names[0]}`);
			await collection.updateOne({ _id: row.id }, { $set: { state: 'unknown' } });
			await assert.rejects(call('alice', names[0], 'list', { filters: { title: 'corrupt probe' }, limit: 10 }), {
				error: 'invalid-input'
			});
			await assert.rejects(
				call('alice', names[0], 'update', { id: row.id, version: 1, data: { title: 'overwrite' } }),
				{ error: 'invalid-input' }
			);
			assert.equal((await collection.findOne({ _id: row.id }))?.data.title, 'corrupt probe');
		});

		it('requires a separate reviewer in the same tenant and freezes submitted content', async () => {
			const row = await call('alice', names[2], 'create', {
				mutationId: 'approve1',
				data: { title: 'claim' },
				parentId: null
			});
			await call('alice', names[2], 'transition', { id: row.id, version: 1, to: 'submitted' });
			await assert.rejects(call('alice', names[2], 'transition', { id: row.id, version: 2, to: 'approved' }), {
				error: 'forbidden'
			});
			await assert.rejects(call('outsider', names[2], 'transition', { id: row.id, version: 2, to: 'approved' }), {
				error: 'not-found'
			});
			await assert.rejects(call('alice', names[2], 'update', { id: row.id, version: 2, data: { title: 'changed' } }), {
				error: 'forbidden'
			});
			assert.equal(
				(await call('reviewer', names[2], 'transition', { id: row.id, version: 2, to: 'approved' })).state,
				'approved'
			);
		});
		it('checks scoped parent ownership on creation and child listing', async () => {
			parents.add(`${ids.alice}:tenant:parent1`);
			const input = { mutationId: 'child1', data: { title: 'child' }, parentId: 'parent1' };
			await assert.rejects(call('bob', names[3], 'create', input), { error: 'not-found' });
			const child = await call('alice', names[3], 'create', input);
			assert.equal((await call('alice', names[3], 'list', { filters: {}, limit: 10, parentId: 'parent1' })).length, 1);
			await assert.rejects(call('bob', names[3], 'list', { filters: {}, limit: 10, parentId: 'parent1' }), {
				error: 'not-found'
			});
			parents.clear();
			await assert.rejects(
				call('alice', names[3], 'update', { id: child.id, version: 1, data: { title: 'orphan edit' } }),
				{ error: 'not-found' }
			);
			await assert.rejects(call('alice', names[3], 'remove', { id: child.id, version: 1 }), { error: 'not-found' });
			await assert.rejects(call('alice', names[3], 'list', { filters: {}, limit: 10, parentId: 'parent1' }), {
				error: 'not-found'
			});
		});
		it('validates civil dates, exact money, cross-field rules and live scoped references over DDP', async () => {
			const supplier = await call('alice', names[0], 'create', {
				mutationId: 'domain-supplier',
				data: { title: 'Supplier' },
				parentId: null
			});
			const data = { start: '2024-02-29', end: '2024-03-01', amount: 1010, supplier: supplier.id };
			const input = { mutationId: 'domain', data, parentId: null };
			for (const change of [{ start: '2023-02-29' }, { end: '2024-01-01' }, { amount: 10.1 }, { amount: '10.10' }])
				await assert.rejects(call('alice', names[4], 'create', { ...input, data: { ...data, ...change } }), {
					error: 'invalid-input'
				});
			await assert.rejects(call('bob', names[4], 'create', input), { error: 'not-found' });
			const row = await call('alice', names[4], 'create', input);
			assert.deepEqual(row.data, data);
			assert.equal(
				(await call('alice', names[4], 'list', { filters: { amount: 1010, start: '2024-02-29' }, limit: 10 })).length,
				1
			);
			await call('alice', names[0], 'remove', { id: supplier.id, version: 1 });
			await assert.rejects(call('alice', names[4], 'update', { id: row.id, version: 1, data }), { error: 'not-found' });
			assert.equal((await database.collection('recipe_' + names[4]).findOne({ _id: row.id } as any))?.version, 1);
		});
	});

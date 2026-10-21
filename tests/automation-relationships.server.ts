/// <reference types="mocha" />
/** Qualification against actual replica-set transactions, never an in-memory transaction mock. */
import assert from 'node:assert/strict';
import { Mongo } from 'meteor/mongo';
import type { ClientSession } from 'mongodb';
import type { RecipeDefinition } from '../imports/core/recipes/definition';
import type { RecipeRecord, RecipeRepository } from '../imports/core/recipes/server/engine';
import { createMongoRelationshipAdapter } from '../imports/core/recipes/server/mongoRelationships';
import {
	withRelationshipPorts,
	type RelationshipAdapter,
	type RelationshipModule
} from '../imports/core/recipes/server/relationships';

const db = new Mongo.Collection('automation_relationship_qualification').rawDatabase();
const driver = db as typeof db & { client: { startSession(): ClientSession } };
const parents = db.collection<RecipeRecord>('automation_relationship_parents');
const children = db.collection<RecipeRecord>('automation_relationship_children');
const scope = { ownerId: 'relation-owner', tenantId: null };
const sessions: ClientSession[] = [];
const definition = (name: string): RecipeDefinition => ({
	schemaVersion: 1,
	name,
	profile: 'owner',
	fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
	filters: [],
	states: ['draft'],
	transitions: [],
	permissions: { read: ['owner'], write: ['owner'] }
});
const record = (id: string, data: RecipeRecord['data']): RecipeRecord => ({
	_id: id,
	ownerId: scope.ownerId,
	version: 1,
	state: 'draft',
	deleted: false,
	creationFingerprint: id,
	data
});
function setup(
	policy: 'restrict' | 'cascade' | 'set-null',
	decorate?: (adapter: RelationshipAdapter) => RelationshipAdapter
) {
	const parent = definition('relationparents');
	const child: RecipeDefinition = {
		...definition('relationchildren'),
		fields: [{ name: 'link', label: 'Parent', type: 'reference', target: parent.name, required: false }]
	};
	const modules: RelationshipModule[] = [
		{
			definition: parent,
			collection: 'automation_relationship_parents',
			relationships: {
				incoming: [{ name: 'children', source: child.name, field: 'link', policy, maxAffected: 10 }],
				outgoing: [],
				maxTotal: 20
			}
		},
		{
			definition: child,
			collection: 'automation_relationship_children',
			relationships: { incoming: [], outgoing: [{ field: 'link', target: parent.name }], maxTotal: 20 }
		}
	];
	const raw = createMongoRelationshipAdapter({
		database: db,
		modules,
		startSession: () => {
			const session = driver.client.startSession();
			sessions.push(session);
			return session;
		}
	});
	const adapter = decorate ? decorate(raw) : raw;
	const repositories = modules.map((module) => {
		const ports = withRelationshipPorts(
			{ resolveIdentity: async () => ({ userId: scope.ownerId, roles: [] as const }) },
			module.definition,
			module.relationships,
			adapter
		);
		// Reads are not used by these tests; all writers MUST be supplied by the real transaction decorator.
		return ports.configureRepository!({} as RecipeRepository);
	});
	return { parent: repositories[0], child: repositories[1] };
}

describe('automation relationship real replica-set qualification', function () {
	this.timeout(30000);
	before(async () => {
		assert.equal(process.env.TEST_TRANSACTIONS, '1');
		const hello = await db.admin().command({ hello: 1 });
		assert.ok(hello.setName, 'A real replica set is required; standalone is not qualified');
		await parents.insertOne(record('initialize', { title: 'Initialize' }));
		await children.insertOne(record('initialize', { link: null }));
	});
	beforeEach(async () => {
		await parents.deleteMany({});
		await children.deleteMany({});
	});
	afterEach(() =>
		assert.ok(
			sessions.every((session) => session.hasEnded),
			'Native sessions must always end'
		)
	);
	after(async () => {
		await parents.deleteMany({});
		await children.deleteMany({});
	});

	for (const policy of ['restrict', 'cascade', 'set-null'] as const) {
		it(`${policy} enforces referential deletion atomically`, async () => {
			const repo = setup(policy);
			await repo.parent.insert(record('parent', { title: 'Parent' }));
			await repo.child.insert(record('child', { link: 'parent' }));
			if (policy === 'restrict') {
				await assert.rejects(repo.parent.remove(scope, 'parent', 1));
				assert.equal((await parents.findOne({ _id: 'parent' }))?.deleted, false);
				assert.equal((await children.findOne({ _id: 'child' }))?.version, 1);
			} else {
				assert.equal(await repo.parent.remove(scope, 'parent', 1), true);
				assert.equal((await parents.findOne({ _id: 'parent' }))?.deleted, true);
				const child = await children.findOne({ _id: 'child' });
				assert.equal(child?.version, 2);
				assert.equal(child?.deleted, policy === 'cascade');
				assert.deepEqual(child?.data, policy === 'cascade' ? {} : { link: null });
			}
		});
	}

	it('rolls back already-written child changes when root deletion fails', async () => {
		const failure = new Error('review-induced root failure');
		const repo = setup('cascade', (real) => ({
			modules: real.modules,
			run: (candidate, work) =>
				real.run(candidate, (tx) =>
					work({
						...tx,
						remove: async (module, ...args) => {
							if (module === 'relationparents') throw failure;
							return tx.remove(module, ...args);
						}
					})
				)
		}));
		await repo.parent.insert(record('parent', { title: 'Parent' }));
		await repo.child.insert(record('child', { link: 'parent' }));
		await assert.rejects(repo.parent.remove(scope, 'parent', 1), (error) => error === failure);
		assert.equal((await parents.findOne({ _id: 'parent' }))?.deleted, false);
		assert.equal((await children.findOne({ _id: 'child' }))?.deleted, false);
		assert.equal((await children.findOne({ _id: 'child' }))?.version, 1);
	});

	it('rejects cross-owner and cross-tenant references without writes', async () => {
		const repo = setup('cascade');
		await repo.parent.insert(record('parent', { title: 'Parent' }));
		await assert.rejects(repo.child.insert({ ...record('other-owner', { link: 'parent' }), ownerId: 'other-owner' }));
		await assert.rejects(
			repo.child.insert({ ...record('other-tenant', { link: 'parent' }), tenantId: 'other-tenant' })
		);
		assert.equal(await children.countDocuments({}), 0);
	});

	it('serializes concurrent reference insertion behind deletion, preventing phantom orphan', async () => {
		let entered!: () => void, release!: () => void;
		const paused = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const continueDelete = new Promise<void>((resolve) => {
			release = resolve;
		});
		let gate = true;
		const repo = setup('restrict', (real) => ({
			modules: real.modules,
			run: (candidate, work) =>
				real.run(candidate, (tx) =>
					work({
						...tx,
						references: async (...args) => {
							const rows = await tx.references(...args);
							if (gate) {
								gate = false;
								entered();
								await continueDelete;
							}
							return rows;
						}
					})
				)
		}));
		await repo.parent.insert(record('parent', { title: 'Parent' }));
		const deleting = repo.parent.remove(scope, 'parent', 1);
		await paused;
		// Start the conflicting writer while deletion owns the scope fence, then let it commit.
		const inserting = repo.child.insert(record('racing-child', { link: 'parent' }));
		const insertionResult = inserting.then(
			() => 'inserted',
			() => 'rejected'
		);
		let whileLocked: string;
		try {
			// Fence initialization itself may wait before the native session starts.
			// A writer without shared serialization would resolve during this held absence check.
			whileLocked = await Promise.race([
				insertionResult,
				new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 150))
			]);
		} finally {
			release();
		}
		assert.equal(await deleting, true);
		assert.equal(whileLocked, 'pending', 'Reference writer must wait for the deletion fence');
		assert.equal(await insertionResult, 'rejected');
		assert.equal(await children.countDocuments({ deleted: false }), 0);
		assert.equal((await parents.findOne({ _id: 'parent' }))?.deleted, true);
	});
});

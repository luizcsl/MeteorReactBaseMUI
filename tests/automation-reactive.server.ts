/// <reference types="mocha" />
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { registerRecipe } from '../imports/core/recipes/server/register';
import { createMeteorOwnerIdentityAdapter } from '../imports/core/recipes/server/meteorIdentity';
import type { RecipeDTO } from '../imports/core/recipes/server/engine';

if (Meteor.isServer) describe('automation reactive recipe over real authenticated DDP/Mongo', function () {
	this.timeout(30000);
	it('scopes and projects snapshots, updates reactively, and retracts them on live account-profile revocation', async function () {
		const { Accounts } = require('meteor/accounts-base');
		const { DDP } = require('meteor/ddp-client');
		const { Random } = require('meteor/random');
		const profiles = new Mongo.Collection<{ _id: string; accountId: string; status: string }>('automation_identity_fixture');
		registerRecipe({ schemaVersion: 1, name: 'automationreactivefixture', profile: 'owner',
			fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
			filters: ['title'], states: ['draft'], transitions: [], permissions: { read: ['owner'], write: ['owner'] }
		}, createMeteorOwnerIdentityAdapter(profiles));
		const connections: any[] = [], accounts: string[] = [];
		const call = (connection: any, method: string, ...args: unknown[]) => new Promise<any>((resolve, reject) =>
			connection.call(method, ...args, (error: unknown, result: unknown) => error ? reject(error) : resolve(result)));
		const waitFor = async (predicate: () => Promise<boolean>, message: string) => {
			const deadline = Date.now() + 8000;
			while (!await predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
		};
		try {
			for (const actor of ['alice', 'bob']) {
				const id = `automation-${actor}-${Random.id()}`;
				accounts.push(id);
				await Meteor.users.insertAsync({ _id: id, emails: [{ address: `${id}@example.test`, verified: true }] });
				await profiles.insertAsync({ _id: id, accountId: id, status: 'active' });
				const token = Accounts._generateStampedLoginToken(); await Accounts._insertLoginToken(id, token);
				const connection = DDP.connect(Meteor.absoluteUrl(), { retry: false }); connections.push(connection);
				await call(connection, 'login', { resume: token.token });
			}
			const alice = connections[0], bob = connections[1];
			const created = await call(alice, 'automationreactivefixture.create', { data: { title: 'Alice private' }, parentId: null, mutationId: 'alice-create' });
			await call(bob, 'automationreactivefixture.create', { data: { title: 'Bob private' }, parentId: null, mutationId: 'bob-create' });
			const received = new Mongo.Collection<{ _id: string; rows: RecipeDTO[] }>('recipe_view_automationreactivefixture', { connection: alice });
			let stopError: unknown;
			const handle: any = await new Promise((resolve, reject) => {
				const subscription = alice.subscribe('automationreactivefixture.records', { subscriptionId: 'alice-snapshot', query: { filters: {}, limit: 10 } }, {
					onReady() { resolve(subscription); }, onStop(error: unknown) { stopError = error; if (error) reject(error); }
				});
			});
			const snapshot = await received.findOneAsync('alice-snapshot');
			assert.equal(snapshot?.rows.length, 1); assert.equal(snapshot?.rows[0].id, created.id);
			assert.deepEqual(Object.keys(snapshot!.rows[0]).sort(), ['data', 'id', 'parentId', 'state', 'version']);
			assert.equal(JSON.stringify(snapshot).includes('Bob private'), false);
			await call(alice, 'automationreactivefixture.update', { id: created.id, version: 1, data: { title: 'Updated private' } });
			await waitFor(async () => (await received.findOneAsync('alice-snapshot'))?.rows[0]?.data.title === 'Updated private', 'live update never arrived');
			// Trusted maintenance may change scope without a version increment. Revalidate those changes too.
			const records = profiles.rawDatabase().collection('recipe_automationreactivefixture');
			await records.updateOne({ _id: created.id }, { $set: { ownerId: accounts[1] } });
			await waitFor(async () => (await received.findOneAsync('alice-snapshot'))?.rows.length === 0, 'raw owner reassignment must retract prior owner data');
			await records.updateOne({ _id: created.id }, { $set: { ownerId: accounts[0] } });
			await waitFor(async () => (await received.findOneAsync('alice-snapshot'))?.rows[0]?.id === created.id, 'restored owner scope should refresh');
			await records.updateOne({ _id: created.id }, { $set: { tenantId: 'foreign-team' } });
			await waitFor(async () => (await received.findOneAsync('alice-snapshot'))?.rows.length === 0, 'raw tenant reassignment must retract personal-scope data');
			await records.updateOne({ _id: created.id }, { $unset: { tenantId: '' } });
			await waitFor(async () => (await received.findOneAsync('alice-snapshot'))?.rows[0]?.id === created.id, 'restored tenant scope should refresh');
			await profiles.rawCollection().updateOne({ _id: accounts[0] }, { $set: { status: 'disabled' } });
			await waitFor(async () => !await received.findOneAsync('alice-snapshot'), 'revoked snapshot must disappear');
			await waitFor(async () => !!stopError, 'revoked subscription must terminate');
			await assert.rejects(call(alice, 'automationreactivefixture.list', { filters: {}, limit: 10 }), { error: 'forbidden' });
			handle.stop();
		} finally {
			for (const connection of connections) connection.close();
			await profiles.removeAsync({ accountId: { $in: accounts } });
			await Meteor.users.removeAsync({ _id: { $in: accounts } });
			await profiles.rawDatabase().collection('recipe_automationreactivefixture').deleteMany({ ownerId: { $in: accounts } });
		}
	});
});

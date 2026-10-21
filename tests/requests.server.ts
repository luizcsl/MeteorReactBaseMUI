/// <reference types="mocha" />
/** Real DDP + Mongo journey. Synthetic account/assignment fixtures only. */
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';
import { activeAccountContext } from '../imports/core/server/identity';
import { registerOperation } from '../imports/core/server/meteor';
import { createRequestOperations } from '../imports/modules/requests/server/operations';
import { requestRepository, RequestsCollection } from '../imports/modules/requests/server/repository';
import { RequestAssignments, requestReviewer } from '../imports/modules/requests/server/assignments';
import type { RequestDto } from '../imports/modules/requests/contracts';
if (Meteor.isServer)
	describe('request journey over authenticated DDP and real Mongo', function () {
		this.timeout(30000);
		const connections: Record<string, any> = {},
			ids: Record<string, string> = {},
			active = new Set<string>();
		const call = (actor: string, method: string, ...args: unknown[]) =>
			new Promise<any>((resolve, reject) =>
				connections[actor].call('requestjourney.' + method, ...args, (error: unknown, result: unknown) =>
					error ? reject(error) : resolve(result)
				)
			);
		before(async () => {
			const { Accounts } = require('meteor/accounts-base'),
				{ DDP } = require('meteor/ddp-client'),
				{ Random } = require('meteor/random');
			for (const actor of ['alice', 'reviewer', 'outsider']) {
				const id = 'journey-' + Random.id();
				ids[actor] = id;
				active.add(id);
				await Meteor.users.insertAsync({ _id: id, emails: [{ address: id + '@example.test', verified: true }] });
				const token = Accounts._generateStampedLoginToken();
				await Accounts._insertLoginToken(id, token);
				connections[actor] = DDP.connect(Meteor.absoluteUrl(), { retry: false });
				await new Promise<void>((resolve, reject) =>
					connections[actor].call('login', { resume: token.token }, (error: unknown) =>
						error ? reject(error) : resolve()
					)
				);
			}
			connections.anonymous = DDP.connect(Meteor.absoluteUrl(), { retry: false });
			await RequestAssignments.insertAsync({ _id: ids.alice, reviewerId: ids.reviewer, active: true });
			const isActive = async (id: string) => active.has(id) && Boolean(await Meteor.users.findOneAsync(id));
			const ops = createRequestOperations({
				repository: requestRepository,
				assignedReviewer: requestReviewer(isActive)
			});
			const context = activeAccountContext(isActive, () => 'request-journey-test');
			registerOperation({ ...ops.create, name: 'requestjourney.create' }, context);
			registerOperation({ ...ops.get, name: 'requestjourney.get' }, context);
			registerOperation({ ...ops.list, name: 'requestjourney.list' }, context);
			registerOperation({ ...ops.addItem, name: 'requestjourney.addItem' }, context);
			registerOperation({ ...ops.submit, name: 'requestjourney.submit' }, context);
			registerOperation({ ...ops.decide, name: 'requestjourney.decide' }, context);
		});
		after(async () => {
			for (const connection of Object.values(connections)) connection.close();
			await RequestsCollection.removeAsync({ ownerId: ids.alice });
			await RequestAssignments.removeAsync({ _id: ids.alice });
			await Meteor.users.removeAsync({ _id: { $in: Object.values(ids) } });
		});
		it('persists items, submission, separate decision and history through the real wire', async () => {
			const row: RequestDto = await call('alice', 'create', { title: 'Office supplies', mutationId: 'journey' });
			const added: RequestDto = await call('alice', 'addItem', {
				id: row.id,
				version: 1,
				item: { description: 'Paper', quantity: 2, unitPrice: 1010 }
			});
			assert.equal(added.total, 2020);
			await call('alice', 'submit', { id: row.id, version: 2 });
			await assert.rejects(call('alice', 'decide', { id: row.id, version: 3, decision: 'approved' }), {
				error: 'forbidden'
			});
			await assert.rejects(call('outsider', 'get', { id: row.id }), { error: 'not-found' });
			const approved: RequestDto = await call('reviewer', 'decide', { id: row.id, version: 3, decision: 'approved' });
			assert.deepEqual(
				approved.history.map((event) => event.action),
				['created', 'item-added', 'submitted', 'approved']
			);
			assert.equal((await call('alice', 'get', { id: row.id })).state, 'approved');
			const stored = await RequestsCollection.findOneAsync(row.id);
			assert.equal(stored?.state, 'approved');
			assert.equal(stored?.history.length, 4);
			assert.equal(stored?.items.length, 1);
			assert.equal('ownerId' in approved, false);
			assert.equal('reviewerId' in approved, false);
			await assert.rejects(
				call('alice', 'addItem', {
					id: row.id,
					version: 4,
					item: { description: 'Frozen', quantity: 1, unitPrice: 1 }
				}),
				{ error: 'forbidden' }
			);
		});
		it('arbitrates concurrent edits and decisions with one winner and no partial history', async () => {
			const row = await call('alice', 'create', { title: 'Concurrent', mutationId: 'concurrent' });
			const edits = await Promise.allSettled(
				[1, 2].map((unitPrice) =>
					call('alice', 'addItem', { id: row.id, version: 1, item: { description: 'Item', quantity: 1, unitPrice } })
				)
			);
			assert.equal(edits.filter((r) => r.status === 'fulfilled').length, 1);
			await call('alice', 'submit', { id: row.id, version: 2 });
			const decisions = await Promise.allSettled(
				['approved', 'rejected'].map((decision) => call('reviewer', 'decide', { id: row.id, version: 3, decision }))
			);
			assert.equal(decisions.filter((r) => r.status === 'fulfilled').length, 1);
			const stored = await RequestsCollection.findOneAsync(row.id);
			assert.equal(stored?.version, 4);
			assert.equal(stored?.history.length, 4);
			assert.equal(stored?.items.length, 1);
		});
		it('rejects anonymous/forged input and current assignment/account revocation', async () => {
			await assert.rejects(call('anonymous', 'list', { limit: 10 }), { error: 'unauthenticated' });
			await assert.rejects(call('alice', 'create', { title: 'Forged', mutationId: 'forged', reviewerId: ids.alice }), {
				error: 'invalid-input'
			});
			const row = await call('alice', 'create', { title: 'Revocation', mutationId: 'revoked' });
			await RequestAssignments.updateAsync(ids.alice, { $set: { active: false } });
			try {
				await assert.rejects(call('reviewer', 'get', { id: row.id }), { error: 'not-found' });
			} finally {
				await RequestAssignments.updateAsync(ids.alice, { $set: { active: true } });
			}
			active.delete(ids.reviewer);
			try {
				await assert.rejects(call('reviewer', 'get', { id: row.id }), { error: 'forbidden' });
			} finally {
				active.add(ids.reviewer);
			}
		});
	});

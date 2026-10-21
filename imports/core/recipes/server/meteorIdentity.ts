import { Meteor } from 'meteor/meteor';
import type { Mongo } from 'meteor/mongo';
import { createOwnerIdentityAdapter } from './identity';
/** Approved owner contract matching the boilerplate: existing account + active immutable accountId-linked profile. */
export function createMeteorOwnerIdentityAdapter(profiles: Mongo.Collection<any>) {
	return createOwnerIdentityAdapter({
		async isActiveAccount(accountId) {
			return !!await Meteor.users.findOneAsync(accountId, { fields: { _id: 1 } }) &&
				!!await profiles.findOneAsync({ accountId, status: 'active' }, { fields: { _id: 1 } });
		},
		async observe(accountId, invalidate) {
			const handles: { stop(): void | Promise<void> }[] = [];
			try {
				const callbacks = { added: invalidate, changed: invalidate, removed: invalidate };
				handles.push(await Meteor.users.find({ _id: accountId }, { fields: { _id: 1 } }).observeChanges(callbacks));
				handles.push(await profiles.find({ accountId }, { fields: { accountId: 1, status: 1 } }).observeChanges(callbacks));
				return { async stop() { await Promise.all(handles.map((handle) => handle.stop())); } };
			} catch (error) { await Promise.all(handles.map((handle) => handle.stop())); throw error; }
		}
	});
}

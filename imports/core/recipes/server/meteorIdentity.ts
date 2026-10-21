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
				// Also detect raw maintenance writes on standalone Mongo without an oplog.
				const accountOptions = { fields: { _id: 1 }, pollingIntervalMs: 1000 };
				const profileOptions = { fields: { accountId: 1, status: 1 }, pollingIntervalMs: 1000 };
				const callbacks = { added: invalidate, changed: invalidate, removed: invalidate };
				handles.push(await Meteor.users.find({ _id: accountId }, accountOptions).observeChanges(callbacks));
				handles.push(await profiles.find({ accountId }, profileOptions).observeChanges(callbacks));
				return { async stop() { await Promise.all(handles.map((handle) => handle.stop())); } };
			} catch (error) { await Promise.all(handles.map((handle) => handle.stop())); throw error; }
		}
	});
}

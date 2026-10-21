import { Meteor } from 'meteor/meteor';

export async function isActiveMediaAccount(accountId: unknown): Promise<boolean> {
	if (typeof accountId !== 'string' || !accountId) return false;
	const { userprofileServerApi } = require('../modules/userprofile/api/userProfileServerApi');
	const [account, profile] = await Promise.all([
		Meteor.users.findOneAsync({ _id: accountId }, { fields: { _id: 1 } }),
		userprofileServerApi.getCollectionInstance().findOneAsync({ accountId, status: 'active' }, { fields: { _id: 1 } })
	]);
	return Boolean(account && profile);
}

export async function watchMediaAccount(accountId: string, stop: () => void) {
	const { userprofileServerApi } = require('../modules/userprofile/api/userProfileServerApi');
	return userprofileServerApi
		.getCollectionInstance()
		.find({ accountId }, { fields: { status: 1 } })
		.observeChangesAsync({
			added: (_id: string, fields: Record<string, unknown>) => {
				if (fields.status !== 'active') stop();
			},
			changed: (_id: string, fields: Record<string, unknown>) => {
				if ('status' in fields && fields.status !== 'active') stop();
			},
			removed: () => stop()
		});
}

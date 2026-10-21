import { markStartupComplete } from './readiness';
import { userprofileServerApi } from '../modules/userprofile/api/userProfileServerApi';
import { exampleServerApi } from '../modules/example/api/exampleServerApi';
import { attachmentsCollection } from '../api/attachmentsCollection';
import { Meteor } from 'meteor/meteor';

Meteor.startup(async () => {
	const userProfiles = userprofileServerApi.getCollectionInstance();
	// Only exact primary-key associations can be migrated automatically. Email
	// and legacy otheraccounts are not proof of account ownership.
	const legacy = await userProfiles.find({ accountId: { $exists: false } }).fetchAsync();
	for (const profile of legacy) {
		const account = await Meteor.users.findOneAsync({ _id: profile._id });
		if (!account) throw new Error('Identity migration requires manual reconciliation of an orphan profile.');
		await userProfiles.updateAsync(
			{ _id: profile._id, accountId: { $exists: false } },
			{
				$set: { accountId: account._id },
				$unset: { services: '', otheraccounts: '' }
			}
		);
	}
	await Promise.all([
		userProfiles.createIndexAsync(
			{ accountId: 1 },
			{ unique: true, partialFilterExpression: { accountId: { $type: 'string' } } }
		),
		userProfiles.createIndexAsync({ email: 1 }),
		userProfiles.createIndexAsync({ username: 1 }),
		userProfiles.createIndexAsync({ status: 1, createdat: -1 }),
		userProfiles.createIndexAsync({ roles: 1 }),
		userProfiles.createIndexAsync({ 'otheraccounts._id': 1 }),
		exampleServerApi.getCollectionInstance().createIndexAsync({ lastupdate: 1, _id: 1 }),
		exampleServerApi.tombstones.createIndexAsync({ deletedAt: 1, _id: 1 }),
		attachmentsCollection.attachments.collection.createIndexAsync({
			'meta.docId': 1,
			'meta.fieldName': 1,
			uploadedAt: 1
		})
	]);
	markStartupComplete('indexes-and-identity');
});

import '../api/attachmentsCollection';
import '../modules/userprofile/api/userProfileServerApi';
import '../modules/example/api/exampleServerApi';
import '../modules/aniversario/api/aniversarioServerApi';

import { Meteor } from 'meteor/meteor';
import { nanoid } from 'nanoid';
import { activeAccountContext } from '../core/server/identity';
import { registerTasks } from '../modules/tasks/server/register';
import { userprofileServerApi } from '../modules/userprofile/api/userProfileServerApi';

const isActiveAccount = async (accountId: string) => {
	const account = await Meteor.users.findOneAsync(accountId, { fields: { _id: 1 } });
	if (!account) return false;
	return Boolean(
		await userprofileServerApi
			.getCollectionInstance()
			.findOneAsync({ accountId, status: 'active' }, { fields: { _id: 1 } })
	);
};
const ownerContext = activeAccountContext(isActiveAccount, nanoid);
registerTasks(ownerContext);

import { registerIntegratedModules } from '../integration/server/register';
registerIntegratedModules();

import { registerRequests } from '../modules/requests/server/register';
registerRequests(ownerContext, isActiveAccount);

import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
/** Server-only provisioning. No publication, client writes, or role-bearing method. */
export const RequestAssignments = new Mongo.Collection<{ _id: string; reviewerId: string; active: boolean }>(
	'ai_request_assignments'
);
RequestAssignments.deny({ insert: () => true, update: () => true, remove: () => true });
export function requestReviewer(isActiveAccount: (id: string) => Promise<boolean>) {
	return async (ownerId: string): Promise<string | null> => {
		const row = await RequestAssignments.findOneAsync({ _id: ownerId, active: true });
		if (
			!row ||
			row.reviewerId === ownerId ||
			!(await Meteor.users.findOneAsync(row.reviewerId, { fields: { _id: 1 } })) ||
			!(await isActiveAccount(ownerId)) ||
			!(await isActiveAccount(row.reviewerId))
		)
			return null;
		return row.reviewerId;
	};
}

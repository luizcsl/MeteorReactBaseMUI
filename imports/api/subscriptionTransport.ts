import { Meteor } from 'meteor/meteor';
/** No implicit count publication: contract subscriptions publish only explicitly projected snapshots. */
export function subscribe(name: string, ...params: any[]) {
	return Meteor.subscribe(name, ...params);
}

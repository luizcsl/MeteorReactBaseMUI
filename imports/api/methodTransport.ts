import { Meteor } from 'meteor/meteor';
/** Shared online-only transport for ApiBase and contract clients. Never simulate a successful offline write. */
export function callMethod<Result = unknown>(name: string, ...params: unknown[]): Promise<Result> {
	if (!Meteor.status().connected) return Promise.reject(new Meteor.Error('offline', 'No server connection'));
	return new Promise((resolve, reject) => Meteor.call(name, ...params, (error: Error | undefined, result: Result) => {
		if (error) reject(error); else resolve(result);
	}));
}

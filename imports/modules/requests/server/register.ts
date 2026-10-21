import { Meteor } from 'meteor/meteor';
import { registerOperation } from '../../../core/server/meteor';
import type { ContextBuilder } from '../../../core/server/operations';
import { createRequestOperations } from './operations';
import { requestRepository, ensureRequestIndexes } from './repository';
import { requestReviewer } from './assignments';
export function registerRequests(context: ContextBuilder, isActiveAccount: (id: string) => Promise<boolean>): void {
	const operations = createRequestOperations({
		repository: requestRepository,
		assignedReviewer: requestReviewer(isActiveAccount)
	});
	registerOperation(operations.create, context);
	registerOperation(operations.get, context);
	registerOperation(operations.list, context);
	registerOperation(operations.addItem, context);
	registerOperation(operations.submit, context);
	registerOperation(operations.decide, context);
	Meteor.startup(ensureRequestIndexes);
}

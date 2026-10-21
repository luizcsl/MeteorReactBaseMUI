import type { Infer, Schema } from '../../../core/contracts/schema';
import type { Operation, TrustedContext } from '../../../core/server/operations';
import { OperationError } from '../../../core/contracts/errors';
import {
	REQUEST_METHODS,
	requestCreate,
	requestGet,
	requestList,
	requestAddItem,
	requestSubmit,
	requestDecide,
	requestDto,
	requestPage
} from '../contracts';
import { requestService, type RequestPorts } from './service';
export function createRequestOperations(ports: RequestPorts) {
	const service = requestService(ports);
	const policy = async (ctx: TrustedContext) => {
		if (!ctx.userId) throw new OperationError('unauthenticated');
	};
	function operation<I, O>(
		name: string,
		input: Schema<I>,
		output: Schema<O>,
		effect: 'read' | 'write',
		handler: (ctx: TrustedContext, input: I) => Promise<O>
	): Operation<I, O> {
		return { name, input, output, effect, policy, handler };
	}
	return {
		create: operation(REQUEST_METHODS.create, requestCreate, requestDto, 'write', (ctx, input) =>
			service.create(ctx.userId, input)
		),
		get: operation(REQUEST_METHODS.get, requestGet, requestDto, 'read', (ctx, input) =>
			service.get(ctx.userId, input.id)
		),
		list: operation(REQUEST_METHODS.list, requestList, requestPage, 'read', (ctx, input) =>
			service.list(ctx.userId, input.limit)
		),
		addItem: operation(REQUEST_METHODS.addItem, requestAddItem, requestDto, 'write', (ctx, input) =>
			service.addItem(ctx.userId, input)
		),
		submit: operation(REQUEST_METHODS.submit, requestSubmit, requestDto, 'write', (ctx, input) =>
			service.submit(ctx.userId, input)
		),
		decide: operation(REQUEST_METHODS.decide, requestDecide, requestDto, 'write', (ctx, input) =>
			service.decide(ctx.userId, input)
		)
	};
}

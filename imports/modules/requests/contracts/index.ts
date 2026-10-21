import {
	array,
	enumeration,
	id,
	integer,
	strictObject,
	string,
	ContractError,
	type Infer
} from '../../../core/contracts/schema';
import { requestItem } from '../../requestitems/contracts';
export const requestState = enumeration(['draft', 'submitted', 'approved', 'rejected'] as const);
export const requestEvent = strictObject({
	version: integer(1, 200),
	action: enumeration(['created', 'item-added', 'submitted', 'approved', 'rejected'] as const),
	at: integer(0),
	actor: enumeration(['requester', 'reviewer'] as const)
});
const boolean = {
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new ContractError('Expected boolean');
		return value;
	}
};
export const requestDto = strictObject({
	id,
	title: string(1, 200),
	state: requestState,
	version: integer(1, 200),
	items: array(requestItem, 30),
	total: integer(0, 3_000_000_000_000),
	history: array(requestEvent, 200),
	canEdit: boolean,
	canReview: boolean
});
export type RequestDto = Infer<typeof requestDto>;
export const requestCreate = strictObject({ mutationId: id, title: string(1, 200) });
export const requestGet = strictObject({ id });
export const requestAddItem = strictObject({ id, version: integer(1, 199), item: requestItem });
export const requestSubmit = strictObject({ id, version: integer(1, 199) });
export const requestDecide = strictObject({
	id,
	version: integer(1, 199),
	decision: enumeration(['approved', 'rejected'] as const)
});
export const requestList = strictObject({ limit: integer(1, 100) });
export const requestPage = array(requestDto, 100);
export const REQUEST_METHODS = {
	create: 'requests.create',
	get: 'requests.get',
	list: 'requests.list',
	addItem: 'requests.addItem',
	submit: 'requests.submit',
	decide: 'requests.decide'
} as const;

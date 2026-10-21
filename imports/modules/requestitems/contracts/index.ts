import { integer, strictObject, string, type Infer } from '../../../core/contracts/schema';
export const requestItem = strictObject({
	description: string(1, 200),
	quantity: integer(1, 1000),
	unitPrice: integer(0, 100_000_000)
});
export type RequestItem = Infer<typeof requestItem>;
export function itemTotal(items: readonly RequestItem[]): number {
	return items.reduce((sum, raw) => {
		const item = requestItem.parse(raw);
		return sum + item.quantity * item.unitPrice;
	}, 0);
}

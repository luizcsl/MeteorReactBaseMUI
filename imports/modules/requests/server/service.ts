import { createHash } from 'node:crypto';
import { OperationError } from '../../../core/contracts/errors';
import type { Infer } from '../../../core/contracts/schema';
import { itemTotal, requestItem } from '../../requestitems/contracts';
import { requestDto, type RequestDto, type requestCreate, type requestAddItem, type requestDecide } from '../contracts';
export interface RequestRecord {
	_id: string;
	ownerId: string;
	reviewerId: string;
	creationTitle: string;
	title: string;
	state: RequestDto['state'];
	version: number;
	items: RequestDto['items'];
	history: RequestDto['history'];
}
export interface RequestRepository {
	insert(row: RequestRecord): Promise<RequestRecord>;
	get(userId: string, id: string): Promise<RequestRecord | null>;
	list(userId: string, limit: number): Promise<RequestRecord[]>;
	compareAndSet(
		userId: string,
		id: string,
		version: number,
		next: Pick<RequestRecord, 'items' | 'history' | 'state' | 'version'>
	): Promise<boolean>;
}
export interface RequestPorts {
	repository: RequestRepository;
	/** Server-owned, active requester → reviewer assignment, reloaded for every operation. */
	assignedReviewer: (ownerId: string) => Promise<string | null>;
	now?: () => number;
}
export function requestService(ports: RequestPorts) {
	const now = ports.now ?? Date.now;
	const project = (userId: string, row: RequestRecord): RequestDto =>
		requestDto.parse({
			id: row._id,
			title: row.title,
			state: row.state,
			version: row.version,
			items: row.items,
			total: itemTotal(row.items),
			history: row.history,
			canEdit: row.ownerId === userId && row.state === 'draft',
			canReview: row.reviewerId === userId && row.ownerId !== userId && row.state === 'submitted'
		});
	async function authorized(userId: string, row: RequestRecord) {
		if (!userId || (row.ownerId !== userId && row.reviewerId !== userId)) throw new OperationError('not-found');
		const reviewer = await ports.assignedReviewer(row.ownerId);
		// Revocation removes reviewer access immediately. Owners retain read access to their records.
		if (userId !== row.ownerId && (reviewer !== userId || row.ownerId === userId))
			throw new OperationError('not-found');
		project(userId, row);
	}
	async function get(userId: string, id: string) {
		const row = await ports.repository.get(userId, id);
		if (!row || row._id !== id) throw new OperationError('not-found');
		await authorized(userId, row);
		return row;
	}
	async function change(
		userId: string,
		id: string,
		version: number,
		action: RequestDto['history'][number]['action'],
		mutate: (row: RequestRecord) => void | Promise<void>
	) {
		const row = await get(userId, id);
		if (row.version !== version || version >= 200) throw new OperationError('conflict');
		await mutate(row);
		const history = [
			...row.history,
			{
				version: version + 1,
				action,
				at: now(),
				actor: action === 'approved' || action === 'rejected' ? ('reviewer' as const) : ('requester' as const)
			}
		];
		const next = { ...row, version: version + 1, history };
		const dto = project(userId, next);
		if (
			!(await ports.repository.compareAndSet(userId, id, version, {
				items: next.items,
				history: next.history,
				state: next.state,
				version: next.version
			}))
		)
			throw new OperationError('conflict');
		return dto;
	}
	return {
		async create(userId: string, input: Infer<typeof requestCreate>) {
			const reviewerId = await ports.assignedReviewer(userId);
			if (!reviewerId || reviewerId === userId) throw new OperationError('forbidden');
			const title = input.title.trim();
			if (!title) throw new OperationError('invalid-input');
			const id = createHash('sha256')
				.update(JSON.stringify(['requests', userId, input.mutationId]))
				.digest('hex');
			const row: RequestRecord = {
				_id: id,
				ownerId: userId,
				reviewerId,
				creationTitle: title,
				title,
				state: 'draft',
				version: 1,
				items: [],
				history: [{ version: 1, action: 'created', at: now(), actor: 'requester' }]
			};
			const stored = await ports.repository.insert(row);
			if (stored._id !== id || stored.ownerId !== userId || stored.creationTitle !== title)
				throw new OperationError('conflict');
			await authorized(userId, stored);
			return project(userId, stored);
		},
		async get(userId: string, id: string) {
			return project(userId, await get(userId, id));
		},
		async list(userId: string, limit: number) {
			const rows = await ports.repository.list(userId, limit);
			if (rows.length > limit) throw new OperationError('forbidden');
			const output: RequestDto[] = [];
			for (const row of rows) {
				if (row.ownerId !== userId && row.reviewerId !== userId) throw new OperationError('forbidden');
				if (row.ownerId !== userId && (await ports.assignedReviewer(row.ownerId)) !== userId) continue;
				await authorized(userId, row);
				output.push(project(userId, row));
			}
			return output;
		},
		async addItem(userId: string, input: Infer<typeof requestAddItem>) {
			return change(userId, input.id, input.version, 'item-added', (row) => {
				if (row.ownerId !== userId || row.state !== 'draft') throw new OperationError('forbidden');
				if (row.items.length >= 30) throw new OperationError('invalid-input');
				row.items = [...row.items, requestItem.parse(input.item)];
			});
		},
		async submit(userId: string, input: { id: string; version: number }) {
			return change(userId, input.id, input.version, 'submitted', async (row) => {
				if ((await ports.assignedReviewer(row.ownerId)) !== row.reviewerId) throw new OperationError('forbidden');
				if (row.ownerId !== userId || row.state !== 'draft') throw new OperationError('forbidden');
				if (!row.items.length) throw new OperationError('invalid-input');
				row.state = 'submitted';
			});
		},
		async decide(userId: string, input: Infer<typeof requestDecide>) {
			return change(userId, input.id, input.version, input.decision, (row) => {
				if (row.reviewerId !== userId || row.ownerId === userId || row.state !== 'submitted')
					throw new OperationError('forbidden');
				row.state = input.decision;
			});
		}
	};
}

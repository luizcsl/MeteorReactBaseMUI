import { createHash, randomUUID } from 'node:crypto';
import type { ServicesConfig } from './runtime';
export interface JobRecord {
	_id: string;
	payload: Record<string, unknown>;
	fingerprint: string;
	state: 'pending' | 'running' | 'done' | 'failed';
	attempts: number;
	availableAt: Date;
	leaseUntil: Date | null;
	leaseToken: string | null;
}
/** Supply an approved persistent MongoDB collection with acknowledged writes (majority recommended).
 * findOneAndUpdate MUST be atomic and return the resulting document (includeResultMetadata:false).
 * No memory fallback is provided. Methods are server-worker only, not remote methods.
 */
export interface DurableCollection {
	createIndex(keys: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<unknown>;
	updateOne(
		selector: Record<string, unknown>,
		update: Record<string, unknown>,
		options?: Record<string, unknown>
	): Promise<{ matchedCount: number; upsertedCount?: number }>;
	findOne(selector: Record<string, unknown>): Promise<JobRecord | null>;
	findOneAndUpdate(
		selector: Record<string, unknown>,
		update: Record<string, unknown>,
		options: Record<string, unknown>
	): Promise<JobRecord | null>;
}
export function durableJobs(config: NonNullable<ServicesConfig['jobs']>, collection: DurableCollection) {
	let ready = false;
	const check = () => {
		if (!ready) throw new Error('Initialize durable queue indexes before use');
	};
	return {
		async initialize() {
			await collection.createIndex({ state: 1, availableAt: 1, leaseUntil: 1 });
			ready = true;
		},
		async enqueue(key: string, payload: Record<string, unknown>, now = new Date()) {
			check();
			if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !payload || Object.getPrototypeOf(payload) !== Object.prototype)
				throw new Error('Invalid job');
			const encoded = JSON.stringify(payload);
			if (encoded.length > 65536) throw new Error('Job payload too large');
			const fingerprint = createHash('sha256').update(encoded).digest('hex');
			// _id unique index provides race-safe idempotency; concurrent upsert duplicate-key is re-read.
			try {
				await collection.updateOne(
					{ _id: key },
					{
						$setOnInsert: {
							_id: key,
							payload: JSON.parse(encoded),
							fingerprint,
							state: 'pending',
							attempts: 0,
							availableAt: now,
							leaseUntil: null,
							leaseToken: null
						}
					},
					{ upsert: true }
				);
			} catch (error) {
				if ((error as { code?: number }).code !== 11000) throw error;
			}
			const job = await collection.findOne({ _id: key });
			if (!job || job.fingerprint !== fingerprint) throw new Error('Job idempotency conflict');
			return { id: job._id, state: job.state };
		},
		async runOne(
			handler: (
				payload: Record<string, unknown>,
				context: { idempotencyKey: string; leaseToken: string }
			) => Promise<void>,
			now = new Date()
		) {
			check();
			// Exhausted crashed workers are terminalized before reclaiming other work.
			await collection.updateOne(
				{ state: 'running', leaseUntil: { $lte: now }, attempts: { $gte: config.maxAttempts } },
				{ $set: { state: 'failed', leaseToken: null, leaseUntil: null } }
			);
			const token = randomUUID();
			const job = await collection.findOneAndUpdate(
				{
					attempts: { $lt: config.maxAttempts },
					$or: [
						{ state: 'pending', availableAt: { $lte: now } },
						{ state: 'running', leaseUntil: { $lte: now } }
					]
				},
				{
					$set: { state: 'running', leaseToken: token, leaseUntil: new Date(now.getTime() + config.leaseMs) },
					$inc: { attempts: 1 }
				},
				{ sort: { availableAt: 1, _id: 1 }, returnDocument: 'after', includeResultMetadata: false }
			);
			if (!job) return { status: 'idle' as const };
			try {
				await handler(job.payload, { idempotencyKey: job._id, leaseToken: token });
				const result = await collection.updateOne(
					{ _id: job._id, state: 'running', leaseToken: token },
					{ $set: { state: 'done', leaseToken: null, leaseUntil: null } }
				);
				if (result.matchedCount !== 1) return { status: 'lease-lost' as const, id: job._id };
				return { status: 'done' as const, id: job._id };
			} catch {
				const result = await collection.updateOne(
					{ _id: job._id, state: 'running', leaseToken: token },
					{
						$set: {
							state: job.attempts >= config.maxAttempts ? 'failed' : 'pending',
							availableAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** job.attempts)),
							leaseToken: null,
							leaseUntil: null
						}
					}
				);
				return {
					status: result.matchedCount !== 1 ? ('lease-lost' as const) : ('retry-or-failed' as const),
					id: job._id
				};
			}
		},
		async renew(id: string, leaseToken: string, now = new Date()) {
			check();
			const r = await collection.updateOne(
				{ _id: id, state: 'running', leaseToken, leaseUntil: { $gt: now } },
				{ $set: { leaseUntil: new Date(now.getTime() + config.leaseMs) } }
			);
			return r.matchedCount === 1;
		}
	};
}

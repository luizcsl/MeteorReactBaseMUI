import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Per-process fallback is deliberately ephemeral. Multi-replica deployments must
// configure the same signing key; the key itself is never placed in a URL.
const signingKey = process.env.MEDIA_SIGNING_KEY || randomBytes(48).toString('hex');
export const MEDIA_LINK_TTL_SECONDS = 300;
const signature = (payload: string) => createHmac('sha256', signingKey).update(payload).digest('base64url');
export const createMediaCapability = (fileId: string, now = Date.now()) => {
	const expires = Math.floor(now / 1000) + MEDIA_LINK_TTL_SECONDS;
	const payload = Buffer.from(JSON.stringify({ fileId, version: 'original', operation: 'download', expires })).toString(
		'base64url'
	);
	return `${payload}.${signature(payload)}`;
};
export const verifyMediaCapability = (token: unknown, fileId: string, version = 'original', now = Date.now()) => {
	if (typeof token !== 'string' || token.length > 2048) return false;
	const parts = token.split('.');
	if (parts.length !== 2) return false;
	try {
		const actual = Buffer.from(parts[1], 'base64url');
		const expected = Buffer.from(signature(parts[0]), 'base64url');
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
		const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
		const seconds = Math.floor(now / 1000);
		return (
			payload.fileId === fileId &&
			payload.version === version &&
			payload.operation === 'download' &&
			Number.isInteger(payload.expires) &&
			payload.expires > seconds &&
			payload.expires <= seconds + MEDIA_LINK_TTL_SECONDS
		);
	} catch {
		return false;
	}
};

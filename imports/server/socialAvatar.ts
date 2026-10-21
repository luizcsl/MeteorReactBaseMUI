import { lookup } from 'node:dns/promises';
import { get } from 'node:https';

export const isPublicIPv4 = (address: string) => {
	const parts = address.split('.').map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = parts;
	return (
		a !== 0 &&
		a !== 10 &&
		a !== 127 &&
		a < 224 &&
		!(a === 169 && b === 254) &&
		!(a === 172 && b >= 16 && b <= 31) &&
		!(a === 192 && (b === 168 || b === 0 || b === 2)) &&
		!(a === 100 && b >= 64 && b <= 127) &&
		!(a === 198 && (b === 18 || b === 19 || b === 51)) &&
		!(a === 203 && b === 0)
	);
};
export const isAllowedSocialImageUrl = (value: string) => {
	try {
		const url = new URL(value);
		const hosts = (process.env.SOCIAL_IMAGE_ALLOWED_HOSTS || 'googleusercontent.com,graph.facebook.com,fbcdn.net')
			.split(',')
			.map((s) => s.trim().toLowerCase());
		return (
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			(!url.port || url.port === '443') &&
			hosts.some((host) => host && (url.hostname === host || url.hostname.endsWith(`.${host}`)))
		);
	} catch {
		return false;
	}
};
export async function getBase64FromURLImage(value: string): Promise<string> {
	if (!isAllowedSocialImageUrl(value)) throw new Error('Social image URL is not allowed');
	const maxBytes = Number(process.env.SOCIAL_IMAGE_MAX_BYTES || 2 * 1024 * 1024);
	const timeoutMs = Number(process.env.SOCIAL_IMAGE_TIMEOUT_MS || 5000);
	const url = new URL(value);
	// Resolve once and pin the selected public IP. No redirects and no DNS rebinding.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const address = await Promise.race([
			lookup(url.hostname, { family: 4 }),
			new Promise<never>((_, reject) =>
				controller.signal.addEventListener('abort', () => reject(new Error('Avatar timeout')), { once: true })
			)
		]);
		if (!isPublicIPv4(address.address)) throw new Error('Social image address is not public');
		return await new Promise<string>((resolve, reject) => {
			const request = get(
				url,
				{
					signal: controller.signal,
					family: 4,
					lookup: (_hostname, _options, callback) => callback(null, address.address, 4)
				},
				(response) => {
					const mime = String(response.headers['content-type'] || '')
						.split(';')[0]
						.toLowerCase();
					if (
						response.statusCode !== 200 ||
						!['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
						Number(response.headers['content-length'] || 0) > maxBytes
					) {
						response.destroy();
						reject(new Error('Invalid social image response'));
						return;
					}
					const chunks: Buffer[] = [];
					let length = 0;
					response.on('data', (chunk: Buffer) => {
						length += chunk.length;
						if (length > maxBytes) {
							response.destroy();
							reject(new Error('Social image exceeds max allowed size'));
						} else chunks.push(chunk);
					});
					response.on('error', reject);
					response.on('end', async () => {
						try {
							const sharp = (await import('sharp')).default;
							// Re-encode a bounded raster, dropping active content and metadata.
							const output = await sharp(Buffer.concat(chunks), { limitInputPixels: 16_000_000 })
								.resize(512, 512, { fit: 'inside', withoutEnlargement: true })
								.png()
								.toBuffer();
							resolve(`data:image/png;base64,${output.toString('base64')}`);
						} catch (error) {
							reject(error);
						}
					});
				}
			);
			request.on('error', reject);
		});
	} finally {
		clearTimeout(timer);
	}
}

import { open, stat } from 'node:fs/promises';
import sharp from 'sharp';

// Content signatures are a minimum admission check, not a malware scanner.
// Documents are always served as downloads. Images are decoded with a pixel cap.
export async function validateMediaContent(path: string, mime: string, size: number) {
	const info = await stat(path);
	if (!info.isFile() || info.size !== size || size <= 0) throw new Error('Invalid media size');
	const handle = await open(path, 'r');
	const header = Buffer.alloc(Math.min(size, 8192));
	try {
		await handle.read(header, 0, header.length, 0);
	} finally {
		await handle.close();
	}
	const starts = (hex: string) => header.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
	const ascii = (start: number, end: number) => header.toString('ascii', start, end);
	let valid = false;
	if (mime.startsWith('image/')) {
		const formats: Record<string, string[]> = {
			'image/png': ['png'],
			'image/jpeg': ['jpeg'],
			'image/gif': ['gif'],
			'image/webp': ['webp']
		};
		if (!formats[mime]) throw new Error('Image decoder does not support this format');
		const metadata = await sharp(path, { limitInputPixels: 40_000_000, animated: true }).metadata();
		valid = Boolean(
			metadata.format &&
			formats[mime].includes(metadata.format) &&
			metadata.width &&
			metadata.height &&
			metadata.width * metadata.height * (metadata.pages || 1) <= 40_000_000
		);
	} else if (mime === 'application/pdf') valid = ascii(0, 5) === '%PDF-';
	else if (mime.startsWith('text/') || mime === 'application/csv')
		valid = !header.includes(0) && !header.toString('utf8').includes('\uFFFD');
	else if (mime === 'audio/mpeg') valid = ascii(0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
	else if (mime === 'audio/aac') valid = header[0] === 0xff && (header[1] & 0xf6) === 0xf0;
	else if (mime === 'audio/ogg') valid = ascii(0, 4) === 'OggS';
	else if (mime === 'audio/wav' || mime === 'audio/x-wav') valid = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
	else if (mime === 'audio/webm') valid = starts('1a45dfa3');
	else if (mime === 'audio/mp4' || mime === 'audio/x-m4a') valid = ascii(4, 8) === 'ftyp';
	else if (mime.includes('openxmlformats') || mime.includes('oasis.opendocument')) valid = starts('504b0304');
	else if (mime === 'application/msword' || mime === 'application/vnd.ms-excel') valid = starts('d0cf11e0a1b11ae1');
	if (!valid) throw new Error('Media content does not match declared MIME type');
}

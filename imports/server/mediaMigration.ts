import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { attachmentsCollection, isAllowedAttachment } from '../api/attachmentsCollection';
import { validateMediaContent } from './mediaContent';
import { isActiveMediaAccount } from './mediaAccount';

// Operator-only module, intentionally not registered as a DDP/HTTP method.
// Explicit IDs and a bounded batch prevent an accidental whole-store mutation.
export async function revalidateLegacyMedia(input: { ids: string[]; apply?: boolean }) {
	if (
		!Array.isArray(input.ids) ||
		!input.ids.length ||
		input.ids.length > 100 ||
		input.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
	)
		throw new Error('Supply 1-100 explicit attachment IDs');
	const root = await realpath(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads/meteorUploads'));
	const report: Array<{ id: string; result: string }> = [];
	for (const id of input.ids) {
		const file = await attachmentsCollection.attachments.collection.findOneAsync({ _id: id });
		if (!file) {
			report.push({ id, result: 'missing' });
			continue;
		}
		const selector = {
			_id: id,
			path: file.path,
			size: file.size,
			type: file.type,
			versions: file.versions ?? { $exists: false },
			'meta.userId': file.meta?.userId ?? { $exists: false }
		};
		let valid = false;
		try {
			const resolved = await realpath(file.path);
			if (!resolved.startsWith(root + path.sep)) throw new Error('Outside storage');
			const original = file.versions?.original;
			if (
				!original ||
				Object.keys(file.versions).some((version) => version !== 'original') ||
				typeof original.path !== 'string' ||
				(await realpath(original.path)) !== resolved ||
				original.type !== file.type ||
				original.size !== file.size
			)
				throw new Error('Unvalidated download version');
			if (!(await isActiveMediaAccount(file.meta?.userId))) throw new Error('Missing active owner');
			if (!isAllowedAttachment({ name: file.name, mimeType: file.type, size: file.size }))
				throw new Error('Unsupported type');
			await validateMediaContent(resolved, file.type, file.size);
			valid = true;
		} catch {
			/* Invalid or ambiguous legacy media remains quarantined. */
		}
		if (input.apply === true) {
			const count = await attachmentsCollection.attachments.collection.updateAsync(
				selector,
				valid
					? { $set: { 'meta.contentValidated': true }, $unset: { 'meta.quarantined': '' } }
					: { $set: { 'meta.contentValidated': false, 'meta.quarantined': true } }
			);
			report.push({ id, result: count === 1 ? (valid ? 'validated' : 'quarantined') : 'conflict' });
		} else report.push({ id, result: valid ? 'would-validate' : 'would-quarantine' });
	}
	return report;
}

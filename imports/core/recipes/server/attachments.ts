import { OperationError } from '../../contracts/errors';
/** Revalidate BOTH linked document and private file on each access. No global media token. */
export async function authorizeLinkedAttachment(
	userId: string | null,
	documentId: string,
	fileId: string,
	ports: {
		canReadDocument: (userId: string, documentId: string) => Promise<boolean>;
		linked: (documentId: string, fileId: string) => Promise<boolean>;
		canReadFile: (userId: string, fileId: string) => Promise<boolean>;
	}
): Promise<void> {
	if (!userId) throw new OperationError('unauthenticated');
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(documentId) || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId))
		throw new OperationError('invalid-input');
	if (
		!(await ports.canReadDocument(userId, documentId)) ||
		!(await ports.linked(documentId, fileId)) ||
		!(await ports.canReadFile(userId, fileId))
	)
		throw new OperationError('forbidden');
}

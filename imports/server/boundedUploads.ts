import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Meteor } from 'meteor/meteor';

const root = path.join(os.tmpdir(), 'boilerplate-example-uploads-v2');
const expiryMs = 60 * 60 * 1000;
// Local-disk uploads require sticky routing. A shared private volume preserves
// this inter-process lock; multi-host object storage requires its own adapter.
export async function withBoundedUpload<T>(
	ownerKey: string,
	input: {
		assetId: string;
		exampleId: string;
		name: string;
		mimeType: string;
		kind: string;
		size: number;
		checksum: string;
	},
	work: (directory: string) => Promise<T>
) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const lock = path.join(root, '.lock');
	try {
		await mkdir(lock);
		await writeFile(
			path.join(lock, 'owner.json'),
			JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
			{ mode: 0o600 }
		);
	} catch (error: any) {
		if (error.code === 'EEXIST')
			throw new Meteor.Error('upload-busy', 'Outro bloco está sendo processado; tente novamente.');
		throw error;
	}
	try {
		let reservations = 0;
		let ownedReservations = 0;
		for (const owner of await readdir(root, { withFileTypes: true })) {
			if (!owner.isDirectory() || owner.name === '.lock') continue;
			const directory = path.join(root, owner.name);
			for (const entry of await readdir(directory)) {
				if (!entry.endsWith('.json')) continue;
				const metadataPath = path.join(directory, entry);
				const metadataStat = await stat(metadataPath);
				if (Date.now() - metadataStat.mtimeMs > expiryMs) {
					await rm(path.join(directory, entry.replace(/\.json$/, '.part')), { force: true });
					await rm(metadataPath, { force: true });
				} else {
					reservations++;
					if (owner.name === ownerKey) ownedReservations++;
				}
			}
		}
		const directory = path.join(root, ownerKey);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const metadataPath = path.join(directory, `${input.assetId}.json`);
		const metadata = JSON.stringify({
			exampleId: input.exampleId,
			name: input.name,
			mimeType: input.mimeType,
			kind: input.kind,
			size: input.size,
			checksum: input.checksum.toLowerCase()
		});
		const previous = await readFile(metadataPath, 'utf8').catch((error) => {
			if (error.code === 'ENOENT') return null;
			throw error;
		});
		if (previous !== null && previous !== metadata)
			throw new Meteor.Error('upload-metadata-conflict', 'Metadados do upload não podem mudar.');
		if (previous === null && (reservations >= 100 || ownedReservations >= 3))
			throw new Meteor.Error('upload-quota', 'Limite de uploads temporários atingido.');
		await writeFile(metadataPath, metadata, { mode: 0o600 });
		const result = await work(directory);
		if (!(await stat(path.join(directory, `${input.assetId}.part`)).catch(() => null)))
			await rm(metadataPath, { force: true });
		return result;
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

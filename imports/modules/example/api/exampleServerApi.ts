import { withBoundedUpload } from '../../../server/boundedUploads';
// region Imports
import { Recurso } from '../config/recursos';
import { exampleSch, IExample } from './exampleSch';
import { userprofileServerApi } from '../../../modules/userprofile/api/userProfileServerApi';
import { ProductServerBase } from '../../../api/productServerBase';
import { getMediaAccessQuery } from '../../../api/serverBase';
import { attachmentsCollection, isAllowedAttachment, MAX_UPLOAD_BYTES } from '../../../api/attachmentsCollection';
import { segurancaApi } from '../../../security/api/segurancaApi';
import { IContext } from '../../../typings/IContext';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { createHash } from 'crypto';
import { EJSON } from 'meteor/ejson';

// endregion

type AssetKind = 'image' | 'audio' | 'attachment';

interface IUploadAssetChunk {
	assetId: string;
	exampleId: string;
	name: string;
	mimeType: string;
	kind: AssetKind;
	size: number;
	checksum: string;
	offset: number;
	data: string;
	isLast: boolean;
}

class ExampleServerApi extends ProductServerBase<IExample> {
	readonly tombstones = new Mongo.Collection<{ _id?: string; documentId: string; deletedAt: Date }>(
		'example_sync_tombstones'
	);

	constructor() {
		super('example', exampleSch, {
			resources: Recurso
			// saveImageToDisk: true,
		});

		this.addTransformedPublication(
			'exampleList',
			(filter = {}) => {
				return this.defaultListCollectionPublication(filter, {
					projection: { title: 1, type: 1, typeMulti: 1, createdat: 1 }
				});
			},
			async (doc: IExample & { nomeUsuario: string }) => {
				await userprofileServerApi.getCollectionInstance().findOneAsync({ _id: doc.createdby });
				return { ...doc };
			}
		);

		this.addPublication('exampleDetail', (filter = {}) => {
			return this.defaultDetailCollectionPublication(filter, {
				projection: {
					contacts: 1,
					title: 1,
					description: 1,
					type: 1,
					typeMulti: 1,
					date: 1,
					files: 1,
					images: 1,
					audios: 1,
					chip: 1,
					statusRadio: 1,
					statusToggle: 1,
					slider: 1,
					check: 1,
					address: 1,
					image: 1,
					audio: 1
				}
			});
		});

		this.registerMethod('mobilePull', this.mobilePull.bind(this), 1, 0);
		this.registerMethod('mobileAssetsPage', this.mobileAssetsPage.bind(this), 1, 0);
		this.registerMethod('mobileGet', this.mobileGet.bind(this));
		this.registerMethod('mobileUpsert', this.mobileUpsert.bind(this));
		this.registerMethod('uploadAssetChunk', this.uploadAssetChunk.bind(this));
		this.registerMethod('removeAsset', this.removeAsset.bind(this));
	}

	private assertExperimentalSync() {
		if (process.env.EXPERIMENTAL_EXAMPLE_SYNC !== 'true') {
			throw new Meteor.Error(
				'experimental-sync-disabled',
				'Example offline sync is disabled until transport and change-log qualification.'
			);
		}
	}

	/** Every Example update, including online CRUD and asset touches, uses this atomic revision. */
	private async commitRevision(
		id: string,
		fields: Record<string, unknown>,
		unset: string[] = [],
		expectedRevision?: number,
		receipt?: { id: string; actor: string; hash: string }
	) {
		const set: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(fields)) {
			if (!['_id', '_syncRevision', '_syncMutations', 'lastupdate'].includes(key)) set[key] = { $literal: value };
		}
		set._syncRevision = { $add: [{ $ifNull: ['$_syncRevision', 0] }, 1] };
		set.lastupdate = { $max: ['$$NOW', { $add: [{ $ifNull: ['$lastupdate', new Date(0)] }, 1] }] };
		if (receipt)
			set._syncMutations = {
				$slice: [{ $concatArrays: [{ $ifNull: ['$_syncMutations', []] }, { $literal: [receipt] }] }, -100]
			};
		const selector: Record<string, unknown> = { _id: id };
		if (expectedRevision === 0) selector.$or = [{ _syncRevision: 0 }, { _syncRevision: { $exists: false } }];
		else if (expectedRevision !== undefined) selector._syncRevision = expectedRevision;
		const safeUnset = unset.filter((key) => !['_id', '_syncRevision', '_syncMutations', 'lastupdate'].includes(key));
		const pipeline: Record<string, unknown>[] = [{ $set: set }];
		if (safeUnset.length) pipeline.push({ $unset: safeUnset });
		const result = await this.getCollectionInstance().rawCollection().updateOne(selector, pipeline);
		return result.matchedCount;
	}

	async serverInsert(document: Partial<IExample>, context: IContext) {
		this.assertNoLegacyTransaction(context);
		if (!(await this.beforeInsert(document, context))) return null;
		const prepared = this._checkDataBySchema(document, this.auditFields);
		await this._includeAuditData(prepared, 'insert');
		const id = await this.getCollectionInstance().insertAsync({
			...prepared,
			...(document._id ? { _id: document._id } : {}),
			_syncRevision: 1
		});
		await this.afterInsert({ ...prepared, _id: id }, context);
		if (context.rest) context.rest.response.statusCode = 201;
		return id;
	}

	async serverUpdate(document: Partial<IExample>, context: IContext) {
		this.assertNoLegacyTransaction(context);
		if (typeof document?._id !== 'string') throw new Meteor.Error('invalid-document');
		if (!(await this.beforeUpdate(document, context))) return null;
		const prepared = this._checkDataBySchema(document, this.auditFields);
		const current = await this.getCollectionInstance().findOneAsync({ _id: document._id });
		if (!current) return 0;
		const unset: Record<string, string> = {};
		const fields = this._prepareDocForUpdate(prepared as IExample, current, unset);
		fields.updatedby = context.user._id;
		const result = await this.commitRevision(document._id, fields, Object.keys(unset), current._syncRevision ?? 0);
		if (!result) throw new Meteor.Error('sync-conflict', 'The document changed during the update.');
		if (result) await this.afterUpdate({ ...prepared, _id: document._id } as IExample, context);
		return result;
	}

	async serverRemove(document: Partial<IExample>, context: IContext) {
		this.assertNoLegacyTransaction(context);
		if (process.env.EXPERIMENTAL_EXAMPLE_SYNC === 'true') {
			throw new Meteor.Error(
				'experimental-sync-delete-unsupported',
				'Deletion requires an atomic tombstone/change-log transaction.'
			);
		}
		return super.serverRemove(document, context);
	}

	private assertCanView(context: IContext) {
		segurancaApi.validarAcessoRecursos(context.user, [Recurso.EXAMPLE_VIEW]);
	}

	private assetKind(fieldName: string, mimeType: string): AssetKind {
		if (fieldName === 'images' || mimeType.startsWith('image/')) return 'image';
		if (fieldName === 'audios' || mimeType.startsWith('audio/')) return 'audio';
		return 'attachment';
	}

	private serializeAsset(file: any) {
		const mimeType = file.type || file['mime-type'] || 'application/octet-stream';
		return {
			_id: file._id,
			exampleId: file.meta?.docId,
			kind: file.meta?.kind || this.assetKind(file.meta?.fieldName || '', mimeType),
			name: file.name,
			mimeType,
			size: file.size || 0,
			checksum: file.meta?.checksum,
			createdAt: file.uploadedAt,
			status: 'available',
			url: attachmentsCollection.getFileLink(file)
		};
	}

	private legacyAssets(doc: any) {
		const date = doc.lastupdate?.toISOString?.() || '1';
		const query = `${getMediaAccessQuery()}date=${encodeURIComponent(date)}`;
		const assets: any[] = [];
		if (doc.image && doc.image !== '-') {
			assets.push({
				_id: `legacy-image-${doc._id}`,
				exampleId: doc._id,
				kind: 'image',
				name: 'imagem.jpg',
				mimeType: 'image/jpeg',
				size: 0,
				createdAt: doc.createdat,
				status: 'available',
				url: `${Meteor.absoluteUrl()}img/example/image/${doc._id}?${query}`
			});
		}
		if (doc.audio && doc.audio !== '-') {
			assets.push({
				_id: `legacy-audio-${doc._id}`,
				exampleId: doc._id,
				kind: 'audio',
				name: 'audio.ogg',
				mimeType: 'audio/ogg',
				size: 0,
				createdAt: doc.createdat,
				status: 'available',
				url: `${Meteor.absoluteUrl()}audio/example/audio/${doc._id}?${query}`
			});
		}
		return assets;
	}

	async mobilePull(
		options: {
			since?: Date | { documents: { at: Date; id: string }; deletions: { at: Date; id: string }; until?: Date };
		} = {},
		context: IContext
	) {
		this.assertCanView(context);
		this.assertExperimentalSync();
		const since = options.since;
		const composite = since && !(since instanceof Date) && typeof since === 'object' ? since : undefined;
		const checkpoint = (value?: { at: Date; id: string }) => {
			const at = new Date(value?.at ?? (composite ? 0 : ((since as Date | undefined) ?? 0)));
			const id = value?.id ?? '';
			if (!Number.isFinite(at.getTime()) || typeof id !== 'string' || id.length > 120) {
				throw new Meteor.Error('invalid-cursor', 'Cursor de sincronização inválido.');
			}
			return { at, id };
		};
		const documentsAfter = checkpoint(composite?.documents);
		const deletionsAfter = checkpoint(composite?.deletions);
		const until = new Date(composite?.until ?? Date.now() - 1);
		if (!Number.isFinite(until.getTime()) || until.getTime() > Date.now()) throw new Meteor.Error('invalid-cursor');
		const selector = (field: string, after: { at: Date; id: string }) => ({
			$and: [
				{ [field]: { $lte: until } },
				{ $or: [{ [field]: { $gt: after.at } }, { [field]: after.at, _id: { $gt: after.id } }] }
			]
		});
		const documentPage = await this.getCollectionInstance()
			.find(selector('lastupdate', documentsAfter), { limit: 501, sort: { lastupdate: 1, _id: 1 } })
			.fetchAsync();
		const deletedPage = await this.tombstones
			.find(selector('deletedAt', deletionsAfter), { limit: 501, sort: { deletedAt: 1, _id: 1 } })
			.fetchAsync();
		const documents = documentPage.slice(0, 500);
		const deleted = deletedPage.slice(0, 500);
		const hasMore = documentPage.length > 500 || deletedPage.length > 500;
		const lastDocument = documents[documents.length - 1];
		const lastDeletion = deleted[deleted.length - 1];
		return {
			cursor: {
				documents: lastDocument ? { at: lastDocument.lastupdate, id: lastDocument._id } : documentsAfter,
				deletions: lastDeletion ? { at: lastDeletion.deletedAt, id: lastDeletion._id } : deletionsAfter,
				...(hasMore ? { until } : {})
			},
			hasMore,
			documents: documents.map((doc: IExample) => this.safeSyncDocument(doc)),
			deletedIds: deleted.map((item) => item.documentId)
		};
	}

	private safeSyncDocument(document: any) {
		const { image, audio, _syncMutations, ...safe } = document;
		return safe;
	}

	async mobileGet(input: { _id: string }, context: IContext) {
		this.assertCanView(context);
		if (!input?._id) throw new Meteor.Error('invalid-document', 'Identificador obrigatório.');
		const document = await this.getCollectionInstance().findOneAsync({ _id: input._id });
		if (!document) throw new Meteor.Error('document-not-found', 'Documento não encontrado.');
		return this.safeSyncDocument(document);
	}

	async mobileAssetsPage(
		options: {
			fileCursor?: string;
			legacyCursor?: string;
			limit?: number;
			skipFiles?: boolean;
			skipLegacy?: boolean;
		} = {},
		context: IContext
	) {
		this.assertCanView(context);
		const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 250);
		const documentIds = await this.getCollectionInstance().rawCollection().distinct('_id');
		const fileSelector: any = {
			'meta.docId': { $in: documentIds },
			$or: [{ 'meta.module': 'example' }, { 'meta.fieldName': { $in: ['files', 'images', 'audios'] } }]
		};
		if (options.fileCursor) fileSelector._id = { $gt: options.fileCursor };
		const filePage = options.skipFiles
			? []
			: await attachmentsCollection.find(fileSelector, { sort: { _id: 1 }, limit: limit + 1 }).fetchAsync();

		const legacySelector: any = {
			$or: [{ image: { $exists: true, $nin: ['', null, '-'] } }, { audio: { $exists: true, $nin: ['', null, '-'] } }]
		};
		if (options.legacyCursor) legacySelector._id = { $gt: options.legacyCursor };
		const legacyPage = options.skipLegacy
			? []
			: await this.getCollectionInstance()
					.find(legacySelector, {
						projection: { _id: 1, image: 1, audio: 1, lastupdate: 1, createdat: 1 },
						sort: { _id: 1 },
						limit: limit + 1
					})
					.fetchAsync();
		const files = filePage.slice(0, limit);
		const legacyDocuments = legacyPage.slice(0, limit);
		return {
			assets: [
				...files.map((file: any) => this.serializeAsset(file)),
				...legacyDocuments.flatMap((doc: any) => this.legacyAssets(doc))
			],
			fileCursor: files.length ? files[files.length - 1]._id : options.fileCursor || null,
			legacyCursor: legacyDocuments.length
				? legacyDocuments[legacyDocuments.length - 1]._id
				: options.legacyCursor || null,
			filesDone: Boolean(options.skipFiles) || filePage.length <= limit,
			legacyDone: Boolean(options.skipLegacy) || legacyPage.length <= limit
		};
	}

	async mobileUpsert(input: { document: IExample; baseRevision?: number; mutationId: string }, context: IContext) {
		this.assertExperimentalSync();
		// Both view and mutation permission are required before reading or returning any record.
		this.assertCanView(context);
		if (
			!input?.document ||
			!/^[A-Za-z0-9-]{1,120}$/.test(input.document._id || '') ||
			!/^[A-Za-z0-9-]{8,120}$/.test(input.mutationId || '')
		) {
			throw new Meteor.Error('invalid-document', 'Identificador e mutationId são obrigatórios.');
		}
		if ('baseVersion' in input) throw new Meteor.Error('invalid-version', 'Use baseRevision, not a timestamp.');
		const isCreate = input.baseRevision == null;
		if (isCreate) await this.beforeInsert(input.document, context);
		else await this.beforeUpdate(input.document, context);
		const baseRevision = input.baseRevision;
		if (!isCreate && (!Number.isSafeInteger(baseRevision) || baseRevision! < 0))
			throw new Meteor.Error('invalid-version');
		const id = input.document._id!;
		const hash = createHash('sha256')
			.update(EJSON.stringify({ document: input.document, baseRevision }, { canonical: true }))
			.digest('hex');
		const actor = context.user._id;
		if (!actor) throw new Meteor.Error('not-authorized');
		const receipt = { id: input.mutationId, actor, hash };
		const collection = this.getCollectionInstance();
		const conflict = () =>
			new Meteor.Error('sync-conflict', 'O documento foi alterado no servidor. Atualize antes de reenviar.');
		const replay = (doc: any) => {
			const prior = doc?._syncMutations?.find((item: typeof receipt) => item.id === receipt.id);
			if (!prior) return false;
			if (prior.actor !== receipt.actor || prior.hash !== hash) throw new Meteor.Error('mutation-id-conflict');
			return true;
		};
		const current = await collection.findOneAsync({ _id: id });
		if (replay(current)) return this.safeSyncDocument(current);
		const prepared = this._checkDataBySchema(input.document, this.auditFields);
		await this._includeAuditData(prepared, isCreate ? 'insert' : 'update');
		if (!current) {
			if (!isCreate || (await this.tombstones.findOneAsync({ documentId: id }))) throw conflict();
			try {
				await collection.insertAsync({ ...prepared, _id: id, _syncRevision: 1, _syncMutations: [receipt] });
			} catch (error) {
				const winner = await collection.findOneAsync({ _id: id });
				if (replay(winner)) return this.safeSyncDocument(winner);
				if (winner) throw conflict();
				throw error;
			}
		} else {
			if (baseRevision === undefined || (current._syncRevision ?? 0) !== baseRevision) throw conflict();
			const unset: Record<string, string> = {};
			const update = this._prepareDocForUpdate(prepared as IExample, current, unset);
			delete update._id;
			delete unset._id;
			const changed = await this.commitRevision(id, update, Object.keys(unset), baseRevision, receipt);
			if (!changed) {
				const winner = await collection.findOneAsync({ _id: id });
				if (replay(winner)) return this.safeSyncDocument(winner);
				throw conflict();
			}
		}
		return this.safeSyncDocument(await collection.findOneAsync({ _id: id }));
	}

	async uploadAssetChunk(input: IUploadAssetChunk, context: IContext) {
		if (!context.user?._id || context.user.status === 'disabled')
			throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
		const allowedKinds: AssetKind[] = ['image', 'audio', 'attachment'];
		const maxEncodedChunkLength = Math.ceil((192 * 1024 * 4) / 3) + 4;
		if (
			!input ||
			Object.keys(input).some(
				(key) =>
					![
						'assetId',
						'exampleId',
						'name',
						'mimeType',
						'kind',
						'size',
						'checksum',
						'offset',
						'data',
						'isLast'
					].includes(key)
			) ||
			typeof input.size !== 'number' ||
			typeof input.offset !== 'number' ||
			typeof input.isLast !== 'boolean' ||
			!/^[A-Za-z0-9-]{8,80}$/.test(input.assetId || '') ||
			!/^[A-Za-z0-9-]{1,120}$/.test(input.exampleId || '') ||
			!allowedKinds.includes(input.kind)
		) {
			throw new Meteor.Error('invalid-upload', 'Metadados do upload inválidos.');
		}
		const size = Number(input.size);
		const offset = Number(input.offset);
		if (
			typeof input.name !== 'string' ||
			input.name.length < 1 ||
			input.name.length > 180 ||
			typeof input.mimeType !== 'string' ||
			!/^([a-f0-9]{64})$/i.test(input.checksum || '') ||
			typeof input.data !== 'string' ||
			input.data.length > maxEncodedChunkLength ||
			(input.data.length > 0 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) ||
			!Number.isInteger(size) ||
			size <= 0 ||
			size > MAX_UPLOAD_BYTES ||
			!Number.isInteger(offset) ||
			offset < 0 ||
			!isAllowedAttachment({ name: input.name, mimeType: input.mimeType, size })
		) {
			throw new Meteor.Error('invalid-upload', 'Nome, tipo, checksum, tamanho ou bloco do arquivo inválido.');
		}
		if (
			(input.kind === 'image' && !input.mimeType.startsWith('image/')) ||
			(input.kind === 'audio' && !input.mimeType.startsWith('audio/'))
		) {
			throw new Meteor.Error('invalid-upload', 'O tipo do arquivo não corresponde à categoria informada.');
		}

		const example = await this.getCollectionInstance().findOneAsync({ _id: input.exampleId });
		if (!example) throw new Meteor.Error('document-not-found', 'Salve o documento antes de enviar seus arquivos.');
		await this.beforeUpdate({ _id: input.exampleId }, context);
		const existingFile = await attachmentsCollection.attachments.collection.findOneAsync({ _id: input.assetId });
		if (existingFile) {
			if (
				existingFile.meta?.module !== 'example' ||
				existingFile.meta?.docId !== input.exampleId ||
				existingFile.meta?.userId !== context.user._id ||
				existingFile.meta?.checksum !== input.checksum.toLowerCase()
			) {
				throw new Meteor.Error('upload-id-conflict', 'O identificador do arquivo já está em uso.');
			}
			return { complete: true, nextOffset: existingFile.size, ...this.serializeAsset(existingFile) };
		}

		const fs = require('fs').promises;
		const path = require('path');
		const os = require('os');
		const crypto = require('crypto');
		const ownerKey = crypto.createHash('sha256').update(context.user._id).digest('hex').slice(0, 24);
		return withBoundedUpload(ownerKey, input, async (incomingDirectory) => {
			const tempPath = path.join(incomingDirectory, `${input.assetId}.part`);
			const chunk = Buffer.from(input.data, 'base64');
			if (chunk.length > 192 * 1024) throw new Meteor.Error('invalid-upload', 'Bloco do arquivo maior que 192 KiB.');
			const stat = await fs.stat(tempPath).catch(() => ({ size: 0 }));
			if (stat.size > size)
				throw new Meteor.Error('upload-size-mismatch', 'O arquivo temporário excede o tamanho declarado.');
			if (offset > stat.size) throw new Meteor.Error('upload-offset', `Retome o upload no byte ${stat.size}.`);
			if (offset < stat.size) {
				if (offset + chunk.length > stat.size) throw new Meteor.Error('upload-offset', 'Bloco parcialmente repetido.');
				const handle = await fs.open(tempPath, 'r');
				const previous = Buffer.alloc(chunk.length);
				try {
					await handle.read(previous, 0, previous.length, offset);
				} finally {
					await handle.close();
				}
				if (!previous.equals(chunk))
					throw new Meteor.Error('upload-chunk-conflict', 'Bloco repetido com conteúdo diferente.');
				return { complete: false, nextOffset: stat.size };
			}
			if (stat.size + chunk.length > size)
				throw new Meteor.Error('upload-size-mismatch', 'O bloco excede o tamanho declarado.');
			if (chunk.length) await fs.appendFile(tempPath, chunk, { mode: 0o600 });
			if (size === 0 && offset === 0) await fs.writeFile(tempPath, Buffer.alloc(0));
			const nextOffset = stat.size + chunk.length;
			if (nextOffset > size) throw new Meteor.Error('upload-size-mismatch', 'O arquivo excedeu o tamanho declarado.');
			if (!input.isLast) return { complete: false, nextOffset };
			if (nextOffset !== size) {
				throw new Meteor.Error('upload-incomplete', `O upload deve continuar no byte ${nextOffset}.`);
			}

			const digest = await new Promise<string>((resolve, reject) => {
				const hash = crypto.createHash('sha256');
				const stream = require('fs').createReadStream(tempPath);
				stream.on('data', (data: Buffer) => hash.update(data));
				stream.on('error', reject);
				stream.on('end', () => resolve(hash.digest('hex')));
			});
			if (digest !== input.checksum.toLowerCase()) {
				await fs.unlink(tempPath).catch(() => undefined);
				throw new Meteor.Error('upload-checksum', 'A integridade do arquivo não pôde ser confirmada.');
			}
			const saved = await attachmentsCollection.serverSaveFileFromPath({
				id: input.assetId,
				tempPath,
				name: input.name,
				mimeType: input.mimeType,
				size,
				meta: {
					module: 'example',
					docId: input.exampleId,
					fieldName: input.kind === 'image' ? 'images' : input.kind === 'audio' ? 'audios' : 'files',
					kind: input.kind,
					checksum: digest,
					userId: context.user._id
				}
			});
			await this.commitRevision(input.exampleId, { updatedby: context.user._id });
			return { complete: true, nextOffset, ...this.serializeAsset(saved) };
		});
	}

	async removeAsset(input: { assetId: string }, context: IContext) {
		if (!context.user?._id || context.user.status === 'disabled')
			throw new Meteor.Error('not-authorized', 'Autenticação obrigatória.');
		if (!/^[A-Za-z0-9-]{8,80}$/.test(input?.assetId || '')) {
			throw new Meteor.Error('invalid-upload', 'Identificador do arquivo inválido.');
		}
		const file = await attachmentsCollection.attachments.collection.findOneAsync({ _id: input.assetId });
		if (!file) return true;
		if (file.meta?.module !== 'example' || file.meta?.userId !== context.user._id) {
			throw new Meteor.Error('not-authorized', 'O arquivo não pertence ao módulo Example.');
		}
		const exampleId = file.meta?.docId;
		if (!exampleId) throw new Meteor.Error('invalid-upload', 'O arquivo não está vinculado a um documento.');
		await this.beforeUpdate({ _id: exampleId }, context);
		await attachmentsCollection.attachments.removeAsync({ _id: file._id });
		await this.commitRevision(exampleId, { updatedby: context.user._id });
		return true;
	}

	async afterRemove(doc: Partial<IExample>, context: IContext) {
		await super.afterRemove(doc, context);
		if (!doc._id) return;
		await this.tombstones.upsertAsync(
			{ documentId: doc._id },
			{ $set: { documentId: doc._id, deletedAt: new Date() } }
		);
		const files = await attachmentsCollection.find({ 'meta.docId': doc._id }).fetchAsync();
		for (const file of files) await attachmentsCollection.attachments.removeAsync({ _id: file._id });
	}
}

export const exampleServerApi = new ExampleServerApi();

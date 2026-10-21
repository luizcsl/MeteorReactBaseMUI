/// <reference types="mocha" />
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { exampleServerApi } from '../../api/exampleServerApi';
import { EXAMPLE_CATEGORIES, EXAMPLE_PRIORITIES } from '../../api/exampleValues';
import { EXAMPLE_LIST_FIELDS } from '../../api/exampleExposure';

describe('Example fields over real Mongo and DDP', function () {
	this.timeout(30000);
	const { Accounts } = require('meteor/accounts-base');
	const { DDP } = require('meteor/ddp-client');
	const { Random } = require('meteor/random');
	const collection = exampleServerApi.getCollectionInstance();
	const profiles = new Mongo.Collection('example_field_test_metadata')
		.rawDatabase()
		.collection<{ _id: string; [key: string]: any }>('userprofile');
	const connections: any[] = [];
	let prefix = '',
		admin: any,
		denied: any,
		anonymous: any;
	const call = (connection: any, name: string, ...args: unknown[]) =>
		new Promise<any>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`DDP timeout: ${name}`)), 10000);
			connection.call(name, ...args, (error: unknown, value: unknown) => {
				clearTimeout(timeout);
				error ? reject(error) : resolve(value);
			});
		});
	const connect = async (role?: string) => {
		const connection = DDP.connect(Meteor.absoluteUrl(), { retry: false });
		connections.push(connection);
		if (role) {
			const id = prefix + role;
			await Meteor.users.insertAsync({ _id: id, emails: [{ address: `${id}@example.test`, verified: true }] });
			await profiles.insertOne({ _id: id, accountId: id, roles: [role], status: 'active', username: role });
			const token = Accounts._generateStampedLoginToken();
			await Accounts._insertLoginToken(id, token);
			await call(connection, 'login', { resume: token.token });
		}
		return connection;
	};
	const readFresh = async (publication: string, id: string) => {
		// A separate connection avoids a detail subscription filling missing list fields through mergebox.
		const connection = DDP.connect(Meteor.absoluteUrl(), { retry: false });
		const received = new Mongo.Collection('example', { connection });
		try {
			const account = prefix + 'Administrador';
			const token = Accounts._generateStampedLoginToken();
			await Accounts._insertLoginToken(account, token);
			await call(connection, 'login', { resume: token.token });
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Example subscription timeout')), 10000);
				connection.subscribe(
					'example.' + publication,
					{ _id: id },
					{
						onReady() {
							clearTimeout(timeout);
							resolve();
						},
						onStop(error: unknown) {
							if (error) {
								clearTimeout(timeout);
								reject(error);
							}
						}
					}
				);
			});
			return await received.findOneAsync(id);
		} finally {
			connection.close();
		}
	};
	const document = (id: string) => ({
		_id: id,
		title: 'Example field acceptance',
		type: 'Categoria A',
		typeMulti: 'alta'
	});
	before(async () => {
		prefix = `example-fields-${Random.id()}-`;
		admin = await connect('Administrador');
		denied = await connect('Publico');
		anonymous = await connect();
	});
	after(async () => {
		for (const connection of connections) connection.close();
		if (!prefix) return;
		await collection.removeAsync({ _id: { $regex: '^' + prefix } });
		await profiles.deleteMany({ _id: { $regex: '^' + prefix } });
		await Meteor.users.removeAsync({ _id: { $regex: '^' + prefix } });
	});

	it('persists every allowed category and priority and republishes them after a fresh list/detail subscription', async () => {
		for (let index = 0; index < EXAMPLE_CATEGORIES.length; index++) {
			const id = prefix + index;
			const value = { ...document(id), type: EXAMPLE_CATEGORIES[index], typeMulti: EXAMPLE_PRIORITIES[index] };
			assert.equal(await call(admin, 'example.insert', value), id);
			assert.equal((await collection.findOneAsync(id))?.type, value.type);
			for (const publication of ['exampleList', 'exampleDetail']) {
				const found = await readFresh(publication, id);
				assert.equal(found?.type, value.type);
				assert.equal(found?.typeMulti, value.typeMulti);
				if (publication === 'exampleList')
					assert.deepEqual(Object.keys(found!).sort(), ['_id', ...EXAMPLE_LIST_FIELDS].sort());
			}
			const updated = {
				...value,
				type: EXAMPLE_CATEGORIES[(index + 1) % 3],
				typeMulti: EXAMPLE_PRIORITIES[(index + 1) % 3]
			};
			assert.equal(await call(admin, 'example.update', updated), 1);
			assert.equal((await collection.findOneAsync(id))?.type, updated.type);
			for (const publication of ['exampleList', 'exampleDetail']) {
				const found = await readFresh(publication, id);
				assert.equal(found?.type, updated.type);
				assert.equal(found?.typeMulti, updated.typeMulti);
			}
		}
	});

	it('rejects invalid insert/update inputs before Mongo changes, including ignored constraints and malformed arrays', async () => {
		const id = prefix + 'invalid';
		const base = document(id);
		await call(admin, 'example.insert', base);
		const previous = await collection.findOneAsync(id);
		const inputs: Record<string, unknown>[] = [];
		for (const field of ['type', 'typeMulti']) {
			for (const value of [undefined, null, '', 'unknown', 1, false, {}, [], ['Categoria A']])
				inputs.push({ ...base, [field]: value });
			const missing: Record<string, unknown> = { ...base };
			delete missing[field];
			inputs.push(missing);
		}
		for (const check of ['Grupo 1', ['invalid'], [['Grupo 1']]]) inputs.push({ ...base, check });
		for (const [index, input] of inputs.entries()) {
			const insertId = prefix + 'rejected-' + index;
			await assert.rejects(
				call(admin, 'example.insert', { ...input, _id: insertId }),
				(e: any) => e.error === 'invalid-field-value'
			);
			assert.equal(await collection.findOneAsync(insertId), undefined);
			await assert.rejects(call(admin, 'example.update', input), (e: any) => e.error === 'invalid-field-value');
			assert.deepEqual(await collection.findOneAsync(id), previous);
		}
		assert.throws(
			() => exampleServerApi._checkDataBySchema(base, ['type']),
			(e: any) => e.error === 'invalid-field-value'
		);
		assert.equal((await readFresh('exampleDetail', id))?.type, base.type);
	});

	it('denies anonymous and unauthorized writes and rejects forged trailing identity', async () => {
		for (const connection of [anonymous, denied]) {
			const id = prefix + 'forbidden';
			await assert.rejects(call(connection, 'example.insert', document(id)), (e: any) =>
				['Acesso negado', 'not-authorized'].includes(e.error)
			);
			assert.equal(await collection.findOneAsync(id), undefined);
		}
		const id = prefix + 'forged';
		await assert.rejects(
			call(anonymous, 'example.insert', document(id), { user: { roles: ['Administrador'] } }),
			(e: any) => e.error === 'invalid-arguments'
		);
		assert.equal(await collection.findOneAsync(id), undefined);
	});
});

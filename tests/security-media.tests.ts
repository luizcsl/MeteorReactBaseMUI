import assert from 'assert';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) {
	const { createMediaCapability, verifyMediaCapability } = require('../imports/server/mediaAuthorization');
	const { isPublicIPv4, isAllowedSocialImageUrl } = require('../imports/server/socialAvatar');
	const { getUserProfileSelector } = require('../imports/modules/userprofile/api/userProfileServerApi');
	describe('private media and identity boundaries', function () {
		it('keeps rate budgets independent for two real DDP connections', async function () {
			this.timeout(15000);
			const { DDPRateLimiter } = require('meteor/ddp-rate-limiter');
			const { DDP } = require('meteor/ddp-client');
			const { Random } = require('meteor/random');
			const methodName = `security.rateProbe.${Random.id()}`;
			Meteor.methods({
				[methodName]() {
					return true;
				}
			});
			const { addScopedRateLimit } = require('../imports/server/rateLimits');
			const rules = addScopedRateLimit({ type: 'method', name: methodName }, 2, 60000);
			const first = DDP.connect(Meteor.absoluteUrl());
			const second = DDP.connect(Meteor.absoluteUrl());
			const call = (connection: any) =>
				new Promise((resolve, reject) =>
					connection.call(methodName, (error: unknown, result: unknown) => (error ? reject(error) : resolve(result)))
				);
			try {
				assert.strictEqual(await call(first), true);
				assert.strictEqual(await call(first), true);
				await assert.rejects(
					() => call(first),
					(error: any) => error.error === 'too-many-requests'
				);
				assert.strictEqual(await call(second), true);
			} finally {
				first.close();
				second.close();
				for (const rule of rules) DDPRateLimiter.removeRule(rule);
			}
		});

		it('rejects malformed operational limits and authorization bypass configuration', function () {
			const { validateEnvironment } = require('../imports/server/environment');
			for (const [name, value] of [
				['OAUTH_HTTP_TIMEOUT_MS', 'NaN'],
				['EMAIL_METHOD_RATE_LIMIT_MAX', '0'],
				['JSON_BODY_LIMIT', '-1mb'],
				['DISABLE_MEDIA_TOKEN', 'true']
			]) {
				const previous = process.env[name];
				try {
					process.env[name] = value;
					assert.throws(() => validateEnvironment());
				} finally {
					if (previous === undefined) delete process.env[name];
					else process.env[name] = previous;
				}
			}
		});

		it('binds capabilities to resource, operation, version and expiry', function () {
			const now = Date.now();
			const token = createMediaCapability('file-A', now);
			assert.strictEqual(verifyMediaCapability(token, 'file-A', 'original', now), true);
			assert.strictEqual(verifyMediaCapability(token, 'file-B', 'original', now), false);
			assert.strictEqual(verifyMediaCapability(token, 'file-A', 'thumbnail', now), false);
			assert.strictEqual(verifyMediaCapability(token, 'file-A', 'original', now + 301000), false);
			assert.strictEqual(verifyMediaCapability(`${token}x`, 'file-A'), false);
			assert.strictEqual(verifyMediaCapability(process.env.MEDIA_SIGNING_KEY, 'file-A'), false);
		});
		it('does not link accounts by email or legacy aliases', function () {
			assert.deepStrictEqual(getUserProfileSelector({ _id: 'account-A', profile: { email: 'victim@example.com' } }), {
				accountId: 'account-A'
			});
		});
		it('rejects local avatar addresses and unsafe URL shapes', function () {
			for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.1', '192.168.0.1', '100.64.0.1', '::1'])
				assert.strictEqual(isPublicIPv4(ip), false);
			for (const url of [
				'http://googleusercontent.com/a',
				'https://googleusercontent.com.attacker.test/a',
				'https://user:pass@googleusercontent.com/a',
				'https://googleusercontent.com:444/a'
			])
				assert.strictEqual(isAllowedSocialImageUrl(url), false);
		});
		it('rejects content with a false declared image MIME', async function () {
			const fs = require('node:fs/promises');
			const os = require('node:os');
			const path = require('node:path');
			const { validateMediaContent } = require('../imports/server/mediaContent');
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
			try {
				const file = path.join(dir, 'fake.png');
				await fs.writeFile(file, '<script>bad</script>');
				await assert.rejects(() => validateMediaContent(file, 'image/png', 20));
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
		it('enforces real HTTP resource isolation and private cache headers', async function () {
			this.timeout(15000);
			const fs = require('node:fs/promises');
			const path = require('node:path');
			const os = require('node:os');
			const { Random } = require('meteor/random');
			const { attachmentsCollection } = require('../imports/api/attachmentsCollection');
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-media-test-'));
			const ids = [Random.id(), Random.id()];
			const owner = Random.id();
			const profileId = Random.id();
			const profiles =
				require('../imports/modules/userprofile/api/userProfileServerApi').userprofileServerApi.getCollectionInstance();
			await Meteor.users.insertAsync({ _id: owner, username: `media-fixture-${owner}` });
			await profiles.insertAsync({
				_id: profileId,
				accountId: owner,
				username: 'Media fixture',
				email: `${owner}@example.invalid`,
				roles: ['Usuario'],
				status: 'active'
			});
			try {
				const docs = [];
				for (const id of ids) {
					const tempPath = path.join(dir, id);
					await fs.writeFile(tempPath, 'private fixture');
					docs.push(
						await attachmentsCollection.serverSaveFileFromPath({
							id,
							tempPath,
							name: 'test.txt',
							mimeType: 'text/plain',
							size: 15,
							meta: { userId: owner }
						})
					);
				}
				const exportUrl = await attachmentsCollection.serverSaveCSVFile('a,b\n1,2', 'export-fixture', owner);
				ids.push(new URL(exportUrl).pathname.split('/')[4]);
				const exportResponse = await fetch(exportUrl);
				assert.strictEqual(exportResponse.status, 200);
				assert.strictEqual(await exportResponse.text(), 'a,b\n1,2');
				await assert.rejects(
					() => attachmentsCollection.serverSaveCSVFile('a,b', 'bad-owner', profileId),
					(error: any) => error.error === 'not-authorized'
				);
				const own = await fetch(docs[0].url);
				assert.strictEqual(own.status, 200);
				assert.strictEqual(await own.text(), 'private fixture');
				assert.match(own.headers.get('cache-control') || '', /private.*no-store/);
				assert.strictEqual(own.headers.get('x-content-type-options'), 'nosniff');
				const plain = new URL(docs[0].url);
				plain.search = '';
				assert.ok([401, 403].includes((await fetch(plain)).status));
				const other = new URL(docs[1].url);
				other.search = new URL(docs[0].url).search;
				assert.ok([401, 403].includes((await fetch(other)).status));
				const expired = new URL(docs[0].url);
				expired.searchParams.set('capability', createMediaCapability(ids[0], Date.now() - 301000));
				assert.ok([401, 403].includes((await fetch(expired)).status));
				const global = new URL(docs[0].url);
				global.search = '?token=old-global-token';
				assert.ok([401, 403].includes((await fetch(global)).status));
				const { revalidateLegacyMedia } = require('../imports/server/mediaMigration');
				await attachmentsCollection.attachments.collection.updateAsync(ids[0], {
					$set: { 'versions.original.path': docs[1].path }
				});
				assert.deepStrictEqual(await revalidateLegacyMedia({ ids: [ids[0]], apply: true }), [
					{ id: ids[0], result: 'quarantined' }
				]);
				assert.ok([401, 403].includes((await fetch(docs[0].url)).status));
				await attachmentsCollection.attachments.collection.updateAsync(ids[0], {
					$set: { 'versions.original.path': docs[0].path }
				});

				await attachmentsCollection.attachments.collection.updateAsync(ids[0], {
					$unset: { 'meta.contentValidated': '' }
				});
				assert.ok([401, 403].includes((await fetch(docs[0].url)).status));
				assert.deepStrictEqual(await revalidateLegacyMedia({ ids: [ids[0]], apply: false }), [
					{ id: ids[0], result: 'would-validate' }
				]);
				assert.ok([401, 403].includes((await fetch(docs[0].url)).status));
				assert.deepStrictEqual(await revalidateLegacyMedia({ ids: [ids[0]], apply: true }), [
					{ id: ids[0], result: 'validated' }
				]);
				assert.strictEqual((await fetch(docs[0].url)).status, 200);
				await profiles.updateAsync(profileId, { $set: { status: 'disabled' } });
				assert.ok([401, 403].includes((await fetch(docs[0].url)).status));
				const uploadAllowed = await attachmentsCollection.attachments.onBeforeUpload.call(
					{ userId: owner },
					{ name: 'test.txt', type: 'text/plain', size: 15, meta: { userId: owner } }
				);
				assert.notStrictEqual(uploadAllowed, true);
				const handlers = (Meteor as any).server.method_handlers;
				await assert.rejects(
					() => handlers.RemoveFile.call({ userId: owner }, ids[0]),
					(error: any) => error.error === 'not-authorized'
				);
				let deniedPublication = false;
				await (Meteor as any).server.publish_handlers['files-attachments'].call(
					{
						userId: owner,
						ready() {
							deniedPublication = true;
						}
					},
					{ 'meta.docId': 'fixture' }
				);
				assert.strictEqual(deniedPublication, true);
			} finally {
				for (const id of ids) await attachmentsCollection.attachments.removeAsync(id);
				await profiles.removeAsync(profileId);
				await Meteor.users.removeAsync(owner);
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
	});
}

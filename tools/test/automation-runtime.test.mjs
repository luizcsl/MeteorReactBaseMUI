import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve(import.meta.dirname, '../..');
async function load(file) {
 const result = await build({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'esm', write: false });
 return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { startRecipePublication } = await load('imports/core/recipes/server/publication.ts');
const { createOwnerIdentityAdapter, createTenantIdentityAdapter } = await load('imports/core/recipes/server/identity.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
 let identityChanged, recordsChanged, onStop, active = true, stopped = 0;
 const events = [], rows = [{ id: 'safe', version: 1, state: 'draft', data: { title: 'visible' }, parentId: null }];
 return {
  events, rows, get stopped() { return stopped; },
  revoke() { active = false; identityChanged(); }, change() { recordsChanged(); }, stop() { onStop(); },
  context: { userId: 'alice', added: (...a) => events.push(['added', ...a]), changed: (...a) => events.push(['changed', ...a]), removed: (...a) => events.push(['removed', ...a]), ready: () => events.push(['ready']), error: () => events.push(['error']), onStop(cb) { onStop = cb; } },
  service: { async list(userId, query) { assert.equal(userId, 'alice'); assert.deepEqual(query, { filters: {}, limit: 10 }); if (!active) throw Error('revoked'); return rows; } },
  ports: { async observeIdentity(id, cb) { assert.equal(id, 'alice'); identityChanged = cb; return { stop() { stopped++; } }; }, async observeRecords(cb) { recordsChanged = cb; return { stop() { stopped++; } }; }, error: () => Error('forbidden') }
 };
}
const value = { subscriptionId: 'sub_1', query: { filters: {}, limit: 10 } };
test('publication reuses authorized list projection; revocation removes snapshot before awaiting revalidation and stops observers', async () => {
 const f = fixture(); await startRecipePublication(f.context, 'view', f.service, value, f.ports);
 assert.deepEqual(f.events[0], ['added', 'view', 'sub_1', { rows: f.rows }]);
 f.revoke(); assert.equal(f.events.at(-1)[0], 'removed'); await tick();
 assert.equal(f.events.at(-1)[0], 'error'); assert.equal(f.stopped, 2);
 const length = f.events.length; f.change(); await tick(); assert.equal(f.events.length, length);
});
test('record changes refresh bounded snapshots and onStop cleans up', async () => {
 const f = fixture(); await startRecipePublication(f.context, 'view', f.service, value, f.ports);
 f.change(); await tick(); assert.equal(f.events.filter(e => e[0] === 'added').length, 2);
 f.stop(); assert.equal(f.stopped, 2); assert.equal(f.events.at(-1)[0], 'removed');
});
test('stop during observer setup stops the late handle and never publishes', async () => {
 const f = fixture(); let resolve;
 f.ports.observeIdentity = () => new Promise(r => { resolve = r; });
 const pending = startRecipePublication(f.context, 'view', f.service, value, f.ports);
 f.stop(); let stopped = false; resolve({ stop() { stopped = true; } }); await pending;
 assert.equal(stopped, true); assert.deepEqual(f.events, []);
});
test('in-flight reads cannot publish after revocation invalidation', async () => {
 const f = fixture(); let resolve;
 f.service.list = () => new Promise(r => { resolve = r; });
 const pending = startRecipePublication(f.context, 'view', f.service, value, f.ports);
 await tick(); f.stop(); resolve(f.rows); await pending;
 assert.equal(f.events.some(e => e[0] === 'added'), false);
});
test('anonymous, forged snapshot envelope and setup failures fail closed', async () => {
 for (const invalid of [{ ...value, ownerId: 'attacker' }, { ...value, subscriptionId: '$bad' }, null]) {
  const f = fixture(); await assert.rejects(() => startRecipePublication(f.context, 'view', f.service, invalid, f.ports)); assert.deepEqual(f.events, []);
 }
 const f = fixture(); f.context.userId = null;
 await assert.rejects(() => startRecipePublication(f.context, 'view', f.service, value, f.ports));
 const g = fixture(); g.ports.observeRecords = async () => { throw Error('setup failure'); };
 await startRecipePublication(g.context, 'view', g.service, value, g.ports); assert.equal(g.stopped, 1); assert.equal(g.events.at(-1)[0], 'error');
});
test('owner and tenant adapters resolve current trusted state without inferred roles', async () => {
 let active = true, membership = { tenantId: 'team1', roles: ['member'] };
 const source = { isActiveAccount: async () => active, membership: async () => membership, observe: async () => ({ stop() {} }) };
 const owner = createOwnerIdentityAdapter(source), tenant = createTenantIdentityAdapter(source);
 assert.deepEqual(await owner.resolveIdentity('alice'), { userId: 'alice', roles: [] });
 assert.deepEqual(await tenant.resolveIdentity('alice'), { userId: 'alice', ...membership });
 membership = { tenantId: 'team1', roles: ['admin'] }; await assert.rejects(() => tenant.resolveIdentity('alice'));
 membership = null; await assert.rejects(() => tenant.resolveIdentity('alice'));
 active = false; await assert.rejects(() => owner.resolveIdentity('alice'));
});
test('legacy and contract transports share registration/call wrappers; generator has no direct Meteor call', async () => {
 const read = file => fs.readFileSync(path.join(root, file), 'utf8');
 assert.match(read('imports/api/base.ts'), /import \{ callMethod \} from '.\/methodTransport'/);
 assert.match(read('imports/api/serverBase.ts'), /registerMethods\(method\)/);
 assert.match(read('imports/core/recipes/server/register.ts'), /registerMethods\(/);
 assert.match(read('imports/core/server/meteor.ts'), /registerMethods\(/);
 assert.doesNotMatch(read('tools/recipes.mjs'), /Meteor.call/);
});
async function loadTransport(file, stub) {
 const key = '__transport_' + Math.random().toString(36).slice(2); globalThis[key] = stub;
 const result = await build({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'meteor-test-port', setup(build) {
   build.onResolve({ filter: /^meteor\// }, (args) => ({ path: args.path, namespace: 'test' }));
   build.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({ contents: args.path === 'meteor/mongo' ? `export const Mongo = globalThis[${JSON.stringify(key)}].mongo;` : args.path === 'meteor/ddp-rate-limiter' ? `export const DDPRateLimiter = globalThis[${JSON.stringify(key)}].rateLimiter;` : `export const Meteor = globalThis[${JSON.stringify(key)}];` }));
  } }] });
 const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
 delete globalThis[key]; return module;
}
test('callMethod uses callback transport and preserves network and server errors without offline success', async () => {
 let connected = true, count = 0, failure;
 const api = await loadTransport('imports/api/methodTransport.ts', { status: () => ({ connected }), Error: class extends Error {}, call(name, dto, callback) {
  count++; assert.equal(name, 'notes.create'); assert.deepEqual(dto, { data: 'text' }); callback(failure, { id: 'created' });
 } });
 assert.deepEqual(await api.callMethod('notes.create', { data: 'text' }), { id: 'created' });
 failure = Error('forbidden'); await assert.rejects(() => api.callMethod('notes.create', { data: 'text' }), /forbidden/);
 connected = false; await assert.rejects(() => api.callMethod('notes.create', { data: 'text' }), /offline/); assert.equal(count, 2);
});
test('shared registration preserves invocation this and excludes client registration', async () => {
 const stub = { isServer: true, methods(value) { this.registered = value; }, publish(name, value) { this.publication = { name, value }; } };
 const api = await loadTransport('imports/api/server/registration.ts', stub);
 api.registerMethods({ 'notes.read': function (input) { return [this.userId, input]; } });
 assert.deepEqual(stub.registered['notes.read'].call({ userId: 'alice' }, { id: 'safe' }), ['alice', { id: 'safe' }]);
 api.registerPublications({ 'notes.records': function () { return this.userId; } });
 assert.equal(stub.publication.value.call({ userId: 'alice' }), 'alice');
 stub.isServer = false; assert.throws(() => api.registerMethods({}), /Server registration/); assert.throws(() => api.registerPublications({}), /Server registration/);
});
test('revocation wins a racing older authorized read and dependency watchers retract parent data', async () => {
 const f = fixture(); let resolve, first = true;
 const list = f.service.list;
 f.service.list = (...args) => { if (!first) return list(...args); first = false; return new Promise(r => { resolve = r; }); };
 const pending = startRecipePublication(f.context, 'view', f.service, value, f.ports);
 await tick(); f.revoke(); await tick(); resolve(f.rows); await pending;
 assert.equal(f.events.some(e => e[0] === 'added'), false); assert.equal(f.stopped, 2);
 const g = fixture(); let dependencyChanged, stopped = false;
 g.ports.observeDependencies = async cb => { dependencyChanged = cb; return { stop() { stopped = true; } }; };
 await startRecipePublication(g.context, 'view', g.service, value, g.ports);
 g.service.list = async () => { throw Error('parent removed'); };
 dependencyChanged(); assert.equal(g.events.at(-1)[0], 'removed'); await tick(); assert.equal(stopped, true);
});

test('recipe registration returns the exact service ports and creates only one repository collection', async () => {
 let constructions = 0;
 const stub = { isServer: true, methods() {}, publish() {}, rateLimiter: { addRule() {} }, mongo: { Collection: class {
  constructor() { constructions++; }
  async findOneAsync() { return { _id: 'stored' }; }
 } } };
 const { registerRecipe } = await loadTransport('imports/core/recipes/server/register.ts', stub);
 const source = { resolveIdentity: async userId => ({ userId, roles: [] }) };
 const definition = JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes/owner.json'), 'utf8'));
 const ports = registerRecipe(definition, source);
 assert.equal(ports.resolveIdentity, source.resolveIdentity);
 assert.equal(constructions, 1);
 assert.equal((await ports.repository.find({ ownerId: 'alice' }, 'stored'))._id, 'stored');
 assert.throws(() => registerRecipe(definition, source), /Duplicate recipe/);
 assert.equal(constructions, 1);
 const { renderDefinition } = await import('../recipes.mjs');
 assert.match(renderDefinition(definition)['generated/server/register.ts'], /return registerRecipe\(definition,ports\)/);
});

test('repository query adapter reuses collection and honors database-level query options', async () => {
 let constructions = 0, capturedFind, capturedPipeline, observerOptions;
 const stub = { mongo: { Collection: class {
  constructor() { constructions++; }
  find(selector, options) { capturedFind = { selector, options }; return { fetchAsync: async () => [{ _id: 'safe', data: { title: 'ok' } }], observeChanges: () => { observerOptions = options; return { stop() {} }; } }; }
  rawCollection() { return { aggregate(pipeline) { capturedPipeline = pipeline; return { toArray: async () => [{ total: 1 }] }; } }; }
 } } };
 const { mongoRecipeRepository } = await loadTransport('imports/core/recipes/server/mongo.ts', stub);
 const repository = mongoRecipeRepository('query_fixture');
 const selector = { ownerId: 'alice', deleted: false }, options = { sort: { _id: 1 }, limit: 5, projection: { _id: 1 } };
 await repository.query.find(selector, options);
 assert.deepEqual(capturedFind, { selector, options: { sort: options.sort, limit: 5, fields: options.projection } });
 const pipeline = [{ $match: selector }, { $count: 'total' }];
 assert.deepEqual(await repository.query.aggregate(pipeline), [{ total: 1 }]); assert.deepEqual(capturedPipeline, pipeline);
 await repository.observeChanges(() => {});
 assert.equal(observerOptions.pollingIntervalMs, 1000);
 for (const field of ['ownerId', 'tenantId', 'parentId', 'deleted', 'state', 'data', 'version']) assert.equal(observerOptions.fields[field], 1);
 assert.equal(constructions, 1);
});

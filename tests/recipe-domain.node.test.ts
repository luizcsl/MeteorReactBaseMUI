import test from 'node:test';
import assert from 'node:assert/strict';
import {
	validateDefinition,
	parseRecipeData,
	parseRecipeFilters,
	parseMoneyText,
	formatMoney,
	type RecipeDefinition
} from '../imports/core/recipes/definition';
import { recipeService, type RecipeRepository } from '../imports/core/recipes/server/engine';
const definition: RecipeDefinition = {
	schemaVersion: 1,
	name: 'purchases',
	profile: 'owner',
	fields: [
		{ name: 'start', label: 'Start', type: 'date', required: true },
		{ name: 'end', label: 'End', type: 'date', required: true },
		{ name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, max: 100000, currency: 'BRL', scale: 2 },
		{ name: 'supplier', label: 'Supplier', type: 'reference', required: true, target: 'suppliers' }
	],
	rules: [{ kind: 'lte', left: 'start', right: 'end' }],
	filters: ['amount', 'start', 'supplier'],
	states: ['draft'],
	transitions: [],
	permissions: { read: ['owner'], write: ['owner'] }
};
const data = { start: '2024-02-29', end: '2024-03-01', amount: 1010, supplier: 'supplier1' };
test('domain fields preserve exact JSON values and enforce real calendar dates and cross-field rules', () => {
	assert.deepEqual(parseRecipeData(definition, JSON.parse(JSON.stringify(data))), data);
	for (const start of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-01-01T00:00:00Z', '0000-01-01', '01/02/2024'])
		assert.throws(() => parseRecipeData(definition, { ...data, start }));
	assert.throws(() => parseRecipeData(definition, { ...data, end: '2024-01-01' }), /start <= end/);
	for (const amount of [0.1, Infinity, Number.MAX_SAFE_INTEGER, '10.10', -1])
		assert.throws(() => parseRecipeData(definition, { ...data, amount }));
	for (const supplier of ['$where', 'a.b', { id: 'supplier1' }, ''])
		assert.throws(() => parseRecipeData(definition, { ...data, supplier }));
	assert.deepEqual(parseRecipeFilters(definition, { start: data.start, amount: 1010 }), {
		start: data.start,
		amount: 1010
	});
});
test('money decimal conversion never rounds and rejects excess precision/unsafe values', () => {
	for (const [text, amount] of [
		['0.10', 10],
		['10.10', 1010],
		['-0.01', -1],
		['90071992547409.91', Number.MAX_SAFE_INTEGER]
	] as const) {
		assert.equal(parseMoneyText(text, 2), amount);
		assert.equal(formatMoney(amount, 2), text);
	}
	for (const text of ['1.001', '1e3', 'NaN', '01.00', '1,00', '90071992547409.92', ''])
		assert.throws(() => parseMoneyText(text, 2));
});
test('metadata rejects incompatible rules and irrelevant type options', () => {
	for (const rules of [
		[{ kind: 'lte', left: 'start', right: 'amount' }],
		[{ kind: 'execute', left: 'start', right: 'end' }],
		[{ kind: 'lte', left: 'missing', right: 'end' }]
	])
		assert.throws(() => validateDefinition({ ...definition, rules }));
	for (const field of [
		{ ...definition.fields[0], scale: 2 },
		{ ...definition.fields[2], currency: 'brl' },
		{ ...definition.fields[2], scale: 5 },
		{ ...definition.fields[3], target: '../bad' }
	])
		assert.throws(() => validateDefinition({ ...definition, fields: [field], rules: [], filters: [] }));
});
test('reference access is resolved from trusted identity before writes, fails closed without port', async () => {
	let writes = 0,
		allowed = false;
	const repository = {
		insert: async (row) => {
			writes++;
			return row;
		}
	} as RecipeRepository;
	assert.throws(
		() => recipeService(definition, { repository, resolveIdentity: async (userId) => ({ userId, roles: [] }) }),
		/referenceExists/
	);
	const service = recipeService(definition, {
		repository,
		resolveIdentity: async (userId) => ({ userId, roles: [] }),
		referenceExists: async (who, target, id) =>
			allowed && who.userId === 'alice' && target === 'suppliers' && id === 'supplier1'
	});
	const input = { data, parentId: null, mutationId: 'one' };
	await assert.rejects(service.create('alice', input), { code: 'not-found' });
	assert.equal(writes, 0);
	allowed = true;
	await service.create('alice', input);
	assert.equal(writes, 1);
	await assert.rejects(service.create('bob', input), { code: 'not-found' });
	assert.equal(writes, 1);
});

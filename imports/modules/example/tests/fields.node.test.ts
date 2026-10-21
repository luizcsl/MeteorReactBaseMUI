import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedValues, LegacyValueError } from '../../../legacy/allowedValues';
import { exampleSch } from '../api/exampleSch';
import { EXAMPLE_CATEGORIES, EXAMPLE_PRIORITIES } from '../api/exampleValues';

const valid = { title: 'Contract fixture', type: 'Categoria A', typeMulti: 'alta' };
const rejects = (document: Record<string, unknown>, field: string) =>
	assert.throws(
		() => assertAllowedValues(exampleSch, document),
		(error: unknown) => error instanceof LegacyValueError && error.field === field
	);

test('Example accepts every category and priority and rejects missing, malformed or unknown values', () => {
	for (const type of EXAMPLE_CATEGORIES)
		for (const typeMulti of EXAMPLE_PRIORITIES) assertAllowedValues(exampleSch, { ...valid, type, typeMulti });
	for (const field of ['type', 'typeMulti']) {
		for (const value of [undefined, null, '', 'unknown', 1, false, {}, [], ['Categoria A']])
			rejects({ ...valid, [field]: value }, field);
		const document: Record<string, unknown> = { ...valid };
		delete document[field];
		rejects(document, field);
	}
	assert.throws(() => assertAllowedValues(exampleSch, valid, ['type']), /ignored-constraint/);
});

test('Legacy constraints inspect raw arrays and nested values without coercion or optional-field bypass', () => {
	for (const check of [[], ['Grupo 1'], ['Grupo 1', 'Grupo 3']]) assertAllowedValues(exampleSch, { ...valid, check });
	for (const check of [
		['invalid'],
		[['Grupo 1']],
		'Grupo 1',
		[1],
		Array(1),
		Object.assign(['Grupo 1'], { extra: true })
	])
		rejects({ ...valid, check }, 'check');
	assertAllowedValues(exampleSch, { ...valid, check: null, statusRadio: '' });
	rejects({ ...valid, statusRadio: 'invalid' }, 'statusRadio');
	const nested = {
		children: {
			type: [Object],
			optional: true,
			subSchema: { value: { type: String, allowedValues: ['ok'], optional: false } }
		}
	};
	assertAllowedValues(nested, { children: [{ value: 'ok' }] });
	assert.throws(() => assertAllowedValues(nested, { children: [{ value: 'bad' }] }), /children.0.value/);
	assert.throws(() => assertAllowedValues(nested, { children: [{ value: 'ok' }] }, ['children']), /ignored-constraint/);
	assert.throws(
		() => assertAllowedValues({ value: { type: Number, allowedValues: ['1'] } }, { value: '1' }),
		/configuration/
	);
});

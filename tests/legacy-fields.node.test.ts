import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedValues } from '../imports/legacy/allowedValues';
import { aniversarioSch } from '../imports/modules/aniversario/api/aniversarioSch';
import { userProfileSch } from '../imports/modules/userprofile/api/userProfileSch';
test('Shared legacy validator enforces conditional delivery and profile domains', () => {
	assertAllowedValues(aniversarioSch, { remember: [] });
	assertAllowedValues(aniversarioSch, { remember: [true], delivery: '1' });
	assert.throws(
		() => assertAllowedValues(aniversarioSch, { remember: [false], delivery: '1' }),
		/invalid-value: remember/
	);
	assert.throws(() => assertAllowedValues(aniversarioSch, { remember: [true] }), /required: delivery/);
	assert.throws(
		() => assertAllowedValues(aniversarioSch, { remember: [], delivery: 'invalid' }),
		/invalid-value: delivery/
	);
	assert.throws(() => assertAllowedValues(aniversarioSch, { remember: ['true'] }), /invalid-value: remember/);
	assertAllowedValues(userProfileSch, { roles: ['Usuario'], status: 'active' });
	assert.throws(
		() => assertAllowedValues(userProfileSch, { roles: ['invented'], status: 'active' }),
		/invalid-value: roles/
	);
	assert.throws(
		() => assertAllowedValues(userProfileSch, { roles: ['Usuario'], status: 'invented' }),
		/invalid-value: status/
	);
});

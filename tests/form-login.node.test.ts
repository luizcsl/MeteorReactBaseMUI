import { test } from 'node:test';
import assert from 'node:assert/strict';
import SysFormMethods from '../imports/ui/components/sysForm/sysFormMethods';
import { signInSchema } from '../imports/sysPages/pages/signIn/signinsch';
import type { IDocRef } from '../imports/ui/components/sysForm/typings';

function form(email: string, password: string) {
  return { email: { current: { name: 'email', value: email } }, password: { current: { name: 'password', value: password } } } as IDocRef;
}
function validate(doc: IDocRef, errors = { current: {} as Record<string, string> }) {
  SysFormMethods.validate({ schema: signInSchema, doc, requiredFields: ['email', 'password'], fieldsWithErrors: errors });
  return errors;
}
test('sign-in starts with empty email and password, never embedded credentials', () => {
  const { initialDefaultValues } = SysFormMethods.getInitialParams(signInSchema, {});
  assert.deepEqual(initialDefaultValues, { email: '', password: '' });
});
test('sign-in accepts valid entered credentials and preserves them exactly', () => {
  const doc = form('synthetic@example.test', 'synthetic-password');
  assert.doesNotThrow(() => validate(doc));
  assert.deepEqual(SysFormMethods.getDocValues(doc, signInSchema), { email: 'synthetic@example.test', password: 'synthetic-password' });
});
test('sign-in still rejects empty and malformed values and clears corrected errors', () => {
  assert.throws(() => validate(form('', '')), /email, password/);
  const errors = { current: {} as Record<string, string> };
  const doc = form('not-an-email', 'synthetic-password');
  assert.throws(() => validate(doc, errors), /email/);
  assert.equal(errors.current.email, 'Email inválido');
  (doc.email as { current: { value: string } }).current.value = 'synthetic@example.test';
  assert.doesNotThrow(() => validate(doc, errors));
  assert.deepEqual(errors.current, {});
});

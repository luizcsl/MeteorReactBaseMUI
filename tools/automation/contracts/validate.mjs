import { fail, exact, relative } from '../../lib.mjs';
import { validateDefinition } from '../../recipes.mjs';
export const json = (value) => JSON.stringify(value, null, 2) + '\n';
export function boundedString(value, label, max = 100) {
	if (typeof value !== 'string' || !value.trim() || value.length > max) fail('automation-schema', `Invalid ${label}`);
	return value;
}
export function validateFeature(raw) {
	exact(
		raw,
		[
			'schemaVersion',
			'intent',
			'name',
			'archetype',
			'fields',
			'rules',
			'filters',
			'states',
			'transitions',
			'permissions',
			'ui',
			'services',
			'integration'
		],
		['schemaVersion', 'intent', 'name', 'archetype', 'fields', 'permissions']
	);
	for (const key of ['rules', 'filters', 'states', 'transitions', 'ui', 'services', 'integration'])
		if (Object.hasOwn(raw, key) && raw[key] === null) fail('automation-schema', `Null is not supported for ${key}`);
	if (raw.schemaVersion !== 3 || raw.intent !== 'create-feature')
		fail('automation-version', 'Use schemaVersion 3 and intent create-feature');
	const definition = validateDefinition({
		schemaVersion: 1,
		name: raw.name,
		profile: raw.archetype,
		fields: raw.fields,
		rules: raw.rules ?? [],
		filters: raw.filters ?? [],
		states: raw.states ?? ['draft'],
		transitions: raw.transitions ?? [],
		permissions: raw.permissions
	});
	if (raw.integration !== undefined) {
		exact(raw.integration, ['label', 'identity', 'ports'], ['label', 'identity']);
		boundedString(raw.integration.label, 'label');
		if (!['owner-active-account', 'reviewed-ports'].includes(raw.integration.identity))
			fail('automation-identity', 'Choose owner-active-account or reviewed-ports');
		if (raw.integration.identity === 'owner-active-account' && definition.profile !== 'owner')
			fail('automation-identity', 'Owner adapter cannot grant tenant/reviewer access');
		if (raw.integration.identity === 'reviewed-ports') relative(raw.integration.ports);
		else if (raw.integration.ports !== undefined) fail('automation-identity', 'ports only allowed for reviewed-ports');
	}
	return {
		...structuredClone(raw),
		fields: definition.fields,
		rules: definition.rules ?? [],
		filters: definition.filters,
		states: definition.states,
		transitions: definition.transitions,
		permissions: definition.permissions,
		definition
	};
}
export function validateRequest(raw) {
	exact(raw, ['schemaVersion', 'operations'], ['schemaVersion', 'operations']);
	if (raw.schemaVersion !== 1 || !Array.isArray(raw.operations) || !raw.operations.length || raw.operations.length > 32)
		fail('automation-schema', 'Expected schemaVersion 1 and 1–32 operations');
	const ids = new Set();
	for (const op of raw.operations) {
		exact(op, ['id', 'kind', 'input', 'dependsOn'], ['id', 'kind', 'input']);
		if (typeof op.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(op.id) || ids.has(op.id))
			fail('automation-schema', 'Unique bounded operation id required');
		ids.add(op.id);
		if (!['feature', 'evolve', 'integrate', 'codemod', 'project'].includes(op.kind))
			fail('unsupported', 'Supported operation kinds: feature, evolve, integrate, codemod, project');
		if (
			op.dependsOn !== undefined &&
			(!Array.isArray(op.dependsOn) ||
				op.dependsOn.some((x) => typeof x !== 'string') ||
				new Set(op.dependsOn).size !== op.dependsOn.length)
		)
			fail('automation-schema', 'dependsOn must contain unique operation ids');
	}
	const ordered = [],
		pending = [...raw.operations];
	while (pending.length) {
		const index = pending.findIndex((op) => (op.dependsOn ?? []).every((id) => ordered.some((x) => x.id === id)));
		if (index < 0) fail('automation-dependencies', 'Unknown dependency or cycle');
		ordered.push(pending.splice(index, 1)[0]);
	}
	return { schemaVersion: 1, operations: ordered };
}

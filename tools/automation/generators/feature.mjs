import { renderUI } from './ui.mjs';
import { renderTests } from './tests.mjs';
import { renderServices } from './services.mjs';
import { validateFeature, json } from '../contracts/validate.mjs';
import { hash, fail } from '../../lib.mjs';
export function renderExtensions(definition, raw, root) {
	const { definition: validated, ...spec } = validateFeature(raw);
	if (json(validated) !== json(definition))
		fail('automation-definition', 'Extension contract differs from recipe definition');
	const prefix = `imports/modules/${definition.name}`;
	const output = {
		...renderUI({ definition, ui: spec.ui ?? {}, services: spec.services ?? {} }),
		...renderTests({ definition, services: spec.services ?? {}, tests: { browserPath: '/modules/' + definition.name } })
	};
	output[`${prefix}/automation/REFERENCE.md`] =
		`# ${definition.name}\n\nGenerated from the versioned definition. Never an acceptance certificate.\n\n## Fields\n${definition.fields.map((f) => '- ' + f.name + ': ' + f.type + (f.required ? ' (required)' : '')).join('\n')}\n\n## Permission matrix\n${json(definition.permissions)}\n## Workflow\n${definition.transitions.map((t) => t.from + ' --> ' + t.to + ' : ' + t.roles.join(', ')).join('\n')}\n\n## Methods\nlist, create, update, transition, remove use shared registerMethods and callMethod. Reactive reads use registerPublications and require identity observation.\n`;
	if (spec.services) Object.assign(output, renderServices({ definition, services: spec.services }, root));
	output[`${prefix}/module.automation.json`] = json({
		schemaVersion: 1,
		definitionHash: hash(json(definition)),
		page: 'automation/Page',
		feature: spec,
		files: Object.fromEntries(Object.entries(output).map(([p, c]) => [p.slice(prefix.length + 1), hash(c)]))
	});
	return output;
}

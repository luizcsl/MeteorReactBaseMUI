import { fail } from './lib.mjs';

// Validate the whole invocation before reading input files or performing mutations.
const commands = {
	doctor: {},
	'module:new': { values: ['--spec'], required: ['--spec'] },
	'recipe:new': { values: ['--definition'], required: ['--definition'] },
	'module:integrate': { values: ['--plan', '--apply'], oneOf: ['--plan', '--apply'] },
	'module:evolve': { values: ['--plan', '--apply', '--recover'], oneOf: ['--plan', '--apply', '--recover'] },
	'agent:context': { values: ['--task'], required: ['--task'] },
	'agent:graph': {},
	'task:validate': { values: ['--task'], required: ['--task'] },
	'task:state': { values: ['--task', '--evidence'], required: ['--task', '--evidence'] },
	'patch:check': { values: ['--task'], required: ['--task'] },
	'boundaries:check': {},
	'docs:verify': {},
	'templates:verify': {},
	'check:changed': {},
	'migration:export': { values: ['--store', '--plan'], flags: ['--apply'], required: ['--store', '--plan'] },
	'migration:restore-rehearsal': { values: ['--store', '--id'], required: ['--store', '--id'] }
};

export function parseArguments(command, args) {
	if (command !== '--help' && !Object.hasOwn(commands, command)) fail('usage', 'Unknown or missing command');
	const spec = commands[command] || {};
	const options = new Map();
	for (let index = 0; index < args.length; index++) {
		const name = args[index];
		if (options.has(name)) fail('usage', `Duplicate option: ${name}`);
		if (['--help', '--json', ...(spec.flags || [])].includes(name)) options.set(name, true);
		else if ((spec.values || []).includes(name)) {
			const value = args[++index];
			if (!value || value.startsWith('--')) fail('usage', `Required ${name} VALUE`);
			options.set(name, value);
		} else fail('usage', `Unexpected argument: ${name}`);
	}
	if (command === '--help' || options.has('--help')) return options;
	for (const name of spec.required || []) if (!options.has(name)) fail('usage', `Required ${name} VALUE`);
	if (spec.oneOf && spec.oneOf.filter((name) => options.has(name)).length !== 1)
		fail('usage', `Specify exactly one of ${spec.oneOf.join(', ')}`);
	return options;
}

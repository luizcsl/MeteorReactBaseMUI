#!/usr/bin/env node
// MCP stdio adapter: bounded JSON-RPC, fixed tool dispatch, no shell/program parameters.
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../catalog/registry.mjs';
import { planAutomation } from '../planner/plan.mjs';
import { applyAutomation } from '../runner/execute.mjs';
import { inspectAutomation } from '../planner/impact.mjs';
import { verifyAutomation, reportAutomation } from '../validation/evidence.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tools = [
	[
		'catalog',
		{ capability: { type: 'string', pattern: '^(0[1-9]|[1-4][0-9]|5[0-5])$' }, schemas: { type: 'boolean' } }
	],
	['inspect', { input: { type: 'object' } }],
	[
		'plan',
		{
			input: {
				type: 'object',
				required: ['schemaVersion', 'operations'],
				additionalProperties: false,
				properties: {
					schemaVersion: { const: 1 },
					operations: {
						type: 'array',
						minItems: 1,
						maxItems: 32,
						items: {
							type: 'object',
							required: ['id', 'kind', 'input'],
							additionalProperties: false,
							properties: {
								id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' },
								kind: { enum: ['feature', 'project', 'evolve', 'integrate', 'codemod'] },
								input: {
									type: 'object',
									description: 'Get the selected strict schema via toolkit.catalog with capability and schemas:true.'
								},
								dependsOn: { type: 'array', uniqueItems: true, items: { type: 'string' } }
							}
						}
					}
				}
			}
		}
	],
	['apply', { plan: { type: 'object' }, approval: { type: 'object' } }],
	['verify', { options: { type: 'object' } }],
	['report', { plan: { type: 'object' }, evidence: { type: 'object' } }]
].map(([name, properties]) => ({
	name: 'toolkit.' + name,
	description: `Deterministic ${name}; unsupported contracts fail closed.`,
	inputSchema: {
		type: 'object',
		properties,
		additionalProperties: false,
		required: name === 'plan' ? ['input'] : name === 'apply' || name === 'report' ? ['plan'] : []
	}
}));
export async function dispatch(message) {
	if (message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC');
	if (message.method === 'initialize')
		return {
			protocolVersion: '2024-11-05',
			capabilities: { tools: {} },
			serverInfo: { name: 'meteor-development-automation', version: '1.0.0' }
		};
	if (message.method === 'tools/list') return { tools };
	if (message.method !== 'tools/call') throw new Error('Unknown method');
	const { name, arguments: a = {} } = message.params ?? {};
	const tool = tools.find((t) => t.name === name);
	if (
		!tool ||
		!a ||
		typeof a !== 'object' ||
		Array.isArray(a) ||
		Object.keys(a).some((k) => !Object.hasOwn(tool.inputSchema.properties, k)) ||
		tool.inputSchema.required.some((k) => !Object.hasOwn(a, k))
	)
		throw new Error('Unknown tool or arguments');
	const handlers = {
		'toolkit.catalog': () => catalog(a),
		'toolkit.inspect': () => inspectAutomation(root, a.input),
		'toolkit.plan': () => planAutomation(root, a.input),
		'toolkit.apply': () => applyAutomation(root, a.plan, a.approval),
		'toolkit.verify': () => verifyAutomation(root, a.options),
		'toolkit.report': () => reportAutomation(a.plan, a.evidence)
	};
	try {
		const value = await handlers[name]();
		return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
	} catch (error) {
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						schemaVersion: 1,
						status: error.rule === 'needs-review' ? 'needs-review' : 'blocked',
						diagnostics: [
							{ code: error.rule ?? error.code ?? 'automation-error', message: error.message, path: error.file ?? '' }
						]
					})
				}
			],
			isError: true
		};
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		let message;
		try {
			if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Request exceeds 2 MiB');
			message = JSON.parse(line);
			if (message.id === undefined) continue;
			const result = await dispatch(message);
			process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
		} catch (error) {
			process.stdout.write(
				JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32602, message: error.message } }) +
					'\n'
			);
		}
	}
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateDefinition } from '../../recipes.mjs';
const error = (message) => {
	throw new Error(`services: ${message}`);
};
function object(value, keys, required = keys) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		error('expected plain object');
	if (
		Reflect.ownKeys(value).some(
			(k) =>
				typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value')
		) ||
		required.some((k) => !Object.hasOwn(value, k))
	)
		error('unknown or missing property');
	return value;
}
const integer = (v, min, max) => {
	if (!Number.isSafeInteger(v) || v < min || v > max) error(`expected integer ${min}..${max}`);
	return v;
};
const text = (v, max = 160) => {
	if (typeof v !== 'string' || !v.length || v.length > max || /[\x00]/.test(v)) error('invalid text');
	return v;
};
const identifier = (v) => {
	text(v, 40);
	if (!/^[a-z][A-Za-z0-9]*$/.test(v) || ['constructor', 'prototype', '__proto__'].includes(v))
		error('invalid identifier');
	return v;
};
function array(v, max = 30) {
	if (
		!Array.isArray(v) ||
		v.length < 1 ||
		v.length > max ||
		Reflect.ownKeys(v).length !== v.length + 1 ||
		Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i))).some(
			(d) => !d || !Object.hasOwn(d, 'value')
		)
	)
		error('expected bounded dense array');
	return v;
}
function strings(v, max = 30) {
	array(v, max).forEach((x) => text(x));
	if (new Set(v).size !== v.length) error('duplicate values');
	return v;
}
function apiSchema(v, depth = 0) {
	if (depth > 6) error('OpenAPI schema too deep');
	object(v, ['type', 'properties', 'required', 'items', 'additionalProperties', 'maxLength', 'maxItems'], ['type']);
	if (!['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(v.type))
		error('unsupported OpenAPI type');
	if (v.type === 'object') {
		if (v.additionalProperties !== false) error('OpenAPI objects require additionalProperties:false');
		if (!v.properties || typeof v.properties !== 'object' || Array.isArray(v.properties))
			error('object properties required');
		object(v.properties, Object.keys(v.properties), []);
		const keys = Object.keys(v.properties);
		if (keys.length > 30) error('too many properties');
		keys.forEach(identifier);
		keys.forEach((k) => apiSchema(v.properties[k], depth + 1));
		if (v.required !== undefined) {
			strings(v.required);
			if (v.required.some((k) => !keys.includes(k))) error('unknown required property');
		}
	} else if (v.properties !== undefined || v.required !== undefined || v.additionalProperties !== undefined)
		error('object-only keywords');
	if (v.type === 'array') {
		if (!v.items) error('array items required');
		apiSchema(v.items, depth + 1);
		integer(v.maxItems, 1, 1000);
	} else if (v.items !== undefined || v.maxItems !== undefined) error('array-only keywords');
	if (v.maxLength !== undefined) {
		if (v.type !== 'string') error('string-only maxLength');
		integer(v.maxLength, 1, 65536);
	}
	return v;
}
function apiContract(v) {
	object(v, ['openapi']);
	const o = object(v.openapi, ['openapi', 'info', 'servers', 'paths']);
	if (!/^3\.0\.\d+$/.test(o.openapi)) error('only OpenAPI 3.0 supported');
	object(o.info, ['title', 'version']);
	text(o.info.title);
	text(o.info.version);
	array(o.servers, 1);
	object(o.servers[0], ['url']);
	let url;
	try {
		url = new URL(o.servers[0].url);
	} catch {
		error('invalid server URL');
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.hostname === 'localhost' ||
		/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
		url.hostname.includes(':')
	)
		error('HTTPS public hostname required');
	const paths = o.paths;
	if (
		!paths ||
		typeof paths !== 'object' ||
		Array.isArray(paths) ||
		Object.keys(paths).length > 20 ||
		!Object.keys(paths).length
	)
		error('expected 1..20 paths');
	object(paths, Object.keys(paths), []);
	const operations = [],
		ids = new Set();
	for (const [route, item] of Object.entries(paths)) {
		if (!/^\/[A-Za-z0-9_/-]*$/.test(route) || route.includes('//') || route.includes('..'))
			error('only literal paths supported');
		object(item, ['get', 'post'], []);
		if (!Object.keys(item).length) error('empty path');
		for (const [method, raw] of Object.entries(item)) {
			const op = object(raw, ['operationId', 'requestBody', 'responses'], ['operationId', 'responses']);
			identifier(op.operationId);
			if (ids.has(op.operationId)) error('duplicate operationId');
			ids.add(op.operationId);
			let input = null;
			if (op.requestBody !== undefined) {
				if (method !== 'post') error('GET body unsupported');
				object(op.requestBody, ['required', 'content']);
				if (op.requestBody.required !== true) error('request body must be required');
				object(op.requestBody.content, ['application/json']);
				object(op.requestBody.content['application/json'], ['schema']);
				input = apiSchema(op.requestBody.content['application/json'].schema);
			}
			const responses = op.responses;
			if (!responses || typeof responses !== 'object' || Object.keys(responses).length !== 1)
				error('exactly one success response required');
			object(responses, Object.keys(responses), []);
			const status = Object.keys(responses)[0];
			if (!/^2\d\d$/.test(status)) error('success status required');
			const response = object(responses[status], ['description', 'content']);
			text(response.description, 1000);
			object(response.content, ['application/json']);
			object(response.content['application/json'], ['schema']);
			const output = apiSchema(response.content['application/json'].schema);
			operations.push({
				id: op.operationId,
				method: method.toUpperCase(),
				path: route,
				input,
				output,
				status: Number(status)
			});
		}
	}
	return { baseUrl: url.href.replace(/\/$/, ''), operations };
}
export function validateServices(input, definition) {
	const d = validateDefinition(definition);
	const s = object(
		input,
		['attachments', 'csv', 'notifications', 'jobs', 'search', 'audit', 'api', 'reports', 'dependencies'],
		[]
	);
	if (!Object.keys(s).length) error('select at least one service');
	if (d.profile === 'master-detail') error('needs-design: explicit parent scope services not yet supported');
	const fields = new Map(d.fields.map((f) => [f.name, f]));
	const checkFields = (names) => {
		strings(names);
		if (names.some((n) => !fields.has(n))) error('unknown field');
	};
	if (s.attachments) {
		object(s.attachments, ['maxBytes', 'mimeTypes']);
		integer(s.attachments.maxBytes, 1, 20_000_000);
		strings(s.attachments.mimeTypes, 10);
		if (
			s.attachments.mimeTypes.some(
				(m) =>
					![
						'application/pdf',
						'image/png',
						'image/jpeg',
						'text/plain',
						'text/csv',
						'application/octet-stream'
					].includes(m)
			)
		)
			error('unsupported attachment MIME');
	}
	if (s.csv) {
		object(s.csv, ['fields', 'maxRows']);
		checkFields(s.csv.fields);
		integer(s.csv.maxRows, 1, 10000);
		if (d.fields.some((f) => f.required && !s.csv.fields.includes(f.name))) error('CSV requires every mandatory field');
	}
	if (s.notifications) {
		object(s.notifications, ['events', 'subjectTemplate', 'textTemplate']);
		strings(s.notifications.events, 20).forEach(identifier);
		text(s.notifications.subjectTemplate, 200);
		text(s.notifications.textTemplate, 10000);
		for (const template of [s.notifications.subjectTemplate, s.notifications.textTemplate]) {
			const stripped = template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, name) => {
				if (!fields.has(name)) error('unknown template field');
				return '';
			});
			if (/[{}]/.test(stripped)) error('unsupported template syntax');
		}
	}
	if (s.jobs) {
		object(s.jobs, ['maxAttempts', 'leaseMs']);
		integer(s.jobs.maxAttempts, 1, 10);
		integer(s.jobs.leaseMs, 1000, 3600000);
	}
	if (s.search) {
		object(s.search, ['fields', 'pageSize']);
		checkFields(s.search.fields);
		if (s.search.fields.some((f) => !d.filters.includes(f))) error('search fields must be recipe filters');
		integer(s.search.pageSize, 1, 100);
	}
	if (s.audit) {
		object(s.audit, ['events', 'retentionDays']);
		strings(s.audit.events, 30).forEach(identifier);
		integer(s.audit.retentionDays, 1, 3650);
	}
	if (s.api) apiContract(s.api);
	if (s.reports) {
		object(s.reports, ['metrics']);
		array(s.reports.metrics, 20);
		const names = new Set();
		for (const m of s.reports.metrics) {
			object(m, ['name', 'op', 'field'], ['name', 'op']);
			identifier(m.name);
			if (names.has(m.name)) error('duplicate metric');
			names.add(m.name);
			if (!['count', 'sum'].includes(m.op)) error('unsupported metric');
			if (m.op === 'sum' && !['integer', 'money'].includes(fields.get(m.field)?.type))
				error('sum requires numeric field');
			if (m.op === 'count' && m.field !== undefined) error('count does not accept field');
		}
	}
	if (s.dependencies) {
		object(s.dependencies, ['updates']);
		array(s.dependencies.updates, 30);
		const names = new Set();
		for (const u of s.dependencies.updates) {
			object(u, ['name', 'from', 'to']);
			if (typeof u.name !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(u.name))
				error('invalid package');
			if (names.has(u.name)) error('duplicate dependency');
			names.add(u.name);
			if(typeof u.from !== 'string' || !u.from.length || u.from.length>160 || !/[0-9*xX]/.test(u.from) || !/^[0-9A-Za-z*~^<>=|.+ -]+$/.test(u.from))error('current registry dependency declaration required');
			if(typeof u.to !== 'string' || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(u.to))error('exact dependency target version required');
			if (u.from === u.to) error('dependency versions identical');
		}
	}
	// Reject explicitly undefined/null service selections rather than silently omitting them.
	if (Object.values(s).some((v) => !v)) error('service config required');
	return structuredClone(s);
}
function tsType(schema) {
	if (!schema) return 'null';
	if (schema.type === 'object')
		return (
			'{ ' +
			Object.entries(schema.properties)
				.map(([k, v]) => JSON.stringify(k) + (schema.required?.includes(k) ? '' : '?') + ': ' + tsType(v))
				.join('; ') +
			' }'
		);
	if (schema.type === 'array') return `Array<${tsType(schema.items)}>`;
	return schema.type === 'integer' ? 'number' : schema.type;
}
export function renderServices({ definition, services }, root) {
	const d = validateDefinition(definition),
		s = validateServices(services, d),
		base = `imports/modules/${d.name}/generated/services`,
		files = {};
	const runtime = { ...s };
	delete runtime.api;
	delete runtime.dependencies;
	files[`${base}/config.ts`] =
		`// Generated bounded service configuration. No secrets.\nexport const serviceConfig = ${JSON.stringify(runtime, null, 2)} as const;\n`;
	const factories = [];
	const imports = [];
	for (const [key, factory, port, portType] of [
		['attachments', 'attachmentService', 'store', 'AttachmentStore'],
		['csv', 'csvService', null, null],
		['notifications', 'notificationService', 'provider', 'NotificationProvider'],
		['search', 'searchService', 'query', 'QueryPort'],
		['audit', 'auditService', 'audit', 'AuditPort'],
		['reports', 'reportService', 'query', 'QueryPort']
	])
		if (s[key]) {
			imports.push(factory, ...(portType ? ['type ' + portType] : []));
			factories.push(
				`export const create${key[0].toUpperCase() + key.slice(1)} = (ports: RecipePorts${port ? `, ${port}: ${portType}` : ''}) => ${factory}(definition, ${JSON.stringify(s[key])}, ports${port ? `, ${port}` : ''});`
			);
		}
	files[`${base}/server/create.ts`] =
		`// Server composition: supply trusted ports, then expose only through existing operationHandler/registerRecipe wrappers.\nimport { definition } from '../../definition';\nimport type { RecipePorts } from '../../../../../core/recipes/server/engine';\n${imports.length ? `import { ${[...new Set(imports)].join(', ')} } from '../../../../../automationServices/server/runtime';` : ''}\n${s.jobs ? `import { durableJobs, type DurableCollection } from '../../../../../automationServices/server/jobs';\nexport const createJobs = (collection: DurableCollection) => durableJobs(${JSON.stringify(s.jobs)}, collection);` : ''}\n${factories.join('\n')}\n`;
	const remoteOperations = [];
	const adapters = {};
	const addOperation = (name, schema, factory, method, args, effect) =>
		remoteOperations.push({ name, schema, factory, method, args, effect });
	if (s.search) {
		adapters.query = { type: 'QueryPort', methods: ['find', 'aggregate'] };
		addOperation('search', 'search', 'search', 'page', 'input', 'read');
	}
	if (s.reports) {
		adapters.query = { type: 'QueryPort', methods: ['find', 'aggregate'] };
		addOperation('report', 'report', 'reports', 'run', 'input.filters', 'read');
	}
	if (s.csv) {
		addOperation('importCsv', 'import', 'csv', 'import', 'input.text, input.mutationPrefix', 'write');
		addOperation('exportCsv', 'export', 'csv', 'export', 'input.filters', 'read');
	}
	if (s.audit) {
		adapters.audit = { type: 'AuditPort', methods: ['append', 'list'] };
		addOperation('history', 'history', 'audit', 'history', 'input.documentId', 'read');
	}
	if (s.attachments) {
		adapters.attachments = {
			type: 'AttachmentStore',
			methods: ['putPrivate', 'removePrivate', 'canReadFile', 'linked', 'link', 'readPrivate']
		};
		addOperation('uploadAttachment', 'upload', 'attachments', 'upload', 'input', 'write');
		addOperation('downloadAttachment', 'download', 'attachments', 'download', 'input', 'read');
	}
	if (s.notifications) {
		adapters.notifications = { type: 'NotificationProvider', methods: ['recipients', 'send'] };
		addOperation('notify', 'notify', 'notifications', 'emit', 'input.event, input.documentId, input.eventId', 'write');
	}
	files[`${base}/contracts.ts`] = `// Shared strict DTOs. No server imports or authority-bearing inputs.
import { definition } from '../definition';
import { serviceSchemas } from '../../../../automationServices/contracts';
import type { Schema } from '../../../../core/contracts/schema';
export type ReportMetrics = Record<${s.reports ? s.reports.metrics.map((m) => JSON.stringify(m.name)).join(' | ') : 'never'}, number>;
import { serviceConfig } from './config';
export type * from '../../../../automationServices/contracts';
const schemas = serviceSchemas(definition, serviceConfig);
export const serviceContracts = {
${remoteOperations.map((op) => `${op.name}: { input: schemas.${op.schema}Input, output: schemas.${op.schema}Output${op.name === 'report' ? ' as Schema<ReportMetrics>' : ''} }`).join(',\n')}
};
`;
	files[`${base}/client.ts`] = `// Online-only shared transport. Server identity is derived from the invocation.
import { callMethod } from '../../../../api/methodTransport';
import type { Infer } from '../../../../core/contracts/schema';
import { serviceContracts } from './contracts';
export function createServiceClient() { return {
${remoteOperations.map((op) => `${op.name}: async (input: Infer<typeof serviceContracts.${op.name}.input>): Promise<Infer<typeof serviceContracts.${op.name}.output>> => serviceContracts.${op.name}.output.parse(await callMethod<unknown>(${JSON.stringify(d.name + '.services.' + op.name)}, serviceContracts.${op.name}.input.parse(input)))`).join(',\n')}
}; }
`;
	const factoryNames = [...new Set(remoteOperations.map((op) => op.factory))];
	const factoryImport = (name) => 'create' + name[0].toUpperCase() + name.slice(1);
	const adapterFor = {
		search: 'query',
		reports: 'query',
		audit: 'audit',
		attachments: 'attachments',
		notifications: 'notifications'
	};
	files[`${base}/server/register.ts`] = `// Call once from the trusted server composition root with approved adapters.
import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { registerMethods } from '../../../../../api/server/registration';
import { ContractError } from '../../../../../core/contracts/schema';
import { OperationError } from '../../../../../core/contracts/errors';
import type { RecipePorts } from '../../../../../core/recipes/server/engine';
${Object.keys(adapters).length ? `import type { ${[...new Set(Object.values(adapters).map((a) => a.type))].join(', ')} } from '../../../../../automationServices/server/runtime';` : ''}
import { serviceContracts } from '../contracts';
${factoryNames.length ? `import { ${factoryNames.map(factoryImport).join(', ')} } from './create';` : ''}
export interface ServiceAdapters { ${Object.entries(adapters)
		.map(([name, a]) => `${name}${name === 'query' ? '?' : ''}: ${a.type}`)
		.join('; ')} }
let registered = false;
export function registerServices(ports: RecipePorts, adapters: ServiceAdapters${Object.keys(adapters).some((name) => name !== 'query') ? '' : ' = {}'}) {
 if (!Meteor.isServer) throw new Error('Services are server-only');
 if (registered) throw new Error('Services already registered');
 ${adapters.query ? 'const queryAdapter = adapters.query ?? ports.repository.query;' : ''}
 ${Object.entries(adapters)
		.map(
			([name, a]) =>
				`if (!${name === 'query' ? 'queryAdapter' : 'adapters?.' + name} || ${JSON.stringify(a.methods)}.some(key => typeof (${name === 'query' ? 'queryAdapter' : 'adapters.' + name} as unknown as Record<string, unknown>)[key] !== 'function')) throw new Error('Missing approved ${name} adapter');`
		)
		.join('\n ')}
 ${factoryNames.map((name) => `const ${name} = ${factoryImport(name)}(ports${adapterFor[name] ? `, ${adapterFor[name] === 'query' ? 'queryAdapter' : 'adapters.' + adapterFor[name]}` : ''});`).join('\n ')}
 registerMethods({
 ${remoteOperations
		.map(
			(
				op
			) => `${JSON.stringify(d.name + '.services.' + op.name)}: async function (this: {userId:string|null}, ...args: unknown[]) {
  try { if (args.length !== 1) throw new OperationError('invalid-input'); const input = serviceContracts.${op.name}.input.parse(args[0]); return serviceContracts.${op.name}.output.parse(await ${op.factory}.${op.method}(this.userId, ${op.args})); }
  catch (error) { if (error instanceof OperationError || error instanceof ContractError) throw new Meteor.Error(error.code, error.code); throw new Meteor.Error('internal-error','Service operation failed'); }
 }`
		)
		.join(',\n')}
 });
 ${remoteOperations
		.map(
			(
				op
			) => `DDPRateLimiter.addRule({type:'method',name:${JSON.stringify(d.name + '.services.' + op.name)},connectionId:()=>true}, ${op.effect === 'write' ? 20 : 60},60000);
 DDPRateLimiter.addRule({type:'method',name:${JSON.stringify(d.name + '.services.' + op.name)},userId:(value:string|null)=>!!value}, ${op.effect === 'write' ? 40 : 120},60000);`
		)
		.join('\n ')}
 registered = true;
}
`;
	files[`${base}/registration.json`] =
		JSON.stringify(
			{
				schemaVersion: 1,
				server: 'generated/services/server/register.ts',
				export: 'registerServices',
				client: 'generated/services/client.ts',
				clientExport: 'createServiceClient',
				adapterSource: 'custom/server/servicePorts.ts',
				adapterExport: 'serviceAdapters',
				requiredAdapters: Object.keys(adapters).filter((name) => name !== 'query'),
				optionalAdapters: adapters.query ? ['query'] : [],
				operations: remoteOperations.map((op) => ({ name: d.name + '.services.' + op.name, effect: op.effect })),
				serverOnly: ['jobs', 'audit.append', 'externalApi']
			},
			null,
			2
		) + '\n';
	if (s.reports)
		files[`${base}/ConnectedReportDashboard.tsx`] =
			`// Connects the generated view to its registered scoped service. No raw transport.
import React, { useCallback, useMemo } from 'react';
import type { RecipeData } from '../../../../core/recipes/definition';
import { createServiceClient } from './client';
import ReportDashboard, { type MetricMap } from './ReportDashboard';
export default function ConnectedReportDashboard({scopeKey,filters}:{scopeKey:string;filters:RecipeData}) {
 const client = useMemo(() => createServiceClient(), []);
 const filterKey = JSON.stringify(Object.entries(filters).sort(([a],[b])=>a.localeCompare(b)));
 const load = useCallback(() => client.report({filters:JSON.parse(filterKey).reduce((result:RecipeData,[key,value]:[string,RecipeData[string]])=>({...result,[key]:value}),{})}).then(value=>value as MetricMap),[client,filterKey]);
 return <ReportDashboard scopeKey={JSON.stringify([scopeKey,filterKey])} load={load}/>;
}
`;

	if (s.api) {
		const api = apiContract(s.api);
		files[`${base}/server/api.ts`] =
			`import { externalClient, type ApiTransport } from '../../../../../automationServices/server/api';\nexport { ExternalApiError, mockTransport } from '../../../../../automationServices/server/api';\n${api.operations.map((op) => `export type ${op.id}Input = ${tsType(op.input)};\nexport type ${op.id}Output = ${tsType(op.output)};`).join('\n')}\nexport function createApi(transport: ApiTransport) { const client = externalClient(${JSON.stringify(api.baseUrl)}, ${JSON.stringify(api.operations)}, transport); return {\n${api.operations.map((op) => `${op.id}: (input: ${op.id}Input): Promise<${op.id}Output> => client.call(${JSON.stringify(op.id)}, input) as Promise<${op.id}Output>`).join(',\n')}\n}; }\n`;
	}
	if (s.reports) {
		files[`${base}/ReportDashboard.tsx`] =
			`// Generated report view. Supply a memoized load using the approved typed callMethod wrapper.
// scopeKey MUST change on account, tenant or filter changes. It is a UI isolation key, never authorization proof.
import React, { useEffect, useId, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CircularProgress, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
export const metricNames = ${JSON.stringify(s.reports.metrics.map((m) => m.name))} as const;
export type MetricName = typeof metricNames[number];
export type MetricMap = Record<MetricName, number>;
const countMetricNames: readonly MetricName[] = ${JSON.stringify(s.reports.metrics.filter((m) => m.op === 'count').map((m) => m.name))};
export interface ReportDashboardProps { scopeKey: string; load: () => Promise<MetricMap> }
export function validateMetricMap(value: unknown): MetricMap {
 if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid report');
 const record = value as Record<string, unknown>;
 if (Reflect.ownKeys(record).length !== metricNames.length || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !metricNames.includes(key as MetricName))) throw new Error('Invalid report');
 for (const key of metricNames) { const descriptor = Object.getOwnPropertyDescriptor(record, key); if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value)) throw new Error('Invalid report'); }
 return Object.fromEntries(metricNames.map(key => [key, record[key]])) as MetricMap;
}
type State = { scopeKey: string; phase: 'loading' | 'error' | 'ready'; data: MetricMap | null };
export default function ReportDashboard({scopeKey, load}: ReportDashboardProps) {
 const headingId = useId();
 const [refresh, setRefresh] = useState(0);
 const [state, setState] = useState<State>({scopeKey, phase:'loading', data:null});
 useEffect(() => {
  let cancelled = false;
  setState({scopeKey, phase:'loading', data:null});
  Promise.resolve().then(load).then(value => {
   const data = validateMetricMap(value);
   if (!cancelled) setState({scopeKey, phase:'ready', data});
  }).catch(() => { if (!cancelled) setState({scopeKey, phase:'error', data:null}); });
  return () => { cancelled = true; };
 }, [scopeKey, load, refresh]);
 // Never paint old-scope results while awaiting effect cleanup after a scope change.
 const visible = state.scopeKey === scopeKey ? state : {scopeKey, phase:'loading' as const, data:null};
 return <Box component="section" aria-labelledby={headingId} aria-busy={visible.phase === 'loading'}>
  <Typography id={headingId} component="h2" variant="h5">Report dashboard</Typography>
  <Button onClick={() => setRefresh(value => value + 1)} disabled={visible.phase === 'loading'} aria-label="Refresh report">Refresh</Button>
  {visible.phase === 'loading' && <Box role="status"><CircularProgress size={24} aria-label="Loading report" /><Typography>Loading report…</Typography></Box>}
  {visible.phase === 'error' && <Alert severity="error">Unable to load this report. Try Refresh.</Alert>}
  {visible.phase === 'ready' && visible.data && <>
   {countMetricNames.length > 0 && countMetricNames.every(name => visible.data![name] === 0) && <Alert severity="info">No activity for this selection.</Alert>}
   {countMetricNames.length === 0 && metricNames.every(name => visible.data![name] === 0) && <Alert severity="info">All metrics are zero for this selection.</Alert>}
   <Box sx={{display:'grid', gridTemplateColumns:{xs:'1fr', sm:'repeat(2, minmax(0, 1fr))'}, gap:2}}>
    {metricNames.map(name => <Card key={name}><CardContent><Typography component="h3" variant="subtitle1">{name}</Typography><Typography variant="h4">{visible.data![name].toLocaleString()}</Typography></CardContent></Card>)}
   </Box>
   <TableContainer><Table size="small"><caption>Authorized report metrics</caption><TableHead><TableRow><TableCell>Metric</TableCell><TableCell align="right">Value</TableCell></TableRow></TableHead><TableBody>
    {metricNames.map(name => <TableRow key={name}><TableCell component="th" scope="row">{name}</TableCell><TableCell align="right">{visible.data![name].toLocaleString()}</TableCell></TableRow>)}
   </TableBody></Table></TableContainer>
  </>}
 </Box>;
}
`;
	}

	if (s.dependencies) {
		let current = null;
		if (root) {
			current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
			for (const u of s.dependencies.updates)
				if ((current.dependencies?.[u.name] ?? current.devDependencies?.[u.name]) !== u.from)
					error(`dependency precondition mismatch: ${u.name}`);
		}
		files[`${base}/dependency-review.json`] =
			JSON.stringify(
				{
					schemaVersion: 1,
					status: 'needs-review',
					automaticInstall: false,
					updates: s.dependencies.updates,
					packageHash: current
						? createHash('sha256')
								.update(fs.readFileSync(path.join(root, 'package.json')))
								.digest('hex')
						: null,
					steps: [
						'Review release notes and security advisories for each exact target version.',
						'Approve package manifest and lockfile changes separately.',
						'Use the existing package manager to update lockfile in an isolated environment.',
						'Run doctor, typecheck, test:toolkit, verify and integration/browser gates.',
						'Review diff and rollback plan before integration.'
					]
				},
				null,
				2
			) + '\n';
	}
	files[`${base}/integration.json`] =
		JSON.stringify(
			{
				schemaVersion: 1,
				status: 'needs-integration',
				services: Object.keys(s),
				required: [
					'Supply server-owned active-account/membership RecipePorts.',
					'Supply approved durable/private/provider ports for selected services.',
					'Call generated registerServices with trusted RecipePorts and approved serviceAdapters; generated DTO validation, shared registration and rate limits are mandatory.',
					'Execute independent adapter, real database/DDP and browser qualification before release.'
				],
				limitations: [
					'CSV only; XLSX unsupported.',
					'Jobs are at-least-once; handlers must enforce idempotency and fencing of side effects.',
					'OpenAPI supports only literal GET/POST paths and bounded JSON schemas; no refs, polymorphism, parameters or automatic credentials.',
					'Reports generate scoped count/sum metrics and ReportDashboard cards/table. Wire its memoized load via an approved registered typed callMethod, and change scopeKey on account, tenant or filter changes. Arbitrary grouping and chart types are unsupported.',
					'Audit append is explicit; atomic business-write plus audit requires a reviewed transaction/outbox integration.'
				]
			},
			null,
			2
		) + '\n';
	return files;
}

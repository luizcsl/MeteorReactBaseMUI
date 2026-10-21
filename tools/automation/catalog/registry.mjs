import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exact, fail, confined } from '../../lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rows = [
	[
		1,
		'project-profile',
		'project',
		'P0',
		'Compose owner-app or tenant-app features in an existing boilerplate; no package/auth installation'
	],
	[2, 'owner-crud', 'feature', 'P0', 'Owner policy only; explicit permissions'],
	[3, 'tenant-crud', 'feature', 'P0', 'Trusted reviewed membership ports required'],
	[4, 'master-detail', 'feature', 'P1', 'Scoped parentExists; transactional cascading lifecycle requires design'],
	[5, 'approval', 'feature', 'P0', 'Explicit states, transitions and reviewer roles'],
	[6, 'domain-contracts', 'feature', 'P0', 'Bounded string/integer/boolean/enum/date/money/reference'],
	[7, 'cross-field-rules', 'feature', 'P0', 'lte rule only; unknown expressions rejected'],
	[
		8,
		'business-workflow',
		'feature',
		'P1',
		'Explicit finite state transitions; timers and arbitrary conditions require design'
	],
	[9, 'typed-ddp-methods', 'feature', 'P0', 'Consolidated registerMethods/callMethod; strict DTO and projection'],
	[
		10,
		'reactive-publications',
		'feature',
		'P1',
		'Trusted identity observation and bounded scoped projections required'
	],
	[11, 'rbac-abac', 'feature', 'P0', 'owner/member/reviewer matrix; arbitrary ABAC expressions unsupported'],
	[12, 'identity-adapters', 'feature', 'P0', 'Server-owned active account and membership sources, never DTO roles'],
	[
		13,
		'relationships',
		'feature',
		'P1',
		'Scoped references and parent ports; cross-collection transactions require design'
	],
	[14, 'private-attachments', 'services', 'P2', 'Explicit private storage and authorization ports'],
	[15, 'import-export', 'services', 'P2', 'Bounded CSV; XLSX requires separate approved adapter'],
	[16, 'notifications', 'services', 'P2', 'Explicit event/recipient/provider ports; no guessed recipients'],
	[17, 'durable-jobs', 'services', 'P2', 'Durable Mongo leases, bounded retries; external effects require idempotency'],
	[
		18,
		'search-pagination-indexes',
		'services',
		'P1',
		'Scoped bounded query/cursor; index plans do not change production'
	],
	[19, 'audit-history', 'services', 'P1', 'Append events and retention policy; no automatic deletion'],
	[20, 'openapi-client', 'services', 'P2', 'Bounded OpenAPI subset; no credential generation or storage'],
	[21, 'reports', 'services', 'P2', 'Scoped count/sum metrics only'],
	[22, 'schema-forms', 'ui', 'P0', 'Typed RecipeForm metadata'],
	[
		23,
		'advanced-grid',
		'ui',
		'P0',
		'MUI X with scoped server cursors when search configured; explicit loaded-window fallback'
	],
	[24, 'list-detail-edit', 'ui', 'P0', 'List-detail layout'],
	[25, 'wizard', 'ui', 'P0', 'Validated steps with opt-in identity-scoped 30-minute session persistence'],
	[26, 'bulk-dialogs', 'ui', 'P0', 'Bounded selection and confirmation'],
	[27, 'interface-states', 'ui', 'P0', 'Loading/empty/error/pending/conflict'],
	[28, 'internationalization', 'ui', 'P1', 'Explicit supported en/pt-BR catalog'],
	[29, 'design-system-layout', 'ui', 'P0', 'Approved MUI components/density tokens'],
	[30, 'stories-mocks-preview', 'ui', 'P1', 'Controlled fixtures; no backend mutation'],
	[
		31,
		'accessibility-responsive',
		'ui',
		'P0',
		'Semantic labels and responsive MUI layout; browser audit still required'
	],
	[32, 'add-field', 'evolve', 'P0', 'Metadata evolution; required field backfill separately reviewed'],
	[33, 'add-filter', 'evolve', 'P0', 'Existing declared field only'],
	[34, 'add-state-transition', 'evolve', 'P0', 'Validated state machine'],
	[35, 'replace-permissions', 'evolve', 'P1', 'Exact plan security review required'],
	[36, 'rename-field', 'codemod', 'P1', 'Semantic TypeScript symbols, separate data migration descriptor'],
	[37, 'change-field-contract', 'codemod', 'P1', 'Supported primitive types/optionality; migration review'],
	[38, 'rename-module-route', 'codemod', 'P1', 'Resolved file moves and literal route variants'],
	[39, 'move-extract-symbol', 'codemod', 'P1', 'Supported exported declarations; ambiguous dependencies rejected'],
	[
		40,
		'modernize-legacy',
		'codemod',
		'P1',
		'Contract extraction and recognized registerMethod-to-core adapter; explicit policy/parser/projection and write-concurrency mappings'
	],
	[41, 'framework-migration', 'codemod', 'P1', 'Approved meteor-user-async recipe only'],
	[42, 'deprecate-remove', 'codemod', 'P1', 'Resolved usage checks and explicit review; protected files denied'],
	[43, 'fixtures', 'tests', 'P0', 'Deterministic synthetic valid/invalid data'],
	[44, 'contract-tests', 'tests', 'P0', 'Generated complements do not replace independent acceptance'],
	[45, 'authorization-matrix', 'tests', 'P0', 'Anonymous/owner/tenant/revocation negative invariants'],
	[46, 'e2e-scenarios', 'tests', 'P0', 'Generated Cypress journey; running Meteor/browser is required'],
	[47, 'property-tests', 'tests', 'P1', 'Bounded deterministic property cases'],
	[48, 'visual-comparison', 'tests', 'P2', 'Snapshot comparison runner; explicit baseline review'],
	[49, 'mutation-tests', 'verify', 'P0', 'Existing protected mutation runner remains mandatory'],
	[50, 'impact-tests', 'inspect', 'P1', 'AST reverse dependency closure; full gates remain mandatory'],
	[51, 'synchronized-docs', 'feature', 'P0', 'Generated domain/permission/state diagram reference'],
	[52, 'dependency-updates', 'services', 'P2', 'Reviewable dependency update plan; no automatic installation'],
	[53, 'minimal-context', 'inspect', 'P0', 'Bounded AST context and dependency graph'],
	[54, 'architecture-impact', 'inspect', 'P0', 'AST graph plus mandatory boundaries gate'],
	[
		55,
		'composed-orchestration',
		'plan/apply',
		'P0',
		'Sequential deterministic DAG, stale/tamper rejection and recovery'
	]
];
export function catalog(input = {}) {
	exact(input, ['capability', 'schemas'], []);
	if (input.schemas !== undefined && typeof input.schemas !== 'boolean')
		fail('automation-catalog', 'schemas must be boolean');
	if (
		input.capability !== undefined &&
		(typeof input.capability !== 'string' || !rows.some((row) => String(row[0]).padStart(2, '0') === input.capability))
	)
		fail('automation-catalog', 'capability must be one of 01 through 55');
	const result = {
		schemaVersion: 1,
		engineVersion: '1.0.0',
		tools: ['toolkit.catalog', 'toolkit.inspect', 'toolkit.plan', 'toolkit.apply', 'toolkit.verify', 'toolkit.report'],
		inputSchemas: {
			request: 'tools/automation/contracts/operation.v1.schema.json',
			feature: 'tools/automation/contracts/feature.v3.schema.json',
			result: 'tools/automation/contracts/result.v1.schema.json'
		},
		capabilities: rows.map(([id, name, executor, priority, limits]) => ({
			id: String(id).padStart(2, '0'),
			name,
			version: '1.0.0',
			executor,
			priority,
			status: [1, 4, 8, 13, 52].includes(id) ? 'partial' : 'supported',
			integration: ['services'].includes(executor) ? 'requires-approved-adapters' : 'explicit-composition',
			limits,
			inputSchema:
				executor === 'ui'
					? 'tools/automation/contracts/ui.v1.schema.json'
					: executor === 'services'
						? 'tools/automation/contracts/services.v1.schema.json'
						: executor === 'codemod'
							? 'tools/automation/codemods/operation.schema.json'
							: executor === 'feature'
								? 'tools/automation/contracts/feature.v3.schema.json'
								: 'tools/automation/contracts/operation.v1.schema.json',
			preconditions: [
				'Validated explicit business policy',
				'Unmodified generated manifests',
				'Trusted server adapters for identity and external effects'
			],
			allowedWrites:
				executor === 'verify' || executor === 'inspect' ? [] : ['imports/modules/<module>/', 'imports/integration/'],
			requiredTests: [
				'test:automation',
				'test:core',
				'test:mutations',
				'verify',
				'live integration/browser for runtime changes'
			]
		})),
		security: {
			transport: 'shared registerMethods/registerPublications/callMethod',
			qualification: 'external protected supervisor only',
			productionMigrations: 'never executed'
		},
		example: JSON.parse(fs.readFileSync(path.join(root, 'tools/automation/examples/owner-feature.json'), 'utf8'))
	};
	if (input.capability) result.capabilities = result.capabilities.filter((c) => c.id === input.capability);
	if (input.schemas) {
		const schemas = {};
		function collect(file) {
			if (schemas[file]) return;
			const schema = JSON.parse(fs.readFileSync(confined(root, file), 'utf8'));
			schemas[file] = schema;
			function refs(value) {
				if (!value || typeof value !== 'object') return;
				if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) {
					const reference = value.$ref.split('#')[0];
					if (reference.includes(':')) fail('automation-schema', 'Remote schema resolution disabled');
					collect(path.posix.normalize(path.posix.join(path.posix.dirname(file), reference)));
				}
				for (const child of Object.values(value)) refs(child);
			}
			refs(schema);
		}
		for (const capability of result.capabilities) collect(capability.inputSchema);
		result.schemas = schemas;
	}
	result.discovery =
		'Call toolkit.catalog with capability (01..55) and schemas:true for embedded schemas; no filesystem access required.';
	return result;
}

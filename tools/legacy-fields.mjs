// Bounded AST inspection of declared legacy field paths. Never executes module/UI/server code.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { confined, exact, fail, hash, relative } from './lib.mjs';
const metadataKeys = [
	'schema',
	'server',
	'validator',
	'publications',
	'controllers',
	'tests',
	'exposure',
	'requiredFieldPolicy'
];
export function validateLegacyMetadata(root, module, value) {
	exact(value, metadataKeys);
	if (
		!/^[a-z][a-z0-9]{2,31}$/.test(module) ||
		!['reject-unmigrated-writes', 'manual-review'].includes(value.requiredFieldPolicy)
	)
		fail('legacy-manifest', 'Invalid module/policy');
	const refs = [];
	const ref = (v) => {
		exact(v, ['file', 'symbol']);
		relative(v.file);
		if (typeof v.symbol !== 'string' || !v.symbol) fail('legacy-manifest', 'Expected symbol');
		const target = confined(root, v.file);
		if (!fs.statSync(target).isFile() || fs.statSync(target).size > 1024 * 1024)
			fail('legacy-budget', 'Reference exceeds 1 MiB', v.file);
		refs.push({ ...v, hash: hash(fs.readFileSync(target)) });
	};
	for (const key of ['schema', 'server', 'validator']) ref(value[key]);
	if (
		!Array.isArray(value.publications) ||
		!['list', 'detail'].every((consumer) => value.publications.some((p) => p?.consumer === consumer)) ||
		new Set(value.publications.map((p) => p?.name)).size !== value.publications.length
	)
		fail('legacy-manifest', 'List and detail publications with unique names are required');
	exact(value.controllers, ['list', 'detail']);
	ref(value.controllers.list);
	ref(value.controllers.detail);
	if (!Array.isArray(value.publications) || value.publications.length > 10 || !value.publications.length)
		fail('legacy-manifest', 'Expected publications');
	for (const p of value.publications) {
		exact(p, ['name', 'consumer', 'delegate']);
		if (
			typeof p.name !== 'string' ||
			!p.name ||
			!['list', 'detail'].includes(p.consumer) ||
			!['defaultListCollectionPublication', 'defaultDetailCollectionPublication'].includes(p.delegate)
		)
			fail('legacy-manifest', 'Invalid publication');
	}
	if (!Array.isArray(value.tests) || value.tests.length > 10 || !value.tests.length)
		fail('legacy-manifest', 'Expected test sources');
	for (const test of value.tests) {
		exact(test, ['file', 'symbol', 'command', 'assertions']);
		ref({ file: test.file, symbol: test.symbol });
		if (
			typeof test.command !== 'string' ||
			!/^npm run [a-z][a-z0-9:-]*$/.test(test.command) ||
			!Array.isArray(test.assertions) ||
			test.assertions.some((a) => typeof a !== 'string' || !a)
		)
			fail('legacy-manifest', 'Invalid test reference');
	}
	if (value.exposure !== null) {
		exact(value.exposure, [
			'file',
			'list',
			'listOmitted',
			'detail',
			'detailOmitted',
			'form',
			'formOmitted',
			'reducedSchema',
			'formView',
			'listView'
		]);
		for (const name of ['list', 'listOmitted', 'detail', 'detailOmitted', 'form', 'formOmitted'])
			ref({ file: value.exposure.file, symbol: value.exposure[name] });
		for (const key of ['reducedSchema', 'formView', 'listView']) ref(value.exposure[key]);
	}
	return { metadata: structuredClone(value), references: refs };
}
function inspector(root) {
	const cache = new Map();
	let bytes = 0,
		operations = 0;
	const read = (file) => {
		if (cache.has(file)) return cache.get(file);
		const target = confined(root, file),
			stat = fs.statSync(target);
		bytes += stat.size;
		if (!stat.isFile() || stat.size > 1024 * 1024 || bytes > 8 * 1024 * 1024 || cache.size >= 100)
			fail('legacy-budget', 'Inspection exceeded source bounds', file);
		const text = fs.readFileSync(target, 'utf8'),
			ast = ts.createSourceFile(
				file,
				text,
				ts.ScriptTarget.Latest,
				true,
				file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			);
		if (ast.parseDiagnostics.length) fail('legacy-syntax', 'Cannot inspect invalid TypeScript', file);
		const vars = new Map(),
			imports = new Map();
		function walk(n) {
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
				vars.set(n.name.text, { file, node: n.initializer });
			ts.forEachChild(n, walk);
		}
		walk(ast);
		for (const n of ast.statements)
			if (
				ts.isImportDeclaration(n) &&
				ts.isStringLiteral(n.moduleSpecifier) &&
				n.importClause?.namedBindings &&
				ts.isNamedImports(n.importClause.namedBindings)
			) {
				const spec = n.moduleSpecifier.text;
				if (!spec.startsWith('.')) continue;
				const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
				const resolved = [base + '.ts', base + '.tsx', base + '/index.ts'].find((p) =>
					fs.existsSync(confined(root, p, { missing: true }))
				);
				for (const e of n.importClause.namedBindings.elements)
					imports.set(e.name.text, { file: resolved, symbol: e.propertyName?.text ?? e.name.text });
			}
		const out = { file, text, ast, vars, imports };
		cache.set(file, out);
		return out;
	};
	function unwrap(ref) {
		let { node } = ref;
		while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
			node = node.expression;
		return { ...ref, node };
	}
	function binding(file, symbol) {
		const source = read(file);
		if (source.vars.has(symbol)) return source.vars.get(symbol);
		const imp = source.imports.get(symbol);
		if (!imp?.file) fail('legacy-expression', `Unresolved data symbol ${symbol}`, file);
		return binding(imp.file, imp.symbol);
	}
	function resolve(ref, seen = new Set()) {
		if (++operations > 10000) fail('legacy-budget', 'Inspection expression budget exceeded');
		ref = unwrap(ref);
		const n = ref.node;
		if (ts.isIdentifier(n)) {
			const key = ref.file + ':' + n.text;
			if (seen.has(key)) fail('legacy-expression', 'Cyclic data binding', ref.file);
			seen.add(key);
			return resolve(binding(ref.file, n.text), seen);
		}
		if (ts.isPropertyAccessExpression(n)) {
			const object = properties({ file: ref.file, node: n.expression });
			const child = object.get(n.name.text);
			if (!child) fail('legacy-expression', 'Unknown data property', ref.file);
			return resolve(child, seen);
		}
		return ref;
	}
	const key = (n) =>
		ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)
			? n.text
			: fail('legacy-expression', 'Computed metadata key');
	function properties(ref) {
		ref = resolve(ref);
		if (!ts.isObjectLiteralExpression(ref.node)) fail('legacy-expression', 'Expected explicit object', ref.file);
		const out = new Map();
		for (const p of ref.node.properties) {
			if (ts.isSpreadAssignment(p)) {
				for (const [k, v] of properties({ file: ref.file, node: p.expression })) out.set(k, v);
			} else if (ts.isPropertyAssignment(p)) out.set(key(p.name), { file: ref.file, node: p.initializer });
			else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, { file: ref.file, node: p.name });
			else fail('legacy-expression', 'Unsupported object metadata', ref.file);
		}
		return out;
	}
	function data(ref) {
		ref = resolve(ref);
		const n = ref.node;
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
		if (ts.isNumericLiteral(n)) return Number(n.text);
		if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (ts.isArrayLiteralExpression(n)) return n.elements.map((node) => data({ file: ref.file, node }));
		fail('legacy-expression', 'Expected literal data; executable expressions require review', ref.file);
	}
	function helper(ref, name) {
		const n = ref.node;
		if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return false;
		const imp = read(ref.file).imports.get(n.expression.text);
		return imp?.file === 'imports/legacy/exposure.ts' && imp.symbol === name;
	}
	function fields(ref) {
		ref = resolve(ref);
		if (helper(ref, 'legacyProjection')) return data({ file: ref.file, node: ref.node.arguments[0] });
		return [...properties(ref)].map(([key, v]) => {
			if (data(v) !== 1) fail('legacy-projection', 'Only inclusion projections are supported', ref.file);
			return key;
		});
	}
	function reduced(ref) {
		ref = resolve(ref);
		if (helper(ref, 'pickLegacySchema')) {
			const all = properties({ file: ref.file, node: ref.node.arguments[0] }),
				selection = data({ file: ref.file, node: ref.node.arguments[1] });
			if (selection.some((f) => !all.has(f)))
				fail('legacy-schema', 'Reduced schema references an unknown field', ref.file);
			return selection;
		}
		return [...properties(ref).keys()];
	}
	function calls(file, method) {
		const out = [];
		function walk(n) {
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === method)
				out.push(n);
			ts.forEachChild(n, walk);
		}
		walk(read(file).ast);
		return out;
	}
	return {
		read,
		binding,
		resolve,
		properties,
		data,
		fields,
		reduced,
		calls,
		hashes: () => Object.fromEntries([...cache].map(([file, s]) => [file, hash(s.text)]))
	};
}
const equal = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function inspectLegacyFields(root, module) {
	if (typeof module !== 'string' || !/^[a-z][a-z0-9]{2,31}$/.test(module)) fail('legacy-module', 'Invalid module');
	const manifestFile = `imports/modules/${module}/architecture.manifest.json`,
		target = confined(root, manifestFile);
	if (fs.statSync(target).size > 1024 * 1024) fail('legacy-budget', 'Manifest exceeds 1 MiB');
	const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
	if (manifest.architecture !== 'legacy' || !manifest.legacy)
		fail('legacy-manifest', 'An enriched legacy manifest is required', manifestFile);
	const { metadata: m, references } = validateLegacyMetadata(root, module, manifest.legacy);
	if (m.exposure === null)
		return {
			status: 'needs-review',
			module,
			diagnostics: [
				{
					rule: 'legacy-manual',
					file: manifestFile,
					message: 'Exposure is not configured for automatic field inspection'
				}
			],
			references,
			qualified: false
		};
	const a = inspector(root),
		e = m.exposure,
		diagnostics = [];
	const issue = (rule, file, message) => diagnostics.push({ rule, file, message });
	const schema = a.properties(a.binding(m.schema.file, m.schema.symbol)),
		schemaNames = [...schema.keys()];
	const lists = {};
	for (const consumer of ['list', 'detail', 'form']) {
		const included = a.data(a.binding(e.file, e[consumer])),
			omitted = a.data(a.binding(e.file, e[consumer + 'Omitted']));
		lists[consumer] = included;
		if (
			!Array.isArray(included) ||
			!Array.isArray(omitted) ||
			new Set([...included, ...omitted]).size !== included.length + omitted.length
		)
			fail('legacy-exposure', 'Invalid exposure partition', e.file);
		const declared = included.filter((f) => f !== 'createdat');
		if (!equal([...declared, ...omitted], schemaNames))
			issue(
				'legacy-exposure',
				e.file,
				`${consumer}: every schema field needs exactly one explicit exposure or omission decision`
			);
	}
	const domain = [];
	for (const [name, ref] of schema) {
		const p = a.properties(ref);
		if (p.has('options') && !p.has('allowedValues'))
			issue('legacy-values', m.schema.file, `${name}: UI options lack explicit server allowedValues`);
		if (p.has('allowedValues')) {
			const values = a.data(p.get('allowedValues'));
			if (!Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length)
				issue('legacy-values', m.schema.file, `${name}: invalid allowedValues`);
			domain.push({
				field: name,
				required: p.has('optional') ? a.data(p.get('optional')) !== true : true,
				allowedValues: values
			});
		}
	}
	for (const p of m.publications) {
		const registrations = [
			...a.calls(m.server.file, 'addPublication'),
			...a.calls(m.server.file, 'addTransformedPublication')
		].filter((n) => n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === p.name);
		if (registrations.length !== 1) {
			issue('legacy-publication', m.server.file, `Expected one registration for ${p.name}`);
			continue;
		}
		const delegates = [];
		function walk(n) {
			if (
				ts.isCallExpression(n) &&
				ts.isPropertyAccessExpression(n.expression) &&
				n.expression.name.text === p.delegate
			)
				delegates.push(n);
			ts.forEachChild(n, walk);
		}
		walk(registrations[0].arguments[1]);
		if (delegates.length !== 1) issue('legacy-publication', m.server.file, `${p.name}: expected one ${p.delegate}`);
		else {
			const options = a.properties({ file: m.server.file, node: delegates[0].arguments[1] }),
				projection = options.get('projection');
			if (!projection || !equal(a.fields(projection), lists[p.consumer]))
				issue(
					'legacy-projection',
					m.server.file,
					`${p.name}: actual projection differs from explicit ${p.consumer} contract`
				);
		}
		if (
			!a
				.calls(m.controllers[p.consumer].file, 'subscribe')
				.some((n) => n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === p.name)
		)
			issue('legacy-controller', m.controllers[p.consumer].file, `Missing subscription to ${p.name}`);
	}
	const reduced = a.reduced(a.binding(e.reducedSchema.file, e.reducedSchema.symbol));
	if (!equal(reduced, lists.list))
		issue(
			'legacy-reduced-schema',
			e.reducedSchema.file,
			'The actual list schema differs from the declared list fields'
		);
	const controller = a.read(m.controllers.list.file);
	let schemaLinked = false;
	function controllerWalk(n) {
		if (
			ts.isPropertyAssignment(n) &&
			n.name.getText(controller.ast) === 'schema' &&
			ts.isIdentifier(n.initializer) &&
			n.initializer.text === e.reducedSchema.symbol
		)
			schemaLinked = true;
		ts.forEachChild(n, controllerWalk);
	}
	controllerWalk(controller.ast);
	if (!schemaLinked)
		issue('legacy-controller', controller.file, 'List controller does not supply its checked reduced schema');
	const form = a.read(e.formView.file),
		formNames = [];
	function formWalk(n) {
		if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(form.ast) !== 'SysIcon')
			for (const prop of n.attributes.properties)
				if (ts.isJsxAttribute(prop) && prop.name.getText(form.ast) === 'name') {
					const value = prop.initializer;
					if (value && ts.isStringLiteral(value)) formNames.push(value.text);
					else if (value && ts.isJsxExpression(value) && value.expression)
						formNames.push(a.data({ file: form.file, node: value.expression }));
					else issue('legacy-form', form.file, 'Computed form name requires review');
				}
		ts.forEachChild(n, formWalk);
	}
	formWalk(form.ast);
	if (!equal(formNames, lists.form))
		issue('legacy-form', form.file, 'Actual form fields differ from explicit form exposure');
	const view = a.read(e.listView.file);
	let tableLinked = false;
	function listWalk(n) {
		if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(view.ast) === 'ComplexTable')
			for (const prop of n.attributes.properties)
				if (
					ts.isJsxAttribute(prop) &&
					prop.name.getText(view.ast) === 'schema' &&
					prop.initializer &&
					ts.isJsxExpression(prop.initializer) &&
					prop.initializer.expression?.getText(view.ast) === 'controller.schema'
				)
					tableLinked = true;
		ts.forEachChild(n, listWalk);
	}
	listWalk(view.ast);
	if (!tableLinked) issue('legacy-list', view.file, 'List table does not use the checked controller schema');
	const validator = a.read(m.validator.file);
	let enforced = false;
	function validatorWalk(n) {
		if (
			ts.isPropertyDeclaration(n) &&
			n.name.getText(validator.ast) === '_checkDataBySchema' &&
			n.initializer &&
			ts.isArrowFunction(n.initializer)
		) {
			const fn = n.initializer,
				raw = fn.parameters[0]?.name.getText(validator.ast),
				ignored = fn.parameters[1]?.name.getText(validator.ast);
			let validation = -1,
				preparation = Infinity;
			function walk(node) {
				if (ts.isCallExpression(node)) {
					if (ts.isIdentifier(node.expression)) {
						const imported = validator.imports.get(node.expression.text);
						const args = node.arguments.map((arg) => {
							while (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg)) arg = arg.expression;
							return arg.getText(validator.ast);
						});
						if (
							imported?.file === 'imports/legacy/allowedValues.ts' &&
							imported.symbol === 'assertAllowedValues' &&
							args[0] === 'schema' &&
							args[1] === raw &&
							args[2] === ignored
						)
							validation = node.pos;
					}
					if (
						ts.isPropertyAccessExpression(node.expression) &&
						node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
						node.expression.name.text === '_prepareData'
					)
						preparation = Math.min(preparation, node.pos);
				}
				ts.forEachChild(node, walk);
			}
			walk(fn.body);
			enforced = validation >= 0 && validation < preparation;
		}
		ts.forEachChild(n, validatorWalk);
	}
	validatorWalk(validator.ast);
	if (!enforced)
		issue('legacy-validator', m.validator.file, 'Expected raw input allowedValues enforcement before preparation');
	a.read('imports/legacy/exposure.ts');
	a.read('imports/legacy/allowedValues.ts');
	const sources = { ...a.hashes(), [manifestFile]: hash(fs.readFileSync(target)) };
	for (const ref of references) sources[ref.file] = ref.hash;
	return {
		schemaVersion: 1,
		status: diagnostics.length ? 'failed' : 'passed',
		module,
		domain,
		consumers: lists,
		diagnostics,
		sources,
		references,
		qualified: false,
		acceptance: 'static source inspection; execute the linked module contracts and real Mongo/DDP/browser tests'
	};
}

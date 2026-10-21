/** Reviewable semantic transformations. Planning never writes code or executes a data migration. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { planLegacyOperation } from './legacy-operation.mjs';
import { compilerOptions } from '../../ast.mjs';
import { confined, files, exact, relative } from '../../lib.mjs';

const sourceExtension = /\.[cm]?[jt]sx?$/;
const identifier = /^[A-Za-z_$][\w$]*$/;
const operations = {
	'rename-field': ['file', 'symbol', 'newName', 'position'],
	'change-field': ['file', 'symbol', 'type', 'required', 'position'],
	'rename-module': ['file', 'to'],
	'rename-route': ['file', 'from', 'to'],
	'move-symbol': ['file', 'symbol', 'to', 'position'],
	'modernize-legacy': ['file', 'symbol', 'to', 'position', 'recipe', 'mappings'],
	'migrate-framework': ['file', 'recipe'],
	'deprecate-symbol': ['file', 'symbol', 'position'],
	'remove-symbol': ['file', 'symbol', 'position']
};
export const codemodKinds = Object.freeze(Object.keys(operations));
function reject(code, message, file = '') {
	throw Object.assign(new Error(message), { code, file });
}
function visit(node, callback) {
	callback(node);
	ts.forEachChild(node, (child) => visit(child, callback));
}
const slash = (value) => value.split(path.sep).join('/');

function project(root) {
	root = fs.realpathSync(root);
	const names = files(root).filter(
		(name) => sourceExtension.test(name) && !/(^|\/)(?:\.env|secrets|credentials)(?:\.|\/|$)/i.test(name)
	);
	if (names.length > 4000) reject('source-budget', 'Project exceeds the 4,000 source file ceiling');
	const sources = new Map();
	let bytes = 0;
	for (const name of names) {
		const file = confined(root, name);
		const size = fs.statSync(file).size;
		if (size > 1024 * 1024 || (bytes += size) > 32 * 1024 * 1024)
			reject('source-budget', 'Source exceeds the 1 MiB file / 32 MiB project ceiling', name);
		sources.set(file, fs.readFileSync(file, 'utf8'));
	}
	const options = { ...compilerOptions(root), noEmit: true };
	const host = {
		getScriptFileNames: () => [...sources.keys()],
		getScriptVersion: () => '0',
		getScriptSnapshot: (file) => {
			const text = sources.get(file) ?? (/\.(?:[cm]?[jt]sx?|json)$/.test(file) ? ts.sys.readFile(file) : undefined);
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => root,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		useCaseSensitiveFileNames: () => true
	};
	const service = ts.createLanguageService(host);
	const program = service.getProgram();
	const checker = program.getTypeChecker();
	const changes = new Map();
	function resolve(name, missing = false) {
		relative(name);
		return confined(root, name, { missing });
	}
	function source(name) {
		const absolute = resolve(name);
		const node = program.getSourceFile(absolute);
		if (!node || !sources.has(absolute))
			reject('source-file', 'Expected a project TypeScript or JavaScript source', name);
		if (node.parseDiagnostics.length) reject('parse-error', 'Source contains syntax errors', name);
		return node;
	}
	function edit(file, start, length, newText) {
		if (!sources.has(file) && !file.startsWith(root + path.sep))
			reject('outside-project', 'Transformation escaped project', file);
		const rel = slash(path.relative(root, file));
		resolve(rel, true);
		const edits = changes.get(rel) ?? [];
		edits.push({ start, length, newText });
		changes.set(rel, edits);
	}
	function edits(items) {
		for (const item of items)
			for (const change of item.textChanges) edit(item.fileName, change.span.start, change.span.length, change.newText);
	}
	function finish() {
		return [...changes]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, entries]) => {
				const before = sources.get(resolve(name, true)) ?? null;
				let after = before ?? '';
				let previous = after.length + 1;
				for (const entry of entries.sort((a, b) => b.start - a.start)) {
					if (entry.start + entry.length > previous || entry.start < 0 || entry.start + entry.length > after.length)
						reject('overlapping-edits', 'Compiler returned overlapping or invalid edits', name);
					previous = entry.start;
					after = after.slice(0, entry.start) + entry.newText + after.slice(entry.start + entry.length);
				}
				return { path: name, before, after };
			})
			.filter((change) => change.before !== change.after);
	}
	return { root, sources, source, resolve, service, program, checker, edit, edits, finish };
}
function select(ctx, op) {
	const sf = ctx.source(op.file);
	const matches = [];
	visit(sf, (node) => {
		if (
			ts.isIdentifier(node) &&
			node.text === op.symbol &&
			node.parent.name === node &&
			[
				ts.isPropertySignature,
				ts.isPropertyDeclaration,
				ts.isMethodDeclaration,
				ts.isFunctionDeclaration,
				ts.isInterfaceDeclaration,
				ts.isTypeAliasDeclaration,
				ts.isClassDeclaration,
				ts.isVariableDeclaration
			].some((predicate) => predicate(node.parent)) &&
			(op.position === undefined || (node.getStart(sf) <= op.position && op.position < node.end))
		)
			matches.push(node);
	});
	if (matches.length !== 1)
		reject(
			'ambiguous-symbol',
			`Expected one declaration named ${op.symbol}; found ${matches.length}. Use position to disambiguate.`,
			op.file
		);
	const name = matches[0];
	const symbol = ctx.checker.getSymbolAtLocation(name);
	if (!symbol) reject('unresolved-symbol', 'Cannot resolve declaration symbol', op.file);
	return { sf, name, symbol, declaration: name.parent };
}
function references(ctx, name) {
	return (ctx.service.findReferences(name.getSourceFile().fileName, name.getStart()) ?? []).flatMap(
		(group) => group.references
	);
}
function migration(kind, op, details) {
	return {
		kind,
		status: 'planned-not-executed',
		file: op.file,
		field: op.symbol,
		...details,
		prerequisites: [
			'Review persisted/API consumers including dynamic and external references',
			'Back up affected data and test rollback',
			'Approve an explicit conversion/backfill and deployment compatibility strategy'
		],
		verification: [
			'Count and sample affected records before and after',
			'Run contract, authorization, persistence and UI gates'
		],
		executesDataChanges: false
	};
}
function renameField(ctx, op, result) {
	const { name, declaration, symbol } = select(ctx, op);
	if (!ts.isPropertySignature(declaration) && !ts.isPropertyDeclaration(declaration))
		reject('unsupported-field', 'Select a declared interface/type/class property', op.file);
	if (
		typeof op.newName !== 'string' ||
		!identifier.test(op.newName) ||
		op.newName === op.symbol ||
		['__proto__', 'prototype', 'constructor'].includes(op.newName)
	)
		reject('field-name', 'New property name must be a distinct safe identifier', op.file);
	const owner = ctx.checker.getTypeAtLocation(declaration.parent);
	if (owner.getProperty(op.newName)) reject('name-collision', 'Target property already exists', op.file);
	if ((symbol.declarations ?? []).length !== 1)
		reject('merged-declaration', 'Merged declarations require manual review', op.file);
	const locations = ctx.service.findRenameLocations(name.getSourceFile().fileName, name.getStart(), false, false, true);
	if (!locations?.length) reject('rename-unavailable', 'TypeScript cannot safely rename this field', op.file);
	for (const loc of locations)
		ctx.edit(
			loc.fileName,
			loc.textSpan.start,
			loc.textSpan.length,
			(loc.prefixText ?? '') + op.newName + (loc.suffixText ?? '')
		);
	result.migrations.push(migration('rename-field', op, { from: op.symbol, to: op.newName }));
}
function changeField(ctx, op, result) {
	const { declaration, sf } = select(ctx, op);
	if (!ts.isPropertySignature(declaration) || !declaration.type)
		reject('unsupported-field', 'Only explicit interface/type property signatures are supported', op.file);
	if (op.type === undefined && op.required === undefined) reject('empty-change', 'Supply type or required', op.file);
	if (op.type !== undefined) {
		if (!['string', 'number', 'boolean'].includes(op.type))
			reject('unsupported-type', 'Choose string, number or boolean; arbitrary conversion needs design', op.file);
		ctx.edit(sf.fileName, declaration.type.getStart(sf), declaration.type.getWidth(sf), op.type);
	}
	if (op.required !== undefined) {
		if (typeof op.required !== 'boolean') reject('schema', 'required must be boolean', op.file);
		if (op.required && declaration.questionToken) ctx.edit(sf.fileName, declaration.questionToken.getStart(sf), 1, '');
		if (!op.required && !declaration.questionToken) ctx.edit(sf.fileName, declaration.name.end, 0, '?');
	}
	result.migrations.push(
		migration('change-field', op, {
			fromType: declaration.type.getText(sf),
			toType: op.type ?? declaration.type.getText(sf),
			required: op.required ?? !declaration.questionToken,
			conversion: 'must-be-explicitly-designed'
		})
	);
}
function renameModule(ctx, op, result) {
	const sf = ctx.source(op.file);
	const target = ctx.resolve(op.to, true);
	if (!sourceExtension.test(op.to) || fs.existsSync(target))
		reject('target-exists', 'Target must be a new source file', op.to);
	const edits = ctx.service.getEditsForFileRename(
		sf.fileName,
		target,
		{},
		{ importModuleSpecifierPreference: 'relative' }
	);
	ctx.edits(edits);
	const changes = ctx.finish();
	const changedSource = changes.find((change) => change.path === op.file);
	result.changes = changes.filter((change) => change.path !== op.file);
	result.changes.push(
		{ path: op.file, before: sf.text, after: null },
		{ path: op.to, before: null, after: changedSource?.after ?? sf.text }
	);
	result.diagnostics.push({
		code: 'module-identity-review',
		severity: 'warning',
		message:
			'Renamed one source module and compiler-resolved imports. Folder manifests, runtime registration names and external consumers are not renamed.'
	});
}
function renameRoute(ctx, op, result) {
	if (
		typeof op.from !== 'string' ||
		typeof op.to !== 'string' ||
		!op.from.startsWith('/') ||
		!op.to.startsWith('/') ||
		op.from === op.to
	)
		reject('route-path', 'Supply distinct absolute route paths', op.file);
	const sf = ctx.source(op.file);
	let found = 0;
	visit(sf, (node) => {
		if (!ts.isStringLiteral(node) || node.text !== op.from) return;
		const parent = node.parent;
		const property =
			ts.isPropertyAssignment(parent) &&
			parent.initializer === node &&
			['path', 'to', 'href'].includes(parent.name.getText(sf).replace(/^['"]|['"]$/g, ''));
		const jsx = ts.isJsxAttribute(parent) && ['path', 'to', 'href'].includes(parent.name.text);
		if (property || jsx) {
			ctx.edit(sf.fileName, node.getStart(sf), node.getWidth(sf), JSON.stringify(op.to));
			found++;
		}
	});
	if (!found)
		reject('route-pattern', 'No static route declaration or navigation target matched in the selected file', op.file);
	result.migrations.push({
		kind: 'route-compatibility',
		from: op.from,
		to: op.to,
		status: 'planned-not-executed',
		prerequisites: ['Review bookmarks, redirects and external links'],
		executesDataChanges: false
	});
}
function moveSymbol(ctx, op, result, legacy = false) {
	if (legacy && op.mappings !== undefined)
		reject('schema', 'mappings only applies to register-method-to-operation', op.file);
	const { sf, declaration } = select(ctx, op);
	if (legacy && op.recipe !== 'extract-public-contract')
		reject('unsupported-recipe', 'Supported progressive recipe: extract-public-contract', op.file);
	if (legacy && !ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration))
		reject(
			'legacy-contract',
			'Only an existing interface/type contract can be extracted; ProductBase behavior requires separate design',
			op.file
		);
	if (
		!ts.isFunctionDeclaration(declaration) &&
		!ts.isInterfaceDeclaration(declaration) &&
		!ts.isTypeAliasDeclaration(declaration) &&
		!ts.isClassDeclaration(declaration)
	)
		reject('unsupported-symbol', 'Select a top-level function, class, interface or type alias', op.file);
	if (!ts.isSourceFile(declaration.parent)) reject('nested-symbol', 'Nested declarations cannot be moved', op.file);
	if (ts.isClassDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) {
		// Runtime module order may change, so reject eager side effects in a moved class.
		if (
			ts.isClassDeclaration(declaration) &&
			declaration.members.some(
				(member) =>
					ts.isClassStaticBlockDeclaration(member) ||
					(member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) && member.initializer)
			)
		)
			reject('initialization-order', 'Class static initialization requires manual extraction', op.file);
	}
	const target = ctx.resolve(op.to, true);
	if (!sourceExtension.test(op.to) || fs.existsSync(target))
		reject('target-exists', 'Extraction destination must be a new source file', op.to);
	const edit = ctx.service.getEditsForRefactor(
		sf.fileName,
		{},
		{ pos: declaration.getStart(sf), end: declaration.end },
		'Move to file',
		'Move to file',
		{ allowTextChangesInNewFiles: true, importModuleSpecifierPreference: 'relative' },
		{ targetFile: target }
	);
	if (!edit?.edits?.length) reject('refactor-unavailable', 'TypeScript could not extract this declaration', op.file);
	ctx.edits(edit.edits);
	if (legacy)
		result.diagnostics.push({
			code: 'legacy-behavior-unmigrated',
			severity: 'warning',
			message:
				'Extracted the existing public type contract with compiler-updated dependencies. ProductBase runtime authorization, DTO parsing, projection and concurrency are intentionally unchanged and still need core adapter design.'
		});
}
function migrateFramework(ctx, op) {
	if (op.recipe !== 'meteor-user-async')
		reject('unsupported-recipe', 'Supported framework recipe: meteor-user-async', op.file);
	const sf = ctx.source(op.file);
	const bindings = new Set();
	for (const statement of sf.statements)
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === 'meteor/meteor'
		) {
			const named = statement.importClause?.namedBindings;
			if (named && ts.isNamedImports(named))
				for (const spec of named.elements)
					if ((spec.propertyName ?? spec.name).text === 'Meteor')
						bindings.add(ctx.checker.getSymbolAtLocation(spec.name));
		}
	let count = 0;
	visit(sf, (node) => {
		if (
			!ts.isCallExpression(node) ||
			!ts.isPropertyAccessExpression(node.expression) ||
			node.expression.name.text !== 'user' ||
			!bindings.has(ctx.checker.getSymbolAtLocation(node.expression.expression))
		)
			return;
		let scope = node.parent;
		while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
		if (!scope?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || node.arguments.length)
			reject(
				'async-context',
				'Meteor.user() migration requires a zero-argument call within an already async function',
				op.file
			);
		ctx.edit(sf.fileName, node.expression.name.getStart(sf), node.expression.name.getWidth(sf), 'userAsync');
		if (!ts.isAwaitExpression(node.parent)) {
			ctx.edit(sf.fileName, node.getStart(sf), 0, '(await ');
			ctx.edit(sf.fileName, node.end, 0, ')');
		}
		count++;
	});
	if (!count) reject('framework-pattern', 'No semantic Meteor.user() import binding call matched', op.file);
}
function lifecycle(ctx, op, result) {
	const { sf, name, declaration, symbol } = select(ctx, op);
	const refs = references(ctx, name).filter((ref) => !ref.isDefinition);
	result.diagnostics.push({
		code: 'usage-analysis',
		severity: 'info',
		message: `${refs.length} compiler-resolved references`,
		references: refs.map((ref) => ({
			file: slash(path.relative(ctx.root, ref.fileName)),
			start: ref.textSpan.start,
			length: ref.textSpan.length
		}))
	});
	if (op.kind === 'deprecate-symbol') {
		if (
			!ts.isSourceFile(declaration.parent) ||
			![ts.isFunctionDeclaration, ts.isInterfaceDeclaration, ts.isTypeAliasDeclaration, ts.isClassDeclaration].some(
				(predicate) => predicate(declaration)
			)
		)
			reject('unsupported-deprecation', 'Select a top-level function, class, interface or type alias', op.file);
		if (ts.getJSDocDeprecatedTag(declaration))
			reject('already-deprecated', 'Declaration is already deprecated', op.file);
		ctx.edit(sf.fileName, declaration.getStart(sf), 0, '/** @deprecated Review usage analysis before removal. */\n');
		return;
	}
	if (refs.length)
		reject('symbol-in-use', `Cannot remove a symbol with ${refs.length} compiler-resolved references`, op.file);
	if (
		(symbol.declarations ?? []).length !== 1 ||
		!ts.isSourceFile(declaration.parent) ||
		![ts.isFunctionDeclaration, ts.isInterfaceDeclaration, ts.isTypeAliasDeclaration].some((predicate) =>
			predicate(declaration)
		)
	)
		reject('unsafe-removal', 'Only a single unused top-level function/interface/type can be removed', op.file);
	if (
		declaration.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
		)
	)
		reject('public-removal', 'Exported symbols may have external consumers; deprecate and review instead', op.file);
	// Dynamic lookup cannot be proven absent for runtime symbols. Only isolated unexported functions are supported.
	if (ts.isFunctionDeclaration(declaration)) {
		if (!ts.isExternalModule(sf))
			reject('global-symbol', 'Script-global functions may have consumers outside the compiler project', op.file);
		let dynamic = false;
		visit(sf, (node) => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval')
				dynamic = true;
		});
		if (dynamic) reject('dynamic-usage', 'eval prevents proving runtime symbol removal safe', op.file);
	}
	ctx.edit(sf.fileName, declaration.getFullStart(), declaration.end - declaration.getFullStart(), '');
}
export function planCodemod(root, operation) {
	const result = { changes: [], diagnostics: [], migrations: [], requiresReview: true };
	let ctx;
	try {
		if (!operation || !Object.hasOwn(operations, operation.kind)) reject('unsupported-codemod', 'Unknown codemod kind');
		exact(operation, ['kind', ...operations[operation.kind]], ['kind', 'file']);
		if (operation.position !== undefined && (!Number.isInteger(operation.position) || operation.position < 0))
			reject('schema', 'position must be a nonnegative integer');
		if (
			operations[operation.kind].includes('symbol') &&
			(typeof operation.symbol !== 'string' || !identifier.test(operation.symbol))
		)
			reject('schema', 'symbol must be an identifier');
		ctx = project(root);
		switch (operation.kind) {
			case 'rename-field':
				renameField(ctx, operation, result);
				break;
			case 'change-field':
				changeField(ctx, operation, result);
				break;
			case 'rename-module':
				renameModule(ctx, operation, result);
				break;
			case 'rename-route':
				renameRoute(ctx, operation, result);
				break;
			case 'move-symbol':
				moveSymbol(ctx, operation, result);
				break;
			case 'modernize-legacy':
				if (operation.recipe === 'register-method-to-operation') planLegacyOperation(ctx, operation, result);
				else moveSymbol(ctx, operation, result, true);
				break;
			case 'migrate-framework':
				migrateFramework(ctx, operation);
				break;
			default:
				lifecycle(ctx, operation, result);
		}
		if (operation.kind !== 'rename-module') result.changes = ctx.finish();
		if (!result.changes.length)
			reject('no-change', 'Operation produced no changes; repeated or unsupported transformation');
		result.changes.sort((a, b) => a.path.localeCompare(b.path));
	} catch (error) {
		result.changes = [];
		result.migrations = [];
		result.diagnostics.push({
			code: error.code ?? error.rule ?? 'codemod-failed',
			severity: 'error',
			message: error.message,
			file: error.file ?? operation?.file ?? ''
		});
	} finally {
		ctx?.service.dispose();
	}
	return result;
}

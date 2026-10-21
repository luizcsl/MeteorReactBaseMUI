import { architectureContext } from './architecture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { confined, fail, files, hash, validateTask } from './lib.mjs';

const sourcePattern = /\.[cm]?[jt]sx?$/;
const slash = (value) => value.split(path.sep).join('/');
const sensitive = (value) =>
	/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.aws(?:\/|$)|credentials|secrets)(?!example)/i.test(value) ||
	/\.(?:pem|key|p12|pfx)$/i.test(value);
export function compilerOptions(root) {
	const configPath = path.join(root, 'tsconfig.json');
	if (!fs.existsSync(configPath))
		return {
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			module: ts.ModuleKind.Preserve,
			allowJs: true,
			resolveJsonModule: true
		};
	const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
	if (loaded.config?.extends)
		fail(
			'typescript-config',
			'Extended tsconfig requires a reviewed flattened analyzer configuration',
			'tsconfig.json'
		);
	if (loaded.error)
		fail('typescript-config', ts.flattenDiagnosticMessageText(loaded.error.messageText, ' '), 'tsconfig.json');
	// Parsing compiler options does not recursively load project source/dependencies.
	const parsed = ts.convertCompilerOptionsFromJson(loaded.config.compilerOptions || {}, root, configPath);
	if (parsed.errors.length)
		fail('typescript-config', ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, ' '), 'tsconfig.json');
	return { ...parsed.options, pathsBasePath: root, allowJs: true };
}
function readBounded(root, file, maxBytes) {
	if (sensitive(file)) fail('sensitive-context', 'Credential/configuration files cannot enter context', file);
	const target = confined(root, file),
		descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) fail('context-file', 'Expected regular file', file);
		if (stat.size > maxBytes)
			fail('context-budget', 'Cumulative source bytes exceed remaining budget before content load', file);
		const buffer = Buffer.alloc(stat.size + 1);
		let loaded = 0,
			count;
		while (
			loaded < buffer.length &&
			(count = fs.readSync(descriptor, buffer, loaded, buffer.length - loaded, loaded)) > 0
		)
			loaded += count;
		if (loaded !== stat.size) fail('context-changed', 'Source changed during read', file);
		return buffer.subarray(0, loaded).toString('utf8');
	} finally {
		fs.closeSync(descriptor);
	}
}
export function analyzeSource(root, file, { options = compilerOptions(root), maxBytes = 1024 * 1024 } = {}) {
	const source = readBounded(root, file, maxBytes);
	if (!sourcePattern.test(file))
		return {
			file,
			sha256: hash(source),
			dependencies: [],
			externalDependencies: [],
			symbols: [],
			diagnostics: [],
			source
		};
	const ast = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith('x')
			? ts.ScriptKind.TSX
			: file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS
	);
	const diagnostics = ast.parseDiagnostics.map((d) => ({
		file,
		line: ast.getLineAndCharacterOfPosition(d.start || 0).line + 1,
		rule: 'syntax',
		message: ts.flattenDiagnosticMessageText(d.messageText, ' ')
	}));
	const dependencies = new Set(),
		external = new Set(),
		edges = [],
		symbols = [];
	const line = (node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
	const isServer = (node) =>
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'Meteor' &&
		node.name.text === 'isServer';
	function impliesServer(node, truth = true) {
		if (ts.isParenthesizedExpression(node)) return impliesServer(node.expression, truth);
		if (isServer(node)) return truth;
		if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
			return impliesServer(node.operand, !truth);
		if (
			ts.isBinaryExpression(node) &&
			((truth && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) ||
				(!truth && node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
		)
			return impliesServer(node.left, truth) || impliesServer(node.right, truth);
		return false;
	}
	function exits(node) {
		return (
			ts.isReturnStatement(node) ||
			ts.isThrowStatement(node) ||
			(ts.isBlock(node) && node.statements.length > 0 && exits(node.statements[node.statements.length - 1]))
		);
	}
	function serverGuarded(node) {
		for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
			if (ts.isFunctionLike(parent)) break; // A callback must prove its own guard, not rely on invocation timing.
			if (ts.isIfStatement(parent) && child === parent.thenStatement && impliesServer(parent.expression)) return true;
			if (
				ts.isBinaryExpression(parent) &&
				child === parent.right &&
				parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
				impliesServer(parent.left)
			)
				return true;
			if (ts.isBlock(parent)) {
				for (const statement of parent.statements) {
					if (statement === child) break;
					if (
						ts.isIfStatement(statement) &&
						!statement.elseStatement &&
						impliesServer(statement.expression, false) &&
						exits(statement.thenStatement)
					)
						return true;
				}
			}
		}
		return false;
	}
	function dependency(literal, node, kind) {
		if (!literal || !ts.isStringLiteralLike(literal)) {
			diagnostics.push({
				file,
				line: line(node),
				rule: 'computed-import',
				message: 'Computed module loading requires an explicit audited adapter; closure cannot be proven.'
			});
			return;
		}
		const specifier = literal.text;
		let local =
			specifier.startsWith('.') ||
			specifier.startsWith('/') ||
			Object.keys(options.paths || {}).some((pattern) => {
				const [prefix, suffix] = pattern.split('*');
				return pattern.includes('*')
					? specifier.startsWith(prefix) && specifier.endsWith(suffix)
					: specifier === pattern;
			});
		const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, ts.sys).resolvedModule;
		let target;
		if (resolved && !resolved.isExternalLibraryImport && !resolved.resolvedFileName.includes('/node_modules/')) {
			const relative = slash(path.relative(root, resolved.resolvedFileName));
			confined(root, relative);
			target = relative;
			local = true;
		} else if (local) {
			// Meteor root imports resolve even when a consumer has omitted paths configuration.
			const base = specifier.startsWith('/imports/')
				? specifier.slice(1)
				: specifier.startsWith('.')
					? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
					: null;
			if (base)
				for (const suffix of [
					'',
					'.ts',
					'.tsx',
					'.js',
					'.mjs',
					'.cjs',
					'.json',
					'/index.ts',
					'/index.tsx',
					'/index.js'
				]) {
					try {
						const candidate = base + suffix;
						if (fs.statSync(confined(root, candidate)).isFile()) {
							target = candidate;
							break;
						}
					} catch (error) {
						if (error.rule !== 'missing-file') throw error;
					}
				}
			if (!target)
				diagnostics.push({
					file,
					line: line(node),
					rule: 'unresolved-dependency',
					message: `Cannot resolve ${specifier}`
				});
		}
		if (target) dependencies.add(target);
		else if (!local) external.add(specifier);
		edges.push({
			specifier,
			target: target || null,
			external: !local,
			line: line(node),
			kind,
			serverGuarded: serverGuarded(node)
		});
	}
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			(ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
		) {
			const access = node.expression,
				key = ts.isPropertyAccessExpression(access)
					? access.name.text
					: ts.isStringLiteralLike(access.argumentExpression)
						? access.argumentExpression.text
						: null;
			if (key === 'require')
				diagnostics.push({
					file,
					line: line(node),
					rule: 'indirect-loader',
					message: 'Indirect module loading is unsupported; use explicit imports or literal require.'
				});
		}
		if (
			ts.isIdentifier(node) &&
			node.text === 'require' &&
			!(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
			!(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
			!ts.isExternalModuleReference(node.parent)
		) {
			diagnostics.push({
				file,
				line: line(node),
				rule: 'indirect-loader',
				message: 'Aliased module loading is unsupported; dependency closure cannot be proven.'
			});
		}

		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier)
				dependency(node.moduleSpecifier, node, ts.isImportDeclaration(node) ? 'import' : 'reexport');
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
			dependency(node.moduleReference.expression, node, 'import-equals');
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			dependency(
				node.arguments.length === 1 ? node.arguments[0] : null,
				node,
				node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require'
			);
		} else if (ts.isImportTypeNode(node)) {
			const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
			dependency(argument, node, 'type-import');
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	for (const node of ast.statements) {
		if (
			!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) &&
			!ts.isExportDeclaration(node) &&
			!ts.isExportAssignment(node)
		)
			continue;
		let end = node.end;
		if (ts.isFunctionDeclaration(node) && node.body) end = node.body.pos;
		else if (ts.isClassDeclaration(node)) end = node.members.pos;
		const signature = source.slice(node.getStart(ast), end).trim();
		symbols.push({
			name: node.name?.getText(ast) || null,
			line: line(node),
			kind: ts.SyntaxKind[node.kind],
			signature: signature.slice(0, 1000),
			truncated: signature.length > 1000
		});
	}
	return {
		file,
		sha256: hash(source),
		dependencies: [...dependencies].sort(),
		externalDependencies: [...external].sort(),
		edges,
		symbols,
		diagnostics,
		source
	};
}
export function astContext(root, input) {
	const task = validateTask(input),
		options = compilerOptions(root),
		queue = [...new Set(task.contextFiles)].sort(),
		visited = new Set(),
		records = [],
		external = new Set();
	let bytes = 0;
	while (queue.length) {
		const file = queue.shift();
		if (visited.has(file)) continue;
		visited.add(file);
		if (visited.size > task.budget.contextFiles) fail('context-budget', 'Dependency closure exceeds file budget', file);
		const record = analyzeSource(root, file, { options, maxBytes: task.budget.contextBytes - bytes });
		bytes += Buffer.byteLength(record.source);
		if (record.diagnostics.length) {
			const d = record.diagnostics[0];
			const e = new Error(d.message);
			Object.assign(e, d);
			throw e;
		}
		record.externalDependencies.forEach((x) => external.add(x));
		records.push(record);
		record.dependencies.forEach((x) => {
			if (!visited.has(x)) queue.push(x);
		});
		queue.sort();
	}
	const result = {
		schemaVersion: 2,
		task,
		algorithm: 'typescript-ast-resolution-v2',
		modules: architectureContext(
			root,
			records.map((record) => record.file)
		),
		externalDependencies: [...external].sort(),
		files: records.sort((a, b) => a.file.localeCompare(b.file, 'en'))
	};
	if (Buffer.byteLength(JSON.stringify(result, null, 2) + '\n') > task.budget.contextBytes)
		fail('context-budget', 'Serialized context exceeds byte budget; no partial context emitted');
	return result;
}
export function astGraph(root, { paths = ['imports'], maxFiles = 3000, maxBytes = 24 * 1024 * 1024 } = {}) {
	const options = compilerOptions(root),
		names = paths
			.flatMap((p) => {
				const target = confined(root, p);
				return fs.statSync(target).isDirectory() ? files(target).map((x) => p + '/' + x) : [p];
			})
			.filter((x) => sourcePattern.test(x));
	if (names.length > maxFiles) fail('graph-budget', 'Source graph exceeds file limit');
	let bytes = 0;
	const records = [];
	const queue = [...new Set(names)].sort(),
		visitedFiles = new Set();
	while (queue.length) {
		const file = queue.shift();
		if (visitedFiles.has(file)) continue;
		visitedFiles.add(file);
		if (visitedFiles.size > maxFiles) fail('graph-budget', 'Source graph exceeds file limit');
		const record = analyzeSource(root, file, { options, maxBytes: maxBytes - bytes });
		bytes += Buffer.byteLength(record.source);
		records.push({ ...record, source: undefined });
		for (const dependency of record.dependencies)
			if (sourcePattern.test(dependency) && !visitedFiles.has(dependency)) queue.push(dependency);
		queue.sort();
	}
	records.sort((a, b) => a.file.localeCompare(b.file, 'en'));
	const byName = new Map(records.map((r) => [r.file, r])),
		cycles = [],
		stack = [],
		active = new Set(),
		visited = new Set();
	function walk(file) {
		if (active.has(file)) {
			cycles.push([...stack.slice(stack.indexOf(file)), file]);
			return;
		}
		if (visited.has(file)) return;
		visited.add(file);
		active.add(file);
		stack.push(file);
		for (const dependency of byName.get(file)?.dependencies || []) if (byName.has(dependency)) walk(dependency);
		stack.pop();
		active.delete(file);
	}
	for (const file of byName.keys()) walk(file);
	return {
		schemaVersion: 1,
		algorithm: 'typescript-ast-resolution-v2',
		files: records,
		cycles,
		diagnostics: records.flatMap((r) => r.diagnostics)
	};
}
export function astBoundaries(root, configuration = {}) {
	const graph = astGraph(root, configuration),
		diagnostics = [...graph.diagnostics],
		debt = [];
	// Reviewed legacy isomorphic collection: pin the entire file and exact server targets.
	// Not an extensible user-provided allowlist. Any edit requires a new explicit review.
	const bridgeFile = 'imports/api/attachmentsCollection.ts';
	const bridgeHash = 'b843d1e2b1e021d0c565b3e4694814a2fac4811fe256a56769de2432a9a1592d';
	const bridgeTargets = new Set([
		'imports/server/mediaAccount.ts',
		'imports/server/mediaAuthorization.ts',
		'imports/server/mediaContent.ts',
		'imports/server/fileStorage.ts'
	]);
	function exempt(record, edge) {
		return (
			record.file === bridgeFile &&
			record.sha256 === bridgeHash &&
			bridgeTargets.has(edge.target) &&
			edge.kind === 'require'
		);
	}
	for (const record of graph.files)
		for (const edge of record.edges || [])
			if (exempt(record, edge))
				debt.push({
					file: record.file,
					line: edge.line,
					rule: 'reviewed-isomorphic-bridge',
					target: edge.target,
					sha256: record.sha256,
					syntacticServerGuard: edge.serverGuarded
				});

	for (const record of graph.files)
		for (const edge of record.edges || []) {
			const file = record.file,
				target =
					edge.target ||
					(edge.specifier.startsWith('.')
						? path.posix.normalize(path.posix.join(path.posix.dirname(record.file), edge.specifier))
						: edge.specifier.replace(/^\//, ''));
			let rule;
			if (
				/\/(contracts|domain)\//.test(file) &&
				(/\/(server|ui)\//.test(target) || /^(meteor\/|react(?:\/|$)|@mui\/)/.test(edge.specifier))
			)
				rule = 'pure-layer';
			if (/\/ui\//.test(file) && /\/server\//.test(target)) rule = 'ui-server';
			if (file.startsWith('imports/core/') && target.startsWith('imports/modules/')) rule = 'core-module';
			const module = file.match(/^imports\/modules\/([^/]+)\//)?.[1],
				other = target.match(/^imports\/modules\/([^/]+)\//)?.[1];
			if (module && other && module !== other && !target.includes('/contracts/')) rule = 'module-private';
			if (
				rule === 'module-private' &&
				file === 'imports/modules/example/api/exampleServerApi.ts' &&
				edge.specifier === '../../../modules/userprofile/api/userProfileServerApi'
			)
				rule = undefined;
			if (rule)
				diagnostics.push({
					file,
					line: edge.line,
					rule,
					message: `Forbidden dependency ${edge.specifier}`,
					command: 'npm run boundaries:check'
				});
		}
	// Enforce transitive server leakage for explicit UI/client entrypoints, even through reexports.
	const map = new Map(graph.files.map((r) => [r.file, r]));
	for (const record of graph.files.filter((r) => /\/ui\//.test(r.file))) {
		const seen = new Set(),
			queue = [...record.dependencies];
		while (queue.length) {
			const target = queue.shift();
			if (seen.has(target)) continue;
			seen.add(target);
			if (/\/server\//.test(target)) {
				diagnostics.push({
					file: record.file,
					line: 1,
					rule: 'transitive-ui-server',
					message: `UI transitively loads ${target}`,
					command: 'npm run boundaries:check'
				});
				break;
			}
			const next = map.get(target);
			queue.push(
				...(next?.edges || []).filter((edge) => edge.target && !exempt(next, edge)).map((edge) => edge.target)
			);
		}
	}
	// Existing legacy cycles are reported for migration; canonical core/new layers reject cycles.
	for (const cycle of graph.cycles)
		if (
			cycle.some(
				(file) =>
					file.startsWith('imports/core/') || /^imports\/modules\/[^/]+\/(contracts|domain|ui|server)\//.test(file)
			)
		)
			diagnostics.push({
				file: cycle[0],
				line: 1,
				rule: 'dependency-cycle',
				message: cycle.join(' -> '),
				command: 'npm run boundaries:check'
			});
	for (const cycle of graph.cycles)
		if (!diagnostics.some((d) => d.rule === 'dependency-cycle' && d.message === cycle.join(' -> ')))
			debt.push({ file: cycle[0], rule: 'legacy-cycle', cycle });
	return {
		status: diagnostics.length ? 'failed' : 'passed',
		diagnostics,
		debt,
		cycles: graph.cycles,
		notice:
			'Compiler-resolved static graph. Computed loading fails closed; runtime eval/network behavior still requires isolated execution.'
	};
}

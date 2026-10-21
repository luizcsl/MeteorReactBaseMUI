import ts from 'typescript';
import path from 'node:path';
import { exact } from '../../lib.mjs';
function reject(code, message, file) {
	throw Object.assign(new Error(message), { code, file });
}
function walk(node, callback) {
	callback(node);
	ts.forEachChild(node, (child) => walk(child, callback));
}
const qualified = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** Retain legacy transport/context validation; replace only its explicitly selected callback. */
export function planLegacyOperation(ctx, op, result) {
	const sf = ctx.source(op.file);
	if (!op.file.split('/').includes('server'))
		reject('server-boundary', 'Legacy-to-core operation adapters must live in a server/ directory', op.file);
	if (op.to !== undefined) reject('schema', 'This recipe updates a callback in place; to is not supported', op.file);
	exact(
		op.mappings,
		['input', 'output', 'policy', 'contextBuilder', 'identityFromLegacy', 'project', 'effect', 'concurrency'],
		['input', 'output', 'policy', 'contextBuilder', 'identityFromLegacy', 'project', 'effect']
	);
	if (!['read', 'write'].includes(op.mappings.effect))
		reject('operation-effect', 'Choose read or write explicitly', op.file);
	if (op.mappings.effect === 'write' && !op.mappings.concurrency)
		reject(
			'concurrency-required',
			'Write migration requires an existing reviewed concurrency executor function',
			op.file
		);
	if (op.mappings.effect === 'read' && op.mappings.concurrency !== undefined)
		reject('schema', 'concurrency is only supported for write operations', op.file);
	const methods = [];
	walk(sf, (node) => {
		if (
			ts.isMethodDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === op.symbol &&
			(op.position === undefined || (node.name.getStart(sf) <= op.position && op.position < node.name.end))
		)
			methods.push(node);
	});
	if (methods.length !== 1)
		reject('legacy-business-symbol', 'Select exactly one explicitly declared class business method', op.file);
	const method = methods[0];
	if (
		method.parameters.length !== 2 ||
		method.parameters.some((p) => p.dotDotDotToken || p.questionToken || p.initializer) ||
		!method.body ||
		method.typeParameters?.length
	)
		reject(
			'legacy-signature',
			'Business method must have exactly (input, legacyContext), without optional/rest/generic arguments',
			op.file
		);
	const businessSymbol = ctx.checker.getSymbolAtLocation(method.name);
	const candidates = [];
	walk(method.parent, (node) => {
		if (
			!ts.isCallExpression(node) ||
			!ts.isPropertyAccessExpression(node.expression) ||
			node.expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
			node.expression.name.text !== 'registerMethod'
		)
			return;
		const bound = node.arguments[1];
		if (
			!bound ||
			!ts.isCallExpression(bound) ||
			!ts.isPropertyAccessExpression(bound.expression) ||
			bound.expression.name.text !== 'bind' ||
			bound.arguments.length !== 1 ||
			bound.arguments[0].kind !== ts.SyntaxKind.ThisKeyword
		)
			return;
		const access = bound.expression.expression;
		if (
			!ts.isPropertyAccessExpression(access) ||
			access.expression.kind !== ts.SyntaxKind.ThisKeyword ||
			ctx.checker.getSymbolAtLocation(access.name) !== businessSymbol
		)
			return;
		candidates.push({ call: node, bound });
	});
	if (candidates.length !== 1)
		reject(
			'legacy-registration',
			'Expected exactly one this.registerMethod(name, this.business.bind(this), 1, 1) registration',
			op.file
		);
	const { call, bound } = candidates[0];
	const registration = ctx.checker.getSymbolAtLocation(call.expression.name);
	if (
		!registration?.declarations?.some(
			(d) => path.resolve(d.getSourceFile().fileName) === ctx.resolve('imports/api/serverBase.ts')
		)
	)
		reject(
			'legacy-registration-source',
			'registerMethod must resolve to the repository ServerApiBase implementation, not an override',
			op.file
		);
	if (
		call.arguments.length < 2 ||
		call.arguments.length > 4 ||
		!ts.isStringLiteral(call.arguments[0]) ||
		call.arguments.slice(2).some((n) => !ts.isNumericLiteral(n) || n.text !== '1')
	)
		reject(
			'legacy-arity',
			'Only one required DTO argument is supported; optional/multiple arguments require design',
			op.file
		);
	const methodName = call.arguments[0].text;
	if (
		['insert', 'update', 'remove', 'upsert', 'sync', 'getDocs', 'countDocuments', 'exportCollection'].includes(
			methodName
		)
	)
		reject('implicit-crud', 'Implicit CRUD/REST/transaction methods cannot be migrated by this recipe', op.file);
	function binding(text, kind) {
		if (
			typeof text !== 'string' ||
			!qualified.test(text) ||
			text.split('.').some((x) => ['__proto__', 'prototype', 'constructor'].includes(x))
		)
			reject('mapping-symbol', `${kind} must name an existing qualified symbol, not code`, op.file);
		const [first, ...parts] = text.split('.');
		if (['legacyBusiness', 'input', 'legacyContext', 'context', 'parsed', 'raw', 'invocations'].includes(first))
			reject(
				'mapping-shadow',
				`${kind} conflicts with an adapter-local binding; import or alias it explicitly`,
				op.file
			);
		let symbol = ctx.checker.getSymbolsInScope(call, ts.SymbolFlags.Value).find((s) => s.name === first);
		if (!symbol) reject('mapping-unresolved', `Cannot resolve ${kind}: ${text}`, op.file);
		let type = ctx.checker.getTypeOfSymbolAtLocation(symbol, call);
		for (const part of parts) {
			symbol = type.getProperty(part);
			if (!symbol) reject('mapping-unresolved', `Cannot resolve ${kind}: ${text}`, op.file);
			type = ctx.checker.getTypeOfSymbolAtLocation(symbol, call);
		}
		if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
			reject('mapping-untyped', `${kind} cannot be any/unknown`, op.file);
		if (['input', 'output'].includes(kind)) {
			const parse = type.getProperty('parse');
			if (!parse || !ctx.checker.getTypeOfSymbolAtLocation(parse, call).getCallSignatures().length)
				reject('mapping-schema', `${kind} must resolve to an existing runtime Schema with parse`, op.file);
		} else if (!type.getCallSignatures().length)
			reject('mapping-callable', `${kind} must resolve to an existing function`, op.file);
		return text;
	}
	for (const key of [
		'input',
		'output',
		'policy',
		'contextBuilder',
		'identityFromLegacy',
		'project',
		...(op.mappings.concurrency ? ['concurrency'] : [])
	])
		binding(op.mappings[key], key);
	const core = ctx.source('imports/core/server/operations.ts');
	if (
		!core.statements.some(
			(s) =>
				ts.isFunctionDeclaration(s) &&
				s.name?.text === 'operationHandler' &&
				s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		)
	)
		reject('core-operation-handler', 'Core operationHandler export is required', op.file);
	const names = new Set(ctx.checker.getSymbolsInScope(call, ts.SymbolFlags.Value).map((s) => s.name));
	let alias = '__coreOperationHandler';
	while (names.has(alias)) alias += '_';
	let modulePath = path
		.relative(path.dirname(sf.fileName), core.fileName)
		.split(path.sep)
		.join('/')
		.replace(/\.ts$/, '');
	if (!modulePath.startsWith('.')) modulePath = './' + modulePath;
	const importEnd = sf.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? 0;
	ctx.edit(
		sf.fileName,
		importEnd,
		0,
		`\nimport { operationHandler as ${alias} } from ${JSON.stringify(modulePath)};\n`
	);
	const m = op.mappings;
	const invoke =
		m.effect === 'read'
			? 'const raw = await legacyBusiness(parsed, legacyContext);'
			: `let invocations = 0;\n      const raw = await ${m.concurrency}(context, parsed, async () => {\n        if (++invocations !== 1) throw new Error('Legacy business callback must run exactly once');\n        return legacyBusiness(parsed, legacyContext);\n      });\n      if (invocations !== 1) throw new Error('Concurrency executor did not invoke the legacy business callback');`;
	const replacement = `((legacyBusiness: typeof this.${op.symbol}) =>\n  (input: unknown, legacyContext: Parameters<typeof legacyBusiness>[1]) => ${alias}({\n    name: ${JSON.stringify(methodName)},\n    input: ${m.input}, output: ${m.output}, effect: ${JSON.stringify(m.effect)}, policy: ${m.policy},\n    handler: async (context, parsed) => {\n      ${invoke}\n      return ${m.project}(raw, context);\n    }\n  }, ${m.contextBuilder}).call({ userId: ${m.identityFromLegacy}(legacyContext) }, input)\n)(${bound.getText(sf)})`;
	ctx.edit(sf.fileName, bound.getStart(sf), bound.getWidth(sf), replacement);
	result.diagnostics.push({
		code: 'legacy-core-operation-adapter',
		severity: 'warning',
		message:
			'Installed strict core input/output, context identity check, explicit policy and projection around the captured business callback. Legacy registration, context construction, final validator, transport error behavior and existing rate limits remain unchanged. Review identity/projection/concurrency mappings; no arbitrary ProductBase/REST/CRUD migration or concurrency proof is claimed.'
	});
}

import { astGraph } from '../../ast.mjs';
import { relative, fail, exact } from '../../lib.mjs';
export function inspectAutomation(root, input = {}) {
	exact(input, ['paths', 'maxFiles', 'maxBytes', 'changed'], []);
	const { paths = ['imports'], maxFiles = 500, maxBytes = 4 * 1024 * 1024, changed = [] } = input;
	if (!Array.isArray(changed) || changed.length > 100)
		fail('automation-inspect', 'changed must contain at most 100 paths');
	changed.forEach(relative);
	if (!Array.isArray(paths) || paths.length > 20) fail('automation-inspect', 'Expected at most 20 paths');
	paths.forEach(relative);
	if (
		!Number.isInteger(maxFiles) ||
		maxFiles < 1 ||
		maxFiles > 3000 ||
		!Number.isInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 24 * 1024 * 1024
	)
		fail('automation-budget', 'Inspection budget out of bounds');
	const graph = astGraph(root, { paths, maxFiles, maxBytes });
	return { ...graph, impact: selectImpact(graph, changed) };
}
export function selectImpact(graph, changed) {
	const affected = new Set(changed);
	let growing = true;
	while (growing) {
		growing = false;
		for (const edge of graph.edges ??
			(graph.files ?? []).flatMap((file) => (file.dependencies ?? []).map((to) => ({ from: file.file, to })))) {
			const from = edge.from ?? edge.source,
				to = edge.to ?? edge.target;
			if (affected.has(to) && !affected.has(from)) {
				affected.add(from);
				growing = true;
			}
		}
	}
	return {
		affected: [...affected].sort(),
		suggestedTests: [...affected].filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)).sort(),
		mandatoryGates: ['typecheck', 'test:core', 'test:mutations', 'test:toolkit', 'verify'],
		notice: 'Impact selection accelerates iteration only; it never replaces full acceptance.'
	};
}

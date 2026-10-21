import { validateLegacyMetadata } from './legacy-fields.mjs';
import fs from 'node:fs';
import { confined, exact, fail, hash } from './lib.mjs';
export function architectureContext(root, sourceFiles) {
	const names = [
		...new Set(sourceFiles.map((file) => file.match(/^imports\/modules\/([^/]+)\//)?.[1]).filter(Boolean))
	].sort();
	return names.map((name) => {
		for (const filename of ['architecture.manifest.json', 'module.manifest.json']) {
			const file = `imports/modules/${name}/${filename}`,
				target = confined(root, file, { missing: true });
			if (!fs.existsSync(target)) continue;
			if (fs.statSync(target).size > 1024 * 1024) fail('architecture-budget', 'Manifest exceeds 1 MiB', file);
			const content = fs.readFileSync(target, 'utf8'),
				manifest = JSON.parse(content);
			if (filename === 'architecture.manifest.json') {
				exact(
					manifest,
					['schemaVersion', 'name', 'architecture', 'reference', 'publicContracts', 'guidance', 'legacy'],
					['schemaVersion', 'name', 'architecture', 'reference', 'publicContracts', 'guidance']
				);
				if (
					manifest.schemaVersion !== 1 ||
					manifest.name !== name ||
					!['legacy', 'core-v1', 'domain-only'].includes(manifest.architecture) ||
					typeof manifest.reference !== 'boolean' ||
					!Array.isArray(manifest.publicContracts) ||
					manifest.publicContracts.some((p) => typeof p !== 'string' || !p.startsWith('contracts/')) ||
					typeof manifest.guidance !== 'string'
				)
					fail('architecture-schema', 'Invalid architecture manifest', file);
				const legacyReferences = manifest.legacy
					? validateLegacyMetadata(root, name, manifest.legacy).references
					: undefined;
				return {
					module: name,
					file,
					hash: hash(content),
					...manifest,
					...(legacyReferences ? { legacyReferences } : {})
				};
			}
			const architecture =
				manifest.templateVersion === '2.0.0'
					? 'recipe-v2'
					: manifest.templateVersion === '1.0.0'
						? 'core-v1'
						: 'unknown';
			return {
				module: name,
				file,
				hash: hash(content),
				architecture,
				reference: false,
				guidance:
					architecture === 'unknown'
						? 'Inspect the module before selecting a pattern.'
						: 'Use its versioned manifest and deterministic tooling; keep custom behavior outside generated files.'
			};
		}
		return {
			module: name,
			architecture: 'unknown',
			reference: false,
			guidance: 'No manifest: inspect before selecting a pattern.'
		};
	});
}

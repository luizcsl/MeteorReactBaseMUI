import fs from 'node:fs';
import path from 'node:path';
import { confined, files, hash, readJson, validateSpec, fail } from './lib.mjs';
export function scaffold(root, input) {
  const spec = validateSpec(input);
  const templateRoot = confined(root, 'templates/owner-crud/v1');
  const metadata = readJson(path.join(templateRoot, 'template.json'));
  const source = path.join(templateRoot, 'files');
  const entries = files(source);
  if (!entries.length) fail('empty-template', 'Template has no files');
  const rendered = {};
  const upper = spec.name[0].toUpperCase() + spec.name.slice(1);
  const replace = text => text.replace(/__MODULE_UPPER__/g, spec.name.toUpperCase()).replace(/__MODULE__/g, spec.name).replace(/__Module__/g, upper);
  for (const file of entries) {
    const content = fs.readFileSync(confined(source, file), 'utf8');
    if (metadata.sha256[file] !== hash(content)) fail('template-drift', 'Template hash differs from versioned manifest', file);
    const name = replace(file).replace(/\.template$/, '');
    rendered[name] = replace(content);
  }
  if (Object.keys(metadata.sha256).length !== entries.length) fail('template-drift', 'Template file set differs from manifest');
  const manifest = { schemaVersion: 1, coreVersion: '1.0.0', templateVersion: spec.templateVersion, spec, files: Object.fromEntries(Object.entries(rendered).map(([name, content]) => [name, hash(content)])), registration: { server: `Import register${upper} from imports/modules/${spec.name}/server/register and invoke it once with a server-owned ContextBuilder in the server registry.`, ui: `Import default ${upper}Page from imports/modules/${spec.name}/ui/${upper}Page and add an authenticated route.`, tests: `Import imports/modules/${spec.name}/tests/policy.test from tests/main.ts before qualifying the module.` }, qualified: false };
  rendered['module.manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
  const parent = confined(root, 'imports/modules');
  const destination = confined(root, `imports/modules/${spec.name}`, { missing: true });
  if (fs.existsSync(destination)) {
    const present = files(destination);
    if (present.length !== Object.keys(rendered).length || present.some(name => !Object.hasOwn(rendered, name) || fs.readFileSync(confined(destination,name),'utf8') !== rendered[name])) fail('collision', 'Existing module differs; no files were changed', destination);
    return { status: 'unchanged', module: spec.name, manifest };
  }
  const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
  try {
    for (const [name,content] of Object.entries(rendered)) { const target = confined(staging,name,{missing:true}); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,content,{flag:'wx'}); }
    // Recheck before rename. A same-name concurrent generator must not replace another module.
    if (fs.existsSync(destination)) fail('collision', 'Destination appeared during generation', destination);
    fs.renameSync(staging,destination);
  } finally { fs.rmSync(staging,{recursive:true,force:true}); }
  return { status:'created', module:spec.name, manifest };
}

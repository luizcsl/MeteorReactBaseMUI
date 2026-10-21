import fs from 'node:fs';
import path from 'node:path';
import { confined, fail, validateTask, hash } from './lib.mjs';
const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
export function context(root, input) {
  const task = validateTask(input);
  const queue = [...new Set(task.contextFiles)].sort();
  const visited = new Set(), records = [], external = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    if (/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.aws(?:\/|$)|credentials|secrets)(?!example)/i.test(file) || /\.(?:pem|key|p12|pfx)$/i.test(file)) fail('sensitive-context', 'Credential/configuration files cannot be included in agent context', file);
    visited.add(file);
    if (visited.size > task.budget.contextFiles) fail('context-budget', 'Dependency closure exceeds contextFiles; narrow scope or request explicit budget expansion',file);
    const source = fs.readFileSync(confined(root,file),'utf8');
    const dependencies = [];
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('/imports/')) { external.add(specifier); continue; }
      const base = specifier.startsWith('/imports/') ? specifier.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
      let resolved;
      for (const extension of extensions) {
        const candidate = base + extension;
        try { const target = confined(root,candidate); if (fs.statSync(target).isFile()) { resolved = candidate; break; } } catch (error) { if (error.rule !== 'missing-file') throw error; }
      }
      if (!resolved) fail('unresolved-dependency', `Cannot resolve ${specifier}`,file);
      dependencies.push(resolved); if (!visited.has(resolved)) queue.push(resolved);
    }
    queue.sort();
    const symbols = source.split('\n').flatMap((line,index) => /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|interface|type|function|const|enum)\b/.test(line) ? [{line:index+1,signature:line.trim().slice(0,300)}] : []);
    records.push({ file, sha256:hash(source), dependencies:[...new Set(dependencies)].sort(), symbols, source });
  }
  records.sort((a,b)=>a.file.localeCompare(b.file,'en'));
  const result = { schemaVersion:1, task, algorithm:'sorted lexical import closure v1; dynamic computed imports require explicit contextFiles', externalDependencies:[...external].sort(), files:records };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > task.budget.contextBytes) fail('context-budget', `Closure needs ${bytes} bytes; budget is ${task.budget.contextBytes}. No partial context emitted.`);
  return result;
}

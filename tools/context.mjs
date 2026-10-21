import fs from 'node:fs';
import path from 'node:path';
import { confined, fail, validateTask, hash } from './lib.mjs';
const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
export function context(root, input) {
  const task = validateTask(input);
  const queue = [...new Set(task.contextFiles)].sort();
  const visited = new Set(), records = [], external = new Set();
  let sourceBytes = 0;
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    if (/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.aws(?:\/|$)|credentials|secrets)(?!example)/i.test(file) || /\.(?:pem|key|p12|pfx)$/i.test(file)) fail('sensitive-context', 'Credential/configuration files cannot be included in agent context', file);
    visited.add(file);
    if (visited.size > task.budget.contextFiles) fail('context-budget', 'Dependency closure exceeds contextFiles; narrow scope or request explicit budget expansion',file);
    const target = confined(root,file);
    const stat = fs.statSync(target);
    if (!stat.isFile()) fail('context-file', 'Context requires regular files', file);
    if (stat.size > task.budget.contextBytes - sourceBytes) fail('context-budget', 'Cumulative source bytes exceed contextBytes before content load', file);
    // Bound allocation/read as well as output. A concurrent growing file cannot
    // cause readFileSync to allocate beyond the approved budget after the stat.
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let source;
    try {
      const current = fs.fstatSync(descriptor);
      if (!current.isFile() || current.size !== stat.size) fail('context-changed', 'Context file changed before reading', file);
      const buffer = Buffer.alloc(stat.size + 1);
      let loaded = 0, count;
      while (loaded < buffer.length && (count = fs.readSync(descriptor, buffer, loaded, buffer.length - loaded, loaded)) > 0) loaded += count;
      if (loaded !== stat.size) fail('context-changed', 'Context file changed while reading', file);
      sourceBytes += loaded;
      source = buffer.subarray(0, loaded).toString('utf8');
    } finally { fs.closeSync(descriptor); }
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
  const bytes = Buffer.byteLength(JSON.stringify(result, null, 2) + '\n');
  if (bytes > task.budget.contextBytes) fail('context-budget', `Closure needs ${bytes} bytes; budget is ${task.budget.contextBytes}. No partial context emitted.`);
  return result;
}

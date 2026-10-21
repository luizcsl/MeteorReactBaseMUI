import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export class Diagnostic extends Error {
  constructor(rule, message, file = '', command = '') { super(message); Object.assign(this, { rule, file, line: 1, command }); }
}
export function fail(rule, message, file = '', command = '') { throw new Diagnostic(rule, message, file, command); }
export const stable = value => JSON.stringify(value, Object.keys(value).sort());
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('invalid-json', 'Expected readable JSON', file); } }
export function exact(object, keys, required = keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail('schema', 'Expected object');
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail('schema', `Unknown field: ${key}`);
  for (const key of required) if (!Object.hasOwn(object, key)) fail('schema', `Missing field: ${key}`);
}
export function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(x => x === '..' || x === '.' || !x)) fail('path', `Unsafe relative path: ${value}`);
  return value;
}
export function confined(root, relativePath, { missing = false } = {}) {
  relative(relativePath);
  const base = fs.realpathSync(root);
  let current = base;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT' && missing) continue; if (error.code === 'ENOENT') fail('missing-file', 'File does not exist', relativePath); throw error; }
    if (stat.isSymbolicLink()) fail('symlink', 'Symbolic links are not allowed', relativePath);
  }
  return current;
}
export function files(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    if (['node_modules', '.git', '.meteor', '.staging'].includes(entry.name)) continue;
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) fail('symlink', 'Symbolic links are not allowed', name);
    if (entry.isDirectory()) result.push(...files(path.join(root, entry.name), name + '/'));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}
export function validateSpec(spec) {
  exact(spec, ['schemaVersion','templateVersion','profile','name']);
  if (spec.schemaVersion !== 1 || spec.templateVersion !== '1.0.0') fail('spec-version', 'Supported schemaVersion=1 and templateVersion=1.0.0');
  if (spec.profile !== 'owner-crud') fail('unsupported-profile', 'Only owner-crud is qualified. Tenants, files, integrations, offline and AI runtime are not generated.');
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9]{2,31}$/.test(spec.name) || ['tasks','core','index','server','client','test','tests','constructor','prototype','__proto__'].includes(spec.name)) fail('module-name', 'Use a unique lowercase alphanumeric module name (3–32 characters)');
  return spec;
}
// Task scopes cannot authorize changes to their own evaluator or runtime/build gates.
// Platform/configuration edits require a separately reviewed supervisor workflow.
export const protectedPath = value => value === 'imports/libs/router.ts' || /^(?:tools|evals|templates|tests|cypress|\.cypress|\.meteor|\.github|\.git|\.agent-state|\.babel-plugins)(?:\/|$)/.test(value)
  || /(?:^|\/)(?:AGENTS\.md|\.babelrc(?:\.[^/]+)?|babel\.config\.[^/]+|\.meteorignore|\.npmrc|\.gitignore|\.nvmrc|\.node-version|package(?:-lock)?\.json|tsconfig\.json|Dockerfile(?:\.[^/]+)?|docker-compose(?:[.-][^/]+)?\.ya?ml|cypress[^/]*\.config\.[^/]+)$/.test(value)
  || /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/.test(value);
export function validateTask(task) {
  exact(task, ['schemaVersion','id','objective','acceptance','allowedPaths','contextFiles','commands','budget','state']);
  if (task.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{2,63}$/.test(task.id)) fail('task-schema', 'Invalid task version or id');
  if (typeof task.objective !== 'string' || !task.objective.trim()) fail('task-schema', 'Objective required');
  for (const key of ['acceptance','allowedPaths','contextFiles','commands']) if (!Array.isArray(task[key]) || !task[key].length || task[key].some(x => typeof x !== 'string' || !x)) fail('task-schema', `${key} must be a non-empty string array`);
  for (const p of task.allowedPaths) { relative(p.replace(/\/$/, '')); if (protectedPath(p)) fail('protected-scope', 'Task may not alter its gates or protected tests', p); }
  task.contextFiles.forEach(relative);
  exact(task.budget, ['seconds','tokens','costUSD','files','attempts','contextBytes','contextFiles']);
  for (const [key,value] of Object.entries(task.budget)) if (!Number.isFinite(value) || value <= 0 || (key !== 'costUSD' && !Number.isInteger(value))) fail('task-budget', `Invalid ${key}`);
  if (task.budget.contextBytes > 1000000 || task.budget.contextFiles > 200 || task.budget.files > 100 || task.budget.attempts > 10) fail('task-budget', 'Budget exceeds toolkit safety ceilings');
  if (!['planned','running','needs-review','passed','failed'].includes(task.state)) fail('task-state', 'Invalid state');
  return task;
}
export const allowed = (file, paths) => !protectedPath(file) && paths.some(p => p.endsWith('/') ? file.startsWith(p) : file === p);

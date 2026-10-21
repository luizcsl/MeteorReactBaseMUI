import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateSpec, validateTask, confined, allowed } from '../lib.mjs';
import { context } from '../context.mjs';
import { patchCheck, boundaries, taskTransition } from '../checks.mjs';
const example=JSON.parse(fs.readFileSync(new URL('../task.example.json',import.meta.url),'utf8'));
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-toolkit-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
function write(root,name,content) { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),content); }
test('versioned specs reject unknown fields, profiles and traversal',()=>{
  const spec={schemaVersion:1,templateVersion:'1.0.0',profile:'owner-crud',name:'notes'};
  assert.equal(validateSpec(spec).name,'notes');
  for(const change of [{name:'../escape'},{profile:'tenant'},{schemaVersion:2},{surprise:true}]) assert.throws(()=>validateSpec({...spec,...change}));
});
test('scope protects evaluator, tests, package metadata and rejects wildcard escapes',()=>{
  assert.throws(()=>validateTask({...example,allowedPaths:['tools/']}));
  assert.throws(()=>validateTask({...example,allowedPaths:['../outside/']}));
  assert.equal(allowed('imports/modules/tasks/tests/x.test.ts',['imports/modules/tasks/']),false);
  assert.equal(allowed('imports/modules/tasks/domain/task.ts',example.allowedPaths),true);
  assert.equal(allowed('imports/modules/tasks2/domain/task.ts',example.allowedPaths),false);
});
test('symlink confinement rejects links including dangling targets',t=>{
  const root=fixture(t); fs.symlinkSync('/tmp',path.join(root,'escape')); assert.throws(()=>confined(root,'escape/a',{missing:true}));
  fs.symlinkSync('/nonexistent-ai-toolkit-target',path.join(root,'dangling')); assert.throws(()=>confined(root,'dangling/a',{missing:true}));
});
test('context is deterministic, closes transitive imports, exposes exports, fails rather than truncating',t=>{
  const root=fixture(t); write(root,'imports/a.ts',"import { b } from './b';\nexport const a = b;"); write(root,'imports/b.ts',"export { c as b } from './c';"); write(root,'imports/c.ts','export const c = 1;');
  const task={...example,contextFiles:['imports/a.ts']};
  const result=context(root,task); assert.deepEqual(result.files.map(x=>x.file),['imports/a.ts','imports/b.ts','imports/c.ts']);
  assert.equal(result.files[2].symbols[0].signature,'export const c = 1;'); assert.deepEqual(context(root,task),result);
  assert.throws(()=>context(root,{...task,budget:{...task.budget,contextBytes:20}}),/Closure needs/);
  assert.throws(()=>context(root,{...task,budget:{...task.budget,contextFiles:1}}),/closure exceeds/);
});
test('boundary rules reject server dependencies from UI and cross-module internals',t=>{
  const root=fixture(t); write(root,'imports/modules/a/ui/Page.ts',"import x from '../server/repository';\nimport y from '../../b/domain/foo';");
  assert.deepEqual(boundaries(root).diagnostics.map(x=>x.rule),['ui-server','module-private']);
});
test('patch check includes untracked files and never blesses changes to protected gates',t=>{
  const root=fixture(t); spawnSync('git',['init','-q'],{cwd:root}); write(root,'initial','base'); spawnSync('git',['add','.'],{cwd:root}); spawnSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],{cwd:root});
  write(root,'imports/modules/tasks/domain/task.ts','export const x=1;'); assert.equal(patchCheck(root,example).status,'passed');
  write(root,'tools/cli.mjs','bad'); assert.throws(()=>patchCheck(root,example),/Out-of-scope/);
});
test('usage over budget becomes needs-review, self-reported success cannot pass',()=>{
  const usage={seconds:1,tokens:1,costUSD:0,attempts:1,success:true}; assert.equal(taskTransition(example,usage).state,'running');
  assert.equal(taskTransition(example,{...usage,attempts:4}).state,'needs-review'); assert.throws(()=>taskTransition(example,{...usage,tokens:-1}));
});

test('task usage persists cumulatively and cannot reset budgets by editing contract',async t=>{
  const {saveTaskState}=await import('../checks.mjs'); const root=fixture(t);
  const usage={seconds:1,tokens:2,costUSD:0.1,attempts:1};
  assert.equal(saveTaskState(root,example,usage).usage.attempts,1);
  assert.equal(saveTaskState(root,example,usage).usage.tokens,4);
  assert.throws(()=>saveTaskState(root,{...example,budget:{...example.budget,attempts:9}},usage),/contract changed/);
  assert.equal(saveTaskState(root,example,usage).state,'needs-review');
  assert.throws(()=>saveTaskState(root,example,usage),/Terminal/);
});

test('context refuses credential files even when explicitly requested',t=>{
  const root=fixture(t); write(root,'.env','SECRET=do-not-print');
  assert.throws(()=>context(root,{...example,contextFiles:['.env']}),/Credential/);
});

test('patch check counts ignored nested source files while excluding only root dependency/cache trees',t=>{
  const root=fixture(t); spawnSync('git',['init','-q'],{cwd:root}); write(root,'.gitignore','.generated-staging/\nnode_modules/\n.meteor/\n'); write(root,'initial','base'); spawnSync('git',['add','.'],{cwd:root}); spawnSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],{cwd:root});
  write(root,'node_modules/pkg/cache.js','dependency'); write(root,'.meteor/local/cache.js','cache');
  write(root,'imports/modules/tasks/domain/task.ts',"import './.generated-staging/helper';");
  write(root,'imports/modules/tasks/domain/.generated-staging/helper.ts','export const hidden=1;');
  const narrow={...example,allowedPaths:['imports/modules/tasks/domain/task.ts']};
  assert.throws(()=>patchCheck(root,narrow),/Out-of-scope.*helper.ts/);
  const broad={...example,budget:{...example.budget,files:1}};
  assert.throws(()=>patchCheck(root,broad),/Changed 2 files/);
  const result=patchCheck(root,example); assert.equal(result.changed.length,2); assert.ok(result.changed.some(p=>p.endsWith('helper.ts')));
  write(root,'imports/modules/tasks/domain/node_modules/malicious.js','hidden nested source');
  assert.equal(patchCheck(root,example).changed.length,3);
});

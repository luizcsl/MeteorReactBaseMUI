#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJson, fail, validateTask } from './lib.mjs';
import { scaffold } from './scaffold.mjs';
import { context } from './context.mjs';
import { patchCheck, boundaries, docsCheck, doctor, taskTransition, saveTaskState, changedFiles } from './checks.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [command,...args]=process.argv.slice(2);
function option(name) { const index=args.indexOf(name); if(index<0 || !args[index+1] || args[index+1].startsWith('--')) fail('usage',`Required ${name} VALUE`); return args[index+1]; }
const verifications=[];
function run(cmd,argv) { const result=spawnSync(cmd,argv,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}); const output=(result.stdout||'')+(result.stderr||''); verifications.push({command:[cmd,...argv],exitCode:result.status,output}); if(result.status!==0) fail('verification-failed',`${cmd} ${argv.join(' ')} failed: ${output.slice(-6000)}`,'',`${cmd} ${argv.join(' ')}`); }
try {
  if(args.includes('--help') || command === '--help') {
    const help = {
      'module:new': {command:'npm run module:new -- --spec templates/owner-crud/example.spec.json', schema:'tools/schemas/module-spec.v1.schema.json', example:readJson(path.join(root,'templates/owner-crud/example.spec.json')), note:'Owner-only title/status CRUD. Atomic directory install, collision rejection, idempotent rerun. Register server/UI/tests explicitly from generated manifest; qualified=false until independent tests pass.'},
      'agent:context': {command:'npm run agent:context -- --task tools/task.example.json', schema:'tools/schemas/task.v1.schema.json', example:readJson(path.join(root,'tools/task.example.json')), note:'Deterministic transitive lexical import closure. Fails closed on unresolved dependency or context budget; computed imports require explicit contextFiles.'},
      'task:state': {command:'npm run task:state -- --task tools/task.example.json --evidence usage.json', exampleEvidence:{seconds:30,tokens:1500,costUSD:0.02,attempts:1}, note:'Cumulative usage persisted under .agent-state; exhausted budget is needs-review. This is not an executor or independent qualification.'}
    };
    process.stdout.write(JSON.stringify(help[command] || {commands:['doctor','module:new','agent:context','task:validate','task:state','patch:check','boundaries:check','docs:verify','templates:verify','check:changed'],diagnostics:'JSON by default; --json accepted. Exit 0 passed, 1 failed, 2 invalid usage.'},null,2)+'\n');
    process.exit(0);
  }
  let result;
  switch(command) {
    case 'doctor': result=doctor(root); break;
    case 'module:new': result=scaffold(root,readJson(option('--spec'))); break;
    case 'agent:context': result=context(root,readJson(option('--task'))); break;
    case 'task:validate': result={status:'passed',task:validateTask(readJson(option('--task')))}; break;
    case 'task:state': result=saveTaskState(root,readJson(option('--task')),readJson(option('--evidence'))); break;
    case 'patch:check': result=patchCheck(root,readJson(option('--task'))); break;
    case 'boundaries:check': result=boundaries(root); break;
    case 'docs:verify': result=docsCheck(root); break;
    case 'templates:verify': run(process.execPath,['--test','tools/test/scaffold.test.mjs']); run(process.execPath,['tools/verify-template-build.mjs']); result={status:'passed',notice:'Deterministic generation, safety invariants and generated TypeScript checked. Full Meteor runtime gates are independently required.'}; break;
    case 'check:changed': result={changed:changedFiles(root),...boundaries(root)}; if(result.status==='passed') run('npm',['run','typecheck']); break;
    default: fail('usage','Commands: doctor, module:new --spec, agent:context --task, task:validate --task, task:state --task --evidence, patch:check --task, boundaries:check, docs:verify, templates:verify, check:changed');
  }
  if(verifications.length) result.verifications=verifications;
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.status==='failed') process.exitCode=1;
} catch(error) {
  process.stderr.write(JSON.stringify({status:'failed',diagnostics:[{file:error.file||'',line:error.line||1,rule:error.rule||'internal',message:error.message,command:error.command||`node tools/cli.mjs ${command||''}`} ]},null,2)+'\n');
  process.exitCode=error.rule==='usage'?2:1;
}

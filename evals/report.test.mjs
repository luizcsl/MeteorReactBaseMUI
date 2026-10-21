import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { wilson, reportCampaign } from './report.mjs';
const tasks=JSON.parse(readFileSync(new URL('./tasks.json',import.meta.url))).tasks;
function fixture(fn) {
 const dir=mkdtempSync(join(tmpdir(),'eval-reader-fixture-'));
 try {
  const hash=createHash('sha256').update('FIXTURE: not an agent run\n').digest('hex');
  writeFileSync(join(dir,'check.log'),'FIXTURE: not an agent run\n');
  const checks=['acceptance','security','regression','scope'].map(kind=>({kind,command:'fixture only',verifier:'fixture-test-runner',exitCode:0,artifact:'check.log',sha256:hash}));
  const result={version:1,campaignId:'fixture',taskId:tasks[0].id,arm:'contracts',repetition:1,startCommit:'a'.repeat(40),endCommit:'b'.repeat(40),fixture:true,status:'completed',attempts:[{number:1,seconds:10,costUsd:0.01,humanInterventions:0,changedFiles:['fixture.txt'],checks}]};
  const config={version:1,campaignId:'fixture',phase:'functional-pilot',seed:1,repetitions:1,taskIds:[tasks[0].id],arms:Object.fromEntries(['original','docs','contracts'].map(a=>[a,{commit:'a'.repeat(40)}])),model:{provider:'fixture',name:'fixture',version:'1',temperature:0},harness:{name:'fixture',version:'1'},results:['result.json']};
  const run=()=>{ writeFileSync(join(dir,'result.json'),JSON.stringify(result)); return reportCampaign(config,dir,{allowFixtures:true}); };
  fn({dir,result,config,run});
 } finally {rmSync(dir,{recursive:true,force:true});}
}
test('catalog is 30 concrete tasks in required category counts',()=>{assert.equal(tasks.length,30);assert.deepEqual(Object.fromEntries([...new Set(tasks.map(t=>t.category))].map(c=>[c,tasks.filter(t=>t.category===c).length])),{crud:8,security:6,ui:4,'data-sync':4,'integrations-files':4,regressions:4});});
test('Wilson interval for 27/30 is approximately .744 to .965',()=>{const w=wilson(27,30);assert.ok(w.lower>.74&&w.lower<.75);assert.ok(w.upper>.96&&w.upper<.97);assert.equal(wilson(0,0),null);assert.throws(()=>wilson(2,1));});
test('reader fixture reports missing arms, not fabricated successes',()=>fixture(({run})=>{const report=run();assert.equal(report.containsFixtures,true);assert.equal(report.complete,false);assert.equal(report.arms.original.withinBudget.rate,null);assert.equal(report.arms.contracts.withinBudget.rate,1);}));
test('fixtures rejected by default',()=>fixture(({dir,config,run})=>{run();assert.throws(()=>reportCampaign(config,dir),/Fixture result rejected/);}));
test('unknown cost prevents within-budget claim',()=>fixture(({result,run})=>{result.attempts[0].costUsd=null;assert.equal(run().arms.contracts.withinBudget.successes,0);}));
test('security failure is not self-reported success; retry is counted',()=>fixture(({result,run})=>{const a=structuredClone(result.attempts[0]);result.attempts[0].checks[1].exitCode=1;a.number=2;result.attempts.push(a);const arm=run().arms.contracts;assert.equal(arm.firstAttempt.successes,0);assert.equal(arm.withinBudget.successes,1);assert.equal(arm.securityViolationRuns.successes,1);}));
test('over-budget first attempt fails both measures',()=>fixture(({result,run})=>{result.attempts[0].seconds=1801;assert.equal(run().arms.contracts.firstAttempt.successes,0);assert.equal(run().arms.contracts.withinBudget.successes,0);}));
test('tampered artifact, duplicate results and missing check are rejected',()=>fixture(({dir,result,config,run})=>{result.attempts[0].checks[0].sha256='0'.repeat(64);assert.throws(run,/hash mismatch/);result.attempts[0].checks[0].sha256=result.attempts[0].checks[1].sha256;config.results.push('result.json');assert.throws(run,/Duplicate/);config.results.pop();result.attempts[0].checks.pop();assert.throws(run,/four independent/);}));
test('aborted run never earns verified success',()=>fixture(({result,run})=>{result.status='aborted';assert.equal(run().arms.contracts.withinBudget.successes,0);}));
test('success on fourth attempt exceeds retry budget',()=>fixture(({result,run})=>{const pass=structuredClone(result.attempts[0]);result.attempts=[1,2,3,4].map(number=>({...structuredClone(pass),number}));for(const a of result.attempts.slice(0,3)) a.checks[0].exitCode=1;assert.equal(run().arms.contracts.withinBudget.successes,0);}));
test('scope and regression failures are surfaced independently',()=>fixture(({result,run})=>{result.attempts[0].checks[2].exitCode=1;result.attempts[0].checks[3].exitCode=1;const arm=run().arms.contracts;assert.equal(arm.regressionRuns.successes,1);assert.equal(arm.scopeViolationRuns.successes,1);assert.equal(arm.securityViolationRuns.successes,0);assert.equal(arm.withinBudget.successes,0);}));
test('empty real campaign reports null estimates with planned missing counts',()=>fixture(({config,dir})=>{config.results=[];const report=reportCampaign(config,dir);assert.equal(report.containsFixtures,false);assert.equal(report.complete,false);assert.equal(report.arms.contracts.missing,1);assert.equal(report.arms.contracts.firstAttempt.wilson95,null);}));

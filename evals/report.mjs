#!/usr/bin/env node
// Offline measurement only. Never invokes an LLM or trusts an agent success claim.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const catalog = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url)));
export const ARMS = ['original', 'docs', 'contracts'];
const KINDS = ['acceptance', 'security', 'regression', 'scope'];
export function wilson(successes, total) {
  if (!Number.isInteger(total) || !Number.isInteger(successes) || total < 0 || successes < 0 || successes > total) throw new Error('Invalid binomial counts');
  if (!total) return null;
  const z = 1.959963984540054, p = successes / total, d = 1 + z*z/total;
  const center = (p + z*z/(2*total))/d;
  const half = z*Math.sqrt(p*(1-p)/total + z*z/(4*total*total))/d;
  return { lower: Math.max(0, center-half), upper: Math.min(1, center+half) };
}
const assert = (v, message) => { if (!v) throw new Error(message); };
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function verifyCheck(check, root) {
  assert(KINDS.includes(check.kind), 'Unknown check kind');
  assert(typeof check.command === 'string' && check.command.trim(), 'Check command required');
  assert(typeof check.verifier === 'string' && check.verifier.trim() && check.verifier !== 'agent-self-report', 'Independent verifier identity required');
  assert(Number.isInteger(check.exitCode) && check.exitCode >= 0, 'Check exitCode required');
  assert(typeof check.artifact === 'string' && check.artifact.length && /^[a-f0-9]{64}$/.test(check.sha256), 'Artifact path and SHA256 required');
  const path = realpathSync(resolve(root, check.artifact)), rel = relative(realpathSync(root), path);
  assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'Artifact must be inside results directory');
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert(actual === check.sha256, `Artifact hash mismatch: ${check.artifact}`);
}
export function validateResult(result, root, tasks = catalog.tasks) {
  assert(result.version === 1 && typeof result.campaignId === 'string', 'Invalid result version/campaign');
  const task = tasks.find(t => t.id === result.taskId);
  assert(task && ARMS.includes(result.arm), 'Unknown task or arm');
  assert(Number.isInteger(result.repetition) && result.repetition >= 1, 'Invalid repetition');
  assert(/^[a-f0-9]{40}$/.test(result.startCommit) && /^[a-f0-9]{40}$/.test(result.endCommit), 'Full start/end commit required');
  assert(typeof result.fixture === 'boolean', 'Explicit fixture classification required');
  assert(['completed','aborted'].includes(result.status), 'Result must be terminal');
  assert(Array.isArray(result.attempts) && result.attempts.length > 0, 'At least one attempt required');
  for (const [i,a] of result.attempts.entries()) {
    assert(a.number === i+1 && number(a.seconds) && (a.costUsd === null || number(a.costUsd)), 'Invalid attempt number/time/cost');
    assert(Number.isInteger(a.humanInterventions) && a.humanInterventions >= 0, 'Intervention count required');
    assert(Array.isArray(a.changedFiles) && a.changedFiles.every(f => typeof f === 'string'), 'Changed-file manifest required');
    assert(Array.isArray(a.checks) && a.checks.length === 4 && new Set(a.checks.map(c=>c.kind)).size === 4, 'Exactly four independent check kinds required');
    for (const c of a.checks) verifyCheck(c, root);
  }
  return task;
}
const rate = (n,d) => ({ successes:n, total:d, rate:d ? n/d : null, wilson95:wilson(n,d) });
function summarize(rows, planned) {
  let first=0, within=0, security=0, scope=0, regressions=0, seconds=0, cost=0, unknownCost=0, interventions=0;
  for (const {result:r, task:t} of rows) {
    let cumulativeSeconds=0, cumulativeCost=0, known=true, success=false;
    r.attempts.forEach((a,i)=> {
      const pass = r.status === 'completed' && a.checks.every(c=>c.exitCode===0);
      cumulativeSeconds += a.seconds;
      if (a.costUsd===null) known=false; else cumulativeCost+=a.costUsd;
      const bounded = i+1<=t.budget.maxAttempts && cumulativeSeconds<=t.budget.maxSeconds && known && cumulativeCost<=t.budget.maxCostUsd;
      if (i===0 && pass && bounded) first++;
      if (pass && bounded) success=true;
      interventions+=a.humanInterventions;
      if(a.costUsd===null) unknownCost++;
    });
    if(success) within++;
    for (const [kind, add] of [['security',()=>security++],['scope',()=>scope++],['regression',()=>regressions++]]) {
      if(r.attempts.some(a=>a.checks.some(c=>c.kind===kind && c.exitCode!==0))) add();
    }
    seconds+=cumulativeSeconds; cost+=cumulativeCost;
  }
  return { planned, observed:rows.length, missing:planned-rows.length, firstAttempt:rate(first,rows.length), withinBudget:rate(within,rows.length), securityViolationRuns:rate(security,rows.length), scopeViolationRuns:rate(scope,rows.length), regressionRuns:rate(regressions,rows.length), seconds, knownCostUsd:cost, unknownCostAttempts:unknownCost, humanInterventions:interventions };
}
export function reportCampaign(config, root, { allowFixtures=false }={}) {
  assert(config.version===1 && config.campaignId && Number.isInteger(config.repetitions) && config.repetitions>0, 'Invalid campaign');
  assert(['functional-pilot','independent-validation'].includes(config.phase), 'Invalid phase');
  assert(Number.isInteger(config.seed) && config.model?.name && config.model?.provider && config.model?.version && number(config.model?.temperature) && config.harness?.name && config.harness?.version, 'Reproducible model, harness and seed configuration required');
  assert(Array.isArray(config.taskIds) && config.taskIds.length && new Set(config.taskIds).size===config.taskIds.length && config.taskIds.every(id=>catalog.tasks.some(t=>t.id===id)), 'Invalid task selection');
  assert(Array.isArray(config.results), 'Results paths required');
  for(const arm of ARMS) assert(/^[a-f0-9]{40}$/.test(config.arms?.[arm]?.commit), `Pin full commit for ${arm}`);
  const seen=new Set(), rows=[];
  for(const name of config.results) {
    assert(typeof name==='string' && !isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Result paths must be confined');
    const resultPath=realpathSync(resolve(root,name));
    const resultRelative=relative(realpathSync(root),resultPath);
    assert(!isAbsolute(resultRelative) && resultRelative!=='..' && !resultRelative.startsWith('../'), 'Result symlink escapes evidence root');
    const result=JSON.parse(readFileSync(resultPath));
    const task=validateResult(result,root);
    assert(result.campaignId===config.campaignId && config.taskIds.includes(result.taskId) && result.repetition<=config.repetitions, 'Result does not belong to campaign');
    assert(result.startCommit===config.arms[result.arm].commit, 'Result baseline differs from campaign arm');
    assert(allowFixtures || !result.fixture, 'Fixture result rejected: use --allow-fixtures only for reader tests');
    const key=[result.arm,result.taskId,result.repetition].join(':');
    assert(!seen.has(key), `Duplicate result ${key}`); seen.add(key);
    rows.push({result,task});
  }
  const arms={};
  for(const arm of ARMS) {
    const selected=rows.filter(r=>r.result.arm===arm), categories={};
    for(const category of new Set(catalog.tasks.map(t=>t.category))) {
      const planned=config.taskIds.filter(id=>catalog.tasks.find(t=>t.id===id).category===category).length*config.repetitions;
      categories[category]=summarize(selected.filter(r=>r.task.category===category),planned);
    }
    arms[arm]={...summarize(selected,config.taskIds.length*config.repetitions),categories};
  }
  return {version:1,campaignId:config.campaignId,phase:config.phase,fixtureOnly:rows.length>0&&rows.every(r=>r.result.fixture),containsFixtures:rows.some(r=>r.result.fixture),complete:Object.values(arms).every(a=>a.missing===0),arms,limitations:['Rates use observed terminal runs only; missing runs are shown separately. No observations means no estimate.','Wilson intervals assume independent Bernoulli trials; repeated tasks/models are correlated. This pilot does not prove future success or causal improvement.','Hashes establish artifact integrity, not correctness or verifier independence. A trusted external evaluator must own checks and result manifests.','No superiority claim is generated; use held-out tasks, paired comparisons and independent review.']};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const path=resolve(process.argv[2] || 'evals/campaign.example.json'); const config=JSON.parse(readFileSync(path)); console.log(JSON.stringify(reportCampaign(config,dirname(path),{allowFixtures:process.argv.includes('--allow-fixtures')}),null,2)); }
  catch(error) { console.error(`eval report: ${error.message}`); process.exitCode=1; }
}

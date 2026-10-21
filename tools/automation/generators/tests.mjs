import { validateDefinition } from '../../recipes.mjs';
import { exactObject } from './ui.mjs';
import { buildSync } from 'esbuild';
const compiled = buildSync({
	entryPoints: [new URL('../../../imports/core/recipes/definition.ts', import.meta.url).pathname],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false
});
const { parseRecipeData } = await import(
	'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
export function fixtureData(definition) {
	const d = validateDefinition(definition);
	const data = Object.fromEntries(
		d.fields.map((f) => [
			f.name,
			f.type === 'boolean'
				? false
				: f.type === 'enum'
					? f.values[0]
					: f.type === 'date'
						? '2026-01-01'
						: f.type === 'integer' || f.type === 'money'
							? Math.min(f.max ?? Number.MAX_SAFE_INTEGER, Math.max(f.min ?? 0, 0))
							: f.type === 'reference'
								? 'fixture-ref'
								: 'fixture'.slice(0, f.maxLength)
		])
	);
	for (const r of d.rules ?? []) {
		if (data[r.left] > data[r.right]) {
			const left = d.fields.find((f) => f.name === r.left);
			data[r.left] = left.min ?? data[r.right];
		}
	}
	try {
		return parseRecipeData(d, data);
	} catch {
		throw new Error(
			'tests: cannot construct valid bounded fixture; specification needs an explicit satisfiable contract'
		);
	}
}
export function validateTests(input = {}) {
	const o = exactObject(input, ['propertyCases', 'browserPath'], 'tests');
	if (Object.values(o).some((value) => value === null)) throw new Error('tests: explicit null is unsupported');
	const propertyCases = o.propertyCases ?? 32;
	if (!Number.isInteger(propertyCases) || propertyCases < 1 || propertyCases > 100)
		throw new Error('tests: propertyCases must be 1–100');
	if (
		o.browserPath !== undefined &&
		(typeof o.browserPath !== 'string' ||
			!/^\/[a-zA-Z0-9/_-]{1,120}$/.test(o.browserPath) ||
			o.browserPath.includes('//'))
	)
		throw new Error('tests: invalid local browser path');
	return { propertyCases, ...(o.browserPath ? { browserPath: o.browserPath } : {}) };
}
export function renderTests({ definition, tests = {}, services = {} }) {
	const d = validateDefinition(definition),
		options = validateTests(tests),
		data = fixtureData(d),
		base = `imports/modules/${d.name}/generated`,
		parent = d.profile === 'master-detail' ? 'fixture-parent' : null;
	return {
		[`${base}/fixtures.ts`]: `// Synthetic only. These fixtures do not establish application acceptance.\nimport { type RecipeData } from '../../../core/recipes/definition';\nexport const validData:RecipeData=${JSON.stringify(data)};\nexport const parentId=${JSON.stringify(parent)};\nexport const syntheticActors={owner:'fixture-alice',other:'fixture-bob',tenant:'fixture-tenant',otherTenant:'fixture-other'} as const;\n`,
		[`${base}/automation.node.test.ts`]: `// Complementary generated checks. Never replace protected tests/core or security suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeData } from '../../../core/recipes/definition';
import { recipeService, type RecipeIdentity, type RecipeRecord, type RecipeRepository, type RecipeScope } from '../../../core/recipes/server/engine';
import { definition } from './definition';
import { validData,parentId,syntheticActors } from './fixtures';
function harness() {
 const rows=new Map<string,RecipeRecord>();let revoked=false;
 let identity:RecipeIdentity={userId:syntheticActors.owner,tenantId:syntheticActors.tenant,roles:['member','reviewer']};
 const matches=(row:RecipeRecord,scope:RecipeScope)=>!row.deleted&&Object.entries(scope).every(([key,value])=>key==='tenantId'&&value===null?row.tenantId===undefined:row[key as keyof RecipeRecord]===value);
 const repository:RecipeRepository={
  find:async(scope,id)=>{const row=rows.get(id);return row&&matches(row,scope)?structuredClone(row):null;},
  list:async(scope,filters,limit)=>[...rows.values()].filter(row=>matches(row,scope)&&Object.entries(filters).every(([key,value])=>row.data[key]===value)).slice(0,limit).map(row=>structuredClone(row)),
  insert:async row=>{if(!rows.has(row._id))rows.set(row._id,structuredClone(row));return structuredClone(rows.get(row._id)!);},
  compareAndSet:async(scope,id,version,next)=>{const row=rows.get(id);if(!row||!matches(row,scope)||row.version!==version)return false;rows.set(id,{...row,...structuredClone(next)});return true;},
  remove:async(scope,id,version)=>{const row=rows.get(id);if(!row||!matches(row,scope)||row.version!==version)return false;rows.set(id,{...row,deleted:true,data:{},version:version+1});return true;}
 };
 const service=recipeService(definition,{repository,resolveIdentity:async()=>{if(revoked)throw new Error('revoked');return structuredClone(identity);},parentExists:async()=>true,referenceExists:async()=>true});
 return {service,rows,as:(who:RecipeIdentity)=>{identity=who;},revoke:()=>{revoked=true;}};
}
const create={data:validData,parentId,mutationId:'fixture-create'};
const query={filters:{},limit:100,...(definition.profile==='master-detail'?{parentId}:{})};
test('generated fixture and strict DTO contract',()=>{
 assert.deepEqual(parseRecipeData(definition,validData),validData);
 for(const key of ['ownerId','tenantId','roles','$where','__proto__'])assert.throws(()=>parseRecipeData(definition,{...validData,[key]:'forged'}));
 for(const field of definition.fields)assert.throws(()=>parseRecipeData(definition,{...validData,[field.name]:{unexpected:true}}));
});
test('generated deterministic invalid-input property cases',()=>{
 let seed=0x5eed;
 for(let index=0;index<${options.propertyCases};index++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;assert.throws(()=>parseRecipeData(definition,{...validData,['unknown'+seed]:seed}));}
});
test('generated anonymous, cross-tenant, scope and revocation matrix',async()=>{
 const h=harness();const alice=syntheticActors.owner;
 await assert.rejects(h.service.list(null,query));await assert.rejects(h.service.create(null,create));
 const row=await h.service.create(alice,create);
 assert.deepEqual(Object.keys(row).sort(),['data','id','parentId','state','version']);
 assert.equal((await h.service.create(alice,create)).id,row.id);
 h.as({userId:syntheticActors.other,tenantId:syntheticActors.otherTenant,roles:['member','reviewer']});
 assert.deepEqual(await h.service.list(syntheticActors.other,query),[]);
 await assert.rejects(h.service.update(syntheticActors.other,{id:row.id,version:row.version,data:validData}));
 await assert.rejects(h.service.remove(syntheticActors.other,{id:row.id,version:row.version}));
 if(definition.permissions.read.every(role=>role==='owner')){
  h.as({userId:syntheticActors.other,tenantId:syntheticActors.tenant,roles:[]});
  assert.deepEqual(await h.service.list(syntheticActors.other,query),[]);
 }
 h.as({userId:alice,tenantId:syntheticActors.tenant,roles:['member','reviewer']});
 const updated=await h.service.update(alice,{id:row.id,version:row.version,data:validData});assert.equal(updated.version,row.version+1);
 await assert.rejects(h.service.update(alice,{id:row.id,version:row.version,data:validData}));
 h.revoke();await assert.rejects(h.service.list(alice,query));await assert.rejects(h.service.remove(alice,{id:row.id,version:updated.version}));
 assert.equal(h.rows.get(row.id)!.deleted,false);
});
`,
		[`imports/modules/${d.name}/automation/tests/browser.cy.js`]: `// Requires explicitly provisioned synthetic account and integrated route. Fails, never skips, if absent.
import { loginWithForm } from '../../../../../.cypress/ai-ready/helpers';
describe(${JSON.stringify(d.name + ' generated interface')},()=>{
 beforeEach(()=>{loginWithForm();cy.visit(${JSON.stringify(options.browserPath ?? '/' + d.name)});});
 it('renders labeled fields, bounded grid and responsive actions',()=>{
  cy.get('[aria-label="${d.name}"]').should('be.visible');
  cy.get('form').find('input').each(input=>{expect(input.attr('id')||input.attr('aria-label'),'input has accessible label association').to.be.a('string').and.not.be.empty;});
  for(const width of [375,1280]){cy.viewport(width,800);cy.get('form').should('be.visible');cy.get('[role="grid"]').should('be.visible');cy.screenshot('${d.name}-'+width,{capture:'viewport',overwrite:true});}
 });
 it('creates through the schema form and opens a record detail',()=>{
  const fields=${JSON.stringify(d.fields)},data=${JSON.stringify(data)};
  const submitStep=()=>cy.get('form').then(form=>{
   for(const field of fields){
    const label=[...form[0].querySelectorAll('label')].find(label=>label.textContent?.replace(/\\s*\\*$/,'').trim()===field.label);
    if(!label)continue;
    if(field.type==='boolean'){cy.wrap(label).find('input').then(input=>{if(Boolean(data[field.name])!==input.prop('checked'))cy.wrap(input).click({force:true});});continue;}
    const id=label.getAttribute('for');if(!id)throw new Error('Missing accessible input id');
    if(field.type==='enum'){cy.get('[id="'+id+'"]').click();cy.get('[role="option"]').contains(String(data[field.name])).click();}
    else {const value=field.type==='money'?(Number(data[field.name])/10**field.scale).toFixed(field.scale):String(data[field.name]);cy.get('[id="'+id+'"]').clear().type(value);}
   }
   const next=[...form[0].querySelectorAll('button')].some(button=>/^(Next|Próximo)$/.test(button.textContent));
   cy.wrap(form).find('button[type="submit"]').click();if(next)submitStep();
  });
  submitStep();cy.contains('[role="status"]',/Operation completed|Operação concluída/).should('be.visible');cy.get('[role="grid"]').find('button[aria-label^="Details "],button[aria-label^="Detalhes "]').first().click();cy.get('[role="dialog"]').should('be.visible').find('dl').should('exist');
 });
${
	services.search
		? ` it('uses bounded server cursor controls',()=>{cy.contains('label',/Page size|Tamanho da página/).should('be.visible');cy.contains('label',/ID order|Ordem de ID/).should('be.visible');cy.get('[role="grid"]').should('be.visible');});`
		: ` it('searches the loaded authorized window',()=>{
  cy.get('input').filter((_,element)=>Boolean(element.id&&element.ownerDocument.querySelector('label[for="'+element.id+'"]')?.textContent?.match(/Search loaded|Pesquisar registros/))).first().type('no-such-synthetic-record');
  cy.contains(/No records found|Nenhum registro encontrado/).should('be.visible');
 });`
}

});
`,
		[`imports/modules/${d.name}/automation/tests/verify.mjs`]: `// Complementary runner; protected mandatory suites run separately and cannot be disabled here.
import { build } from 'esbuild';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../../../../..'),dir=await mkdtemp(path.join(tmpdir(),'generated-tests-'));
try{const outfile=path.join(dir,'tests.cjs');await build({entryPoints:[path.join(root,${JSON.stringify(base + '/automation.node.test.ts')})],outfile,bundle:true,platform:'node',format:'cjs'});const env={...process.env};delete env.NODE_TEST_CONTEXT;const result=spawnSync(process.execPath,['--test',outfile],{stdio:'inherit',env});process.exitCode=result.status??1;}finally{await rm(dir,{recursive:true,force:true});}
`,
		[`imports/modules/${d.name}/automation/tests/visual.mjs`]: `// Explicit reviewed baseline required; never creates or updates a baseline automatically.
import assert from 'node:assert/strict';
import sharp from 'sharp';
const [baseline,actual]=process.argv.slice(2);if(!baseline||!actual||process.argv.length!==4)throw new Error('Usage: node visual.mjs reviewed-baseline.png actual.png');
const a=await sharp(baseline).ensureAlpha().raw().toBuffer({resolveWithObject:true});const b=await sharp(actual).ensureAlpha().raw().toBuffer({resolveWithObject:true});
assert.deepEqual(a.info,b.info,'Visual dimensions changed');let changed=0;for(let i=0;i<a.data.length;i++)if(a.data[i]!==b.data[i])changed++;assert.equal(changed,0,'Visual regression: '+changed+' changed channels (review baseline manually)');
`,
		[`imports/modules/${d.name}/automation/tests/mutation.mjs`]: `// Delegates to supervisor-owned mutation checks, never generated substitutes.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../../../..');const result=spawnSync(process.execPath,[path.join(root,'tools/run-mutation-tests.mjs')],{cwd:root,stdio:'inherit'});process.exitCode=result.status??1;
`
	};
}

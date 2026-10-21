import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../scaffold.mjs';
import { files } from '../lib.mjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const spec={schemaVersion:1,templateVersion:'1.0.0',profile:'owner-crud',name:'notes'};
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'scaffold-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); fs.mkdirSync(path.join(root,'imports/modules'),{recursive:true}); fs.cpSync(path.join(repository,'templates'),path.join(root,'templates'),{recursive:true}); return root; }
test('materializes owner CRUD with contracts, policy tests and deterministic manifest; second run is unchanged',t=>{
  const root=fixture(t); const first=scaffold(root,spec); assert.equal(first.status,'created'); assert.equal(first.manifest.qualified,false);
  const generated=path.join(root,'imports/modules/notes'); const before=files(generated).map(p=>[p,fs.readFileSync(path.join(generated,p),'utf8')]);
  assert.ok(fs.existsSync(path.join(generated,'tests/policy.test.ts'))); assert.ok(fs.existsSync(path.join(generated,'ui/NotesPage.tsx')));
  assert.ok(before.every(([,source])=>!source.includes('__MODULE')&&!source.includes('__Module')));
  assert.equal(scaffold(root,spec).status,'unchanged'); assert.deepEqual(files(generated).map(p=>[p,fs.readFileSync(path.join(generated,p),'utf8')]),before);
});
test('modified destinations never overwritten and staging cleaned',t=>{
  const root=fixture(t); scaffold(root,spec); fs.writeFileSync(path.join(root,'imports/modules/notes/custom.ts'),'keep me'); assert.throws(()=>scaffold(root,spec),/Existing module differs/);
  assert.equal(fs.readFileSync(path.join(root,'imports/modules/notes/custom.ts'),'utf8'),'keep me'); assert.ok(!fs.readdirSync(path.join(root,'imports/modules')).some(x=>x.startsWith('.staging-')));
});
test('invalid input and modified template fail without partial generated module',t=>{
  const root=fixture(t); assert.throws(()=>scaffold(root,{...spec,name:'../escape'}));
  const templateFiles=path.join(root,'templates/owner-crud/v1/files'); fs.appendFileSync(path.join(templateFiles,files(templateFiles)[0]),'bad'); assert.throws(()=>scaffold(root,spec),/Template hash/); assert.deepEqual(fs.readdirSync(path.join(root,'imports/modules')),[]);
});
test('symlink destination and parent rejected',t=>{
  const root=fixture(t); fs.symlinkSync(os.tmpdir(),path.join(root,'imports/modules/notes')); assert.throws(()=>scaffold(root,spec),/Symbolic links/);
});

test('versioned template exactly matches approved canonical reference, including security tests',()=>{
  const canonical=path.join(repository,'imports/modules/tasks');
  const templates=path.join(repository,'templates/owner-crud/v1/files');
  const token=text=>text.replace(/TASKS|Tasks|Task|tasks|task/g,word=>word==='TASKS'?'__MODULE_UPPER__':word[0]==='T'?'__Module__':'__MODULE__');
  assert.deepEqual(files(templates),files(canonical).map(file=>token(file)+'.template').sort((a,b)=>a.localeCompare(b,'en')));
  for(const file of files(canonical)) assert.equal(fs.readFileSync(path.join(templates,token(file)+'.template'),'utf8'),token(fs.readFileSync(path.join(canonical,file),'utf8')),`Canonical drift: ${file}`);
});

test('unknown fields and attempted code injection leave module directory untouched',t=>{
  const root=fixture(t);
  for(const invalid of [{...spec,operations:['unsafe']},{...spec,name:"notes';process.exit(0)//"},{...spec,templateVersion:'../../other'}]) {
    assert.throws(()=>scaffold(root,invalid));
    assert.deepEqual(fs.readdirSync(path.join(root,'imports/modules')),[]);
  }
});

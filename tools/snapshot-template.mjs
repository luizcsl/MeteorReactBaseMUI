// Maintainer-only release command: review canonical source and version bump before using.
import fs from 'node:fs';
import path from 'node:path';
import { files, hash } from './lib.mjs';
const root=process.cwd();
const source=path.join(root,'imports/modules/tasks');
const target=path.join(root,'templates/owner-crud/v1');
const hashes={};
const token = text => text.replace(/TASKS|Tasks|Task|tasks|task/g, word => word === 'TASKS' ? '__MODULE_UPPER__' : word[0] === 'T' ? '__Module__' : '__MODULE__');
if (!fs.existsSync(path.join(source,'tests/policy.test.ts'))) throw new Error('Canonical security tests required');
fs.rmSync(path.join(target,'files'),{recursive:true,force:true});
for (const file of files(source)) {
  const name=token(file)+'.template', content=token(fs.readFileSync(path.join(source,file),'utf8'));
  fs.mkdirSync(path.dirname(path.join(target,'files',name)),{recursive:true});
  fs.writeFileSync(path.join(target,'files',name),content); hashes[name]=hash(content);
}
fs.writeFileSync(path.join(target,'template.json'),JSON.stringify({schemaVersion:1,templateVersion:'1.0.0',profile:'owner-crud',fields:{title:'trimmed string 1..200',status:'open | done',mutationId:'client-generated stable create retry key; owner-bound server primary key'},unsupportedProfiles:['tenant','files','integrations','offline','ai-runtime'],sha256:hashes},null,2)+'\n');

// Qualifies an isolated generated module through its real registration and DDP/Mongo boundaries.
// Never edits the source project's module registry or test entrypoints.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { scaffold } from './scaffold.mjs';
export function prepareRuntimeFixture(root, temporary) {
  for(const item of ['imports','templates','.meteor','tests','client','server','public','.babel-plugins']) {
    const source=path.join(root,item);
    if(fs.existsSync(source)) fs.cpSync(source,path.join(temporary,item),{recursive:true,filter:filename=>!filename.startsWith(path.join(root,'.meteor','local'))});
  }
  for(const item of ['package.json','package-lock.json','tsconfig.json','.meteorignore','.babelrc']) if(fs.existsSync(path.join(root,item))) fs.copyFileSync(path.join(root,item),path.join(temporary,item));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(temporary,'node_modules'),'dir');
  scaffold(temporary,{schemaVersion:1,templateVersion:'1.0.0',profile:'owner-crud',name:'verificationnotes'});
  const pkg=JSON.parse(fs.readFileSync(path.join(temporary,'package.json'),'utf8'));
  pkg.meteor={...pkg.meteor,testModule:{server:'tests/generated.server.ts',client:'tests/generated.client.ts'}};
  fs.writeFileSync(path.join(temporary,'package.json'),JSON.stringify(pkg,null,2));
  fs.writeFileSync(path.join(temporary,'tests/generated.client.ts'),'export {};\n');
  fs.writeFileSync(path.join(temporary,'tests/generated.server.ts'),`/// <reference types="mocha" />
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import { registerVerificationnotes } from '../imports/modules/verificationnotes/server/register';
import { activeAccountContext } from '../imports/core/server/identity';
import { VerificationnotesCollection } from '../imports/modules/verificationnotes/server/repository';
import '../imports/modules/verificationnotes/tests/policy.test';
registerVerificationnotes(activeAccountContext(async id => id === 'generated-owner', () => 'generated-request'));
describe('generated public registration', function () {
  this.timeout(20000);
  after(async () => { await VerificationnotesCollection.removeAsync({ownerId:'generated-owner'}); });
  it('registers namespaced methods and persists projected owner data in Mongo', async function () {
    const handlers=(Meteor as unknown as {server:{method_handlers:Record<string,(this:{userId:string},...args:unknown[])=>Promise<unknown>>}}).server.method_handlers;
    const value=await handlers['verificationnotes.create'].apply({userId:'generated-owner'},[{mutationId:'generated-fixture-create',title:'Generated fixture'}]) as {id:string};
    assert.ok(value.id); assert.equal('ownerId' in value,false);
    assert.ok(await VerificationnotesCollection.findOneAsync({_id:value.id,ownerId:'generated-owner'}));
  });
  it('exposes the real namespace over DDP and rejects anonymous and forged identity', async function () {
    const connection=DDP.connect(Meteor.absoluteUrl());
    const call=(...args:unknown[])=>new Promise((resolve,reject)=>connection.call('verificationnotes.list',...args,(error:unknown,value:unknown)=>error?reject(error):resolve(value)));
    try {
      await assert.rejects(call({after:null,limit:5}),{error:'unauthenticated'});
      await assert.rejects(call({after:null,limit:5},{userId:'generated-owner'}),{error:'invalid-input'});
    } finally { connection.disconnect(); }
  });
});
`);
  return temporary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root=process.cwd(), temporary=fs.mkdtempSync(path.join(os.tmpdir(),'template-meteor-'));
  try {
    prepareRuntimeFixture(root,temporary);
    const env=Object.fromEntries(['PATH','HOME','TMPDIR','USER','LANG','CI','METEOR_ALLOW_SUPERUSER'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    Object.assign(env,{NODE_ENV:'test',TEST_SERVER_ONLY:'1',ROOT_URL:'http://127.0.0.1:3105'});
    if(process.env.TEST_MONGO_URL) {
      const database=new URL(process.env.TEST_MONGO_URL);
      if(database.protocol!=='mongodb:' || !['127.0.0.1','localhost','[::1]'].includes(database.hostname) || database.username || database.password || !/^\/[a-z0-9_-]*(?:test|fixture)[a-z0-9_-]*$/i.test(database.pathname)) throw new Error('TEST_MONGO_URL must target an unauthenticated loopback test/fixture database');
      env.MONGO_URL=process.env.TEST_MONGO_URL;
    }
    const result=spawnSync('meteor',['test','--once','--driver-package','meteortesting:mocha','--port','3105'],{cwd:temporary,env,encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
    const output=(result.stdout||'')+(result.stderr||''); process.stdout.write(output);
    if(result.error) throw result.error;
    if(result.status!==0 || !/\b[1-9]\d* passing\b/.test(output)) throw new Error('Generated Meteor qualification failed or reported zero passing tests');
    console.log('Generated fixture registered and exercised via real Meteor/Mongo/DDP.');
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}

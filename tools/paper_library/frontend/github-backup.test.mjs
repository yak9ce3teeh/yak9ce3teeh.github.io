import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {backUpPaper,connectGithub} from './github-backup.mjs';

const token='A'.repeat(28), name='example/private-library';
const paper={fileId:17,title:'Fixture',category:'Fixture / Example',keywords:['Fixture'],sha256:createHash('sha256').update('%PDF-fixture').digest('hex'),zoteroLinks:{private:'omit'},notes:['omit']};
const pdf=async()=>new TextEncoder().encode('%PDF-fixture').buffer;
const repo={id:9,private:true,visibility:'private',has_pages:false,full_name:name,default_branch:'backups',permissions:{push:true}};
const seen=[];
let state=repo,identical=false,branchConflicts=0,flipBeforePublish=false;
async function call(_token,path,method='GET',body){
 seen.push({path,method,body});
 if(path==='/repos/'+name)return state;
 if(path.endsWith('/ref/heads/backups'))return {object:{sha:'parent'}};
 if(path.endsWith('/commits/parent'))return {tree:{sha:'original-tree'}};
 if(path.endsWith('/blobs'))return {sha:'pdf-blob'};
 if(path.endsWith('/trees'))return {sha:identical?'original-tree':'backup-tree'};
 if(path.endsWith('/commits')){
  if(flipBeforePublish)state={...repo,private:false,visibility:'public'};
  return {sha:'commit'};
 }
 if(method==='PATCH'&&branchConflicts-->0)throw Object.assign(Error('Conflict'),{status:409});
 if(method==='PATCH')return {object:{sha:'commit'}};
 throw Error('Unexpected test route '+path);
}
await assert.rejects(connectGithub(token,'example/example.github.io',call),/private backup repository/);
state={...repo,private:false,visibility:'public'};
await assert.rejects(connectGithub(token,name,call),/private repository/);
state={...repo,has_pages:true};
await assert.rejects(connectGithub(token,name,call),/Pages disabled/);
state=repo;
const connection=await connectGithub(token,name,call);
await assert.rejects(backUpPaper(connection,'personal',{...paper,sha256:'a'.repeat(64)},pdf,call),/fingerprint/);
assert.ok(seen.every(request=>request.method==='GET'));
branchConflicts=1;
const result=await backUpPaper(connection,'personal',paper,pdf,call);
assert.match(result.url,/\/tree\/backups\/paper-library\/personal\/17$/);
assert.equal(seen.filter(request=>request.method==='PATCH').length,2);
assert.ok(seen.filter(request=>request.method==='PATCH').every(request=>request.body.force===false));
const tree=seen.find(request=>request.path.endsWith('/trees')).body.tree;
assert.deepEqual(tree.map(entry=>entry.path),['paper-library/personal/17/paper.pdf','paper-library/personal/17/metadata.json']);
assert.ok(!tree[1].content.includes('omit'));
seen.length=0;
identical=true;
assert.equal((await backUpPaper(connection,'personal',paper,pdf,call)).unchanged,true);
assert.ok(seen.every(request=>request.method!=='PATCH'));
seen.length=0;
identical=false;flipBeforePublish=true;
await assert.rejects(backUpPaper(connection,'personal',paper,pdf,call),/private repository/);
assert.ok(seen.every(request=>request.method!=='PATCH'));
console.log('PASS private-only GitHub backup, no metadata leak, branch race retry, repeat backup and visibility change.');

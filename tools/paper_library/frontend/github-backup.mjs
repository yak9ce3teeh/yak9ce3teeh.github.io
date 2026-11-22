const API='https://api.github.com';
const MAX_PDF_BYTES=64*1024*1024;

function repositoryPath(value){
 const name=typeof value==='string'?value.trim():'';
 if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(name)||name.includes('..')||name.endsWith('/.'))
  throw new Error('Enter the private repository as owner/repository.');
 if(name.toLowerCase().split('/')[1].endsWith('.github.io'))
  throw new Error('Choose a private backup repository for this library.');
 return '/repos/'+name;
}
async function github(token,path,method='GET',body){
 if(typeof token!=='string'||!/^[a-zA-Z0-9_]{20,256}$/.test(token))throw new Error('Enter a GitHub personal access token.');
 const headers={Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2026-03-10'};
 if(body)headers['Content-Type']='application/json';
 let response;
 try{
  response=await fetch(API+path,{method,headers,body:body?JSON.stringify(body):undefined,
   credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(90000)});
 }catch{throw new Error('Could not reach GitHub. Check your connection and try again.');}
 const result=await response.json().catch(()=>null);
 if(!response.ok){
  const message=response.status===401?'GitHub rejected the token.'
   :response.status===403?'GitHub denied this operation. Check Contents read and write access and branch permissions.'
   :response.status===404?'GitHub could not find the repository or branch. Check the token’s repository access.'
   :response.status===409?'The GitHub branch changed during the backup.'
   :response.status===422?'GitHub rejected the update. Check branch rules and repository settings.'
   :'GitHub could not complete the backup.';
  const error=new Error(message);error.status=response.status;throw error;
 }
 return result;
}
async function privateRepository(token,name,call){
 const repo=await call(token,repositoryPath(name));
 if(repo?.private!==true||repo.visibility!=='private'||repo.has_pages)
  throw new Error('Choose a private repository with GitHub Pages disabled.');
 if(repo.permissions?.push!==true||repo.archived||repo.disabled)
  throw new Error('The GitHub repository needs write access.');
 return repo;
}
const refPath=branch=>'heads/'+branch.split('/').map(encodeURIComponent).join('/');
export async function connectGithub(token,name,call=github){
 const repo=await privateRepository(token,name,call);
 const branch=repo.default_branch;
 if(typeof branch!=='string'||!branch)throw new Error('Initialize the private repository with a README first.');
 const head=await call(token,repositoryPath(name)+'/git/ref/'+refPath(branch));
 if(!head?.object?.sha)throw new Error('Initialize the private repository with a README first.');
 return {token,repository:repo.full_name||name,repositoryId:repo.id,branch};
}
async function verifyTarget(connection,call){
 const repo=await privateRepository(connection.token,connection.repository,call);
 if(repo.id!==connection.repositoryId||repo.default_branch!==connection.branch)
  throw new Error('The repository or its default branch changed. Reconnect GitHub.');
}
export async function backUpPaper(connection,spaceId,paper,fetchPdf,call=github){
 if(!connection)throw new Error('Connect your private GitHub repository in Connections.');
 if(!/^[a-zA-Z0-9-]{1,64}$/.test(spaceId)||!Number.isSafeInteger(paper.fileId)||paper.fileId<0)
  throw new Error('Invalid paper identity.');
 await verifyTarget(connection,call);
 const data=await fetchPdf();
 if(data.byteLength>MAX_PDF_BYTES)throw new Error('GitHub backup supports PDFs up to 64 MB.');
 const bytes=new Uint8Array(data);
 if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('The downloaded paper is not a PDF.');
 const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 if(fingerprint!==paper.sha256)throw new Error('The PDF does not match this paper’s stored fingerprint.');
 let base64='';
 for(let offset=0;offset<bytes.length;offset+=24576)base64+=btoa(String.fromCharCode(...bytes.subarray(offset,offset+24576)));
 const {token,repository,branch}=connection,root=repositoryPath(repository);
 const folder='paper-library/'+spaceId+'/'+paper.fileId;
 const metadata={
  id:paper.fileId,title:paper.title,category:paper.category,date:paper.date,source:paper.source,
  method:paper.method,keywords:paper.keywords,sha256:paper.sha256,pdf:'paper.pdf'
 };
 await verifyTarget(connection,call);
 const blob=await call(token,root+'/git/blobs','POST',{content:base64,encoding:'base64'});
 const entries=[
  {path:folder+'/paper.pdf',mode:'100644',type:'blob',sha:blob.sha},
  {path:folder+'/metadata.json',mode:'100644',type:'blob',content:JSON.stringify(metadata,null,2)+'\n'}
 ];
 for(let attempt=0;attempt<3;attempt++){
  const tip=await call(token,root+'/git/ref/'+refPath(branch));
  const parent=await call(token,root+'/git/commits/'+tip.object.sha);
  const tree=await call(token,root+'/git/trees','POST',{base_tree:parent.tree.sha,tree:entries});
  const url='https://github.com/'+repository+'/tree/'+encodeURIComponent(branch)+'/'+folder;
  if(tree.sha===parent.tree.sha)return {url,unchanged:true};
  const commit=await call(token,root+'/git/commits','POST',{
   message:'Back up Paper Library item '+paper.fileId,tree:tree.sha,parents:[tip.object.sha]
  });
  await verifyTarget(connection,call);
  try{
   await call(token,root+'/git/refs/'+refPath(branch),'PATCH',{sha:commit.sha,force:false});
   return {url,unchanged:false};
  }catch(error){
   if(![409,422].includes(error.status)||attempt===2)throw error;
  }
 }
}

export const REPO='yak9ce3teeh/yak9ce3teeh.github.io';
export async function github(token,path,method='GET',body) {
  if(typeof token!=='string'||!/^[a-zA-Z0-9_]{20,256}$/.test(token))throw new Error('Connect GitHub in Settings first.');
  if(!(path==='/repos/'+REPO||path.startsWith('/repos/'+REPO+'/'))||path.includes('..'))throw new Error('Only the Paper Library repository is allowed.');
  const options={method,headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},credentials:'omit',redirect:'error',cache:'no-store'};
  if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  let response;try{response=await fetch('https://api.github.com'+path,{...options,signal:AbortSignal.timeout(20000)});}catch(e){throw new Error(e.name==='TimeoutError'||e.name==='AbortError'?'GitHub timed out. Check your network and retry.':'GitHub could not be reached. Check your network and browser permissions.');}
  if(response.status===404 && method==='GET')return null;
  let result=null;try{result=await response.json();}catch{}
  if(!response.ok){const e=new Error(response.status===401?'GitHub rejected the token. Reconnect in Settings.':result?.message||'GitHub request failed.');e.status=response.status;throw e;}
  return result;
}
export async function submitPublication(token,request,pdfBase64=null,call=github) {
  if(!/^[a-f0-9-]{36}$/i.test(request.requestId||''))throw new Error('Invalid publication request ID.');
  const root='/repos/'+REPO,folder='.paper-inbox/'+request.requestId;
  const prior=await call(token,root+'/contents/'+folder+'/request.json?ref=main');
  if(prior)return {queued:true,already:true,requestId:request.requestId};
  const payload={schemaVersion:1,...request};
  const entries=[];
  if(pdfBase64){const blob=await call(token,root+'/git/blobs','POST',{content:pdfBase64,encoding:'base64'});entries.push({path:folder+'/paper.pdf',mode:'100644',type:'blob',sha:blob.sha});payload.pdf='paper.pdf';}
  entries.push({path:folder+'/request.json',mode:'100644',type:'blob',content:JSON.stringify(payload,null,2)+'\n'});
  for(let attempt=0;attempt<3;attempt++) {
    const ref=await call(token,root+'/git/ref/heads/main');
    if(!ref)throw new Error('The Paper Library repository could not be read.');
    const parent=await call(token,root+'/git/commits/'+ref.object.sha);
    const tree=await call(token,root+'/git/trees','POST',{base_tree:parent.tree.sha,tree:entries});
    const commit=await call(token,root+'/git/commits','POST',{message:'Queue paper: '+String(request.metadata.title||'New paper').slice(0,160),tree:tree.sha,parents:[ref.object.sha]});
    try {await call(token,root+'/git/refs/heads/main','PATCH',{sha:commit.sha,force:false});return {queued:true,commit:commit.sha,requestId:request.requestId};}
    catch(e){if(![409,422].includes(e.status)||attempt===2)throw e;const done=await call(token,root+'/contents/'+folder+'/request.json?ref=main');if(done)return {queued:true,already:true,requestId:request.requestId};}
  }
}
export async function publicationResult(token,id) {
  const record=await github(token,'/repos/'+REPO+'/contents/.paper-results/'+encodeURIComponent(id)+'.json?ref=main');
  if(!record)return null;
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(record.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));
}

export async function verifyConnection(token,call=github){const root='/repos/'+REPO;const repo=await call(token,root);if(!repo)throw new Error('Repository unavailable. Grant this token access to '+REPO+'.');if(repo.permissions?.push!==true)throw new Error('This token has no push permission for the Paper Library repository.');const ref=await call(token,root+'/git/ref/heads/main');if(!ref?.object?.sha)throw new Error('The main branch could not be read.');return {repository:REPO,branch:'main'};}

export const REPO='yak9ce3teeh/yak9ce3teeh.github.io';
export const ZOTERO='http://127.0.0.1:23119';
export const PREFIX='/paper-library';
export const CONNECTION_KEY='plr.connection';
export const MAX_PDF=50*1024*1024;
export function connection(storage=localStorage,now=Date.now()) {
  try {const r=JSON.parse(storage.getItem(CONNECTION_KEY)||'null');if(!r||r.disconnected||r.url!==ZOTERO||!/^[a-zA-Z0-9_-]{32,4096}$/.test(r.token||'')||!Number.isFinite(r.createdAt)||!Number.isFinite(r.expiresAt)||r.createdAt>now||r.expiresAt<=now||r.expiresAt<=r.createdAt||r.expiresAt-r.createdAt>8*3600000)return null;return r;}catch{return null;}
}
export async function zotero(path,body,record=connection()) {
  if(!/^\/[a-zA-Z0-9_/-]+$/.test(path))throw new Error('Invalid Zotero operation.');
  if(!record && path!=='/status'&&path!=='/connect')throw new Error('Connect Zotero in Settings first. Your form has been kept.');
  const headers={};if(record)headers.Authorization='Bearer '+record.token;
  const options={method:body===undefined?'GET':'POST',headers,credentials:'omit',redirect:'error',cache:'no-store'};
  if(body!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  let response;
  try {response=await fetch(ZOTERO+PREFIX+path,options);}catch {throw new Error('Open Zotero with the Paper Library Web extension installed, then connect again.');}
  const value=await response.json();
  if(!response.ok)throw new Error(value.error?.message||'Zotero could not complete the request.');
  return value;
}
export function arxiv(source) {
  const m=source.trim().match(/^(?:arxiv\s*:\s*|https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(v\d+)?(?:\.pdf)?(?:[?#].*)?$/i);
  return m?m[1].toLowerCase():null;
}
export function duplicate(records,source) {const id=arxiv(source);return records.find(r=>id?r.arxiv_id===id:r.paper_url===source);}
export function bytesToBase64(bytes) {let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(raw);}
export async function fileBase64(file) {if(!file||file.size>MAX_PDF)throw new Error('Choose a PDF up to 50 MB.');const bytes=new Uint8Array(await file.arrayBuffer());if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('Choose a valid PDF file.');return bytesToBase64(bytes);}
export async function github(token,path,method='GET',body) {
  if(typeof token!=='string'||!/^[a-zA-Z0-9_]{20,256}$/.test(token))throw new Error('Connect GitHub in Settings first.');
  if(!(path==='/repos/'+REPO||path.startsWith('/repos/'+REPO+'/'))||path.includes('..'))throw new Error('Only the Paper Library repository is allowed.');
  const options={method,headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},credentials:'omit',redirect:'error',cache:'no-store'};
  if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const response=await fetch('https://api.github.com'+path,options);
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

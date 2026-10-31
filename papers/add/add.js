import {REPO,ZOTERO,CONNECTION_KEY,connection,zotero,duplicate,fileBase64,github,submitPublication,publicationResult} from './client.mjs';
const $=id=>document.getElementById(id);
const DRAFT='pl.add.form',ACTIVE='pl.add.active',GITHUB='pl.add.github';
let records=[],registry=[],extra={},working=false,watching=false;
function get(store,key){try{return JSON.parse(store.getItem(key)||'null');}catch{return null;}}
function put(store,key,value){try{store.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function remove(store,key){try{store.removeItem(key);}catch{}}
function gh(){const value=get(sessionStorage,GITHUB)||get(localStorage,GITHUB);if(value?.token && value.expiresAt>Date.now())return value;return null;}
function setResult(heading,text,error=false){$('result').hidden=false;$('result').classList.toggle('error',error);$('resultHeading').textContent=heading;$('resultText').textContent=text;$('resultLinks').replaceChildren();}
function link(label,href){const a=document.createElement('a');a.textContent=label;a.href=href;$('resultLinks').append(a);}
function settings(){if(!$('settings').open)$('settings').showModal();}
function summaries(){const z=connection(),g=gh();$('zoteroSummary').textContent='Zotero: '+(z?'connected':'not connected');$('githubSummary').textContent='GitHub: '+(g?'connected':'not connected');$('connectionStatus').textContent=(z?'Zotero connected':'Connect Zotero for local synchronization')+' · '+(g?'GitHub publishing ready':'Connect GitHub to publish');}
function fields(){return {title:$('title').value.trim(),date:$('date').value.trim(),category:$('category').value.trim(),method:$('method').value.trim(),keywords:$('keywords').value.split(',').map(s=>s.trim()).filter(Boolean),source:document.querySelector('[name=mode]:checked').value==='link'?$('source').value.trim():'',authors:extra.authors||[],abstract:extra.abstract||'',doi:extra.doi||''};}
function saveDraft(){put(localStorage,DRAFT,{...fields(),keywords:$('keywords').value,mode:document.querySelector('[name=mode]:checked').value,sync:$('syncZotero').checked,publish:$('publish').checked});}
function mode(){const file=document.querySelector('[name=mode]:checked').value==='file';$('fileFields').hidden=!file;$('linkFields').hidden=file;}
function already(item){setResult('Already in your library',item.title+' is already saved. Its existing record has been kept.');link('Read paper','../reader/?id='+item.file_id);const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Sync existing paper to Zotero';button.addEventListener('click',()=>syncExisting(item));$('resultLinks').append(button);link('Back to library','../');}
async function syncExisting(item){
  if(working)return;
  if(!connection()){settings();$('zoteroStatus').textContent='Connect Zotero to synchronize this existing paper.';return;}
  working=true;
  try{
    setResult('Syncing existing paper','Saving its existing published PDF to Zotero…');
    const url=new URL('../'+item.dest.replace(/\\/g,'/'),location.href);
    if(url.origin!==location.origin||!url.pathname.startsWith('/papers/'))throw new Error('Invalid catalog PDF link.');
    const response=await fetch(url);if(!response.ok)throw new Error('The published PDF could not be read.');
    const bytes=await response.blob(),file=new File([bytes],'paper.pdf',{type:'application/pdf'}),pdf=await fileBase64(file);
    const row=registry.find(p=>p.fileId===item.file_id);
    const meta={title:item.title,date:item.publication_date,category:row?.category||$('category').value,source:item.paper_url||'',method:'',keywords:item.keywords||[],authors:item.authors||[]};
    const requestId=crypto.randomUUID();
    const result=await zotero('/import',{requestId,serverId:connection().serverId,metadata:meta,pdfBase64:pdf});
    if(gh() && $('publish').checked && meta.source){
      const z={parentKey:result.parentKey,attachmentKey:result.attachmentKey,pdfSha256:result.pdfSha256};
      setResult('Linking existing paper','Publishing the verified Zotero association to its existing record…');
      await submitPublication(gh().token,{requestId,metadata:meta,zotero:z},pdf);
      const active={id:requestId,title:meta.title,zotero:true,attachmentKey:z.attachmentKey,at:Date.now()};put(localStorage,ACTIVE,active);await watchPublication(active);
    }else {setResult('Saved in Zotero',item.title+' uses its existing library record. Connect GitHub and select website publishing to share the association with the web reader.');link('Open in Zotero','zotero://select/library/items/'+result.parentKey);link('Read paper','../reader/?id='+item.file_id);}
  }catch(e){setResult('Could not sync to Zotero',e.message,true);}finally{working=false;}
}
function validate(meta,file){
  if(!meta.title||!/^\d{4}-\d{2}(?:-\d{2})?$/.test(meta.date)||!meta.category.includes('/'))throw new Error('Review the title, publication month and Area/Topic category.');
  if(!meta.source&&!file)throw new Error('Enter a paper link or choose a PDF.');
  if(meta.source&&!/^(?:\d{4}\.\d{4,5}(?:v\d+)?|arxiv\s*:|https:\/\/)/i.test(meta.source))throw new Error('Use an arXiv ID or a public HTTPS paper URL.');
  if(meta.source.startsWith('https://')){const u=new URL(meta.source);if(u.username||u.password)throw new Error('Paper links must not contain account credentials.');}
}
async function inspect(){
  const source=$('source').value.trim();if(!source){$('metadataStatus').textContent='Enter a paper link first.';return;}
  const exists=duplicate(records,source);if(exists){already(exists);return;}
  if(!connection()){settings();$('zoteroStatus').textContent='Connect Zotero to fetch paper details through the extension.';return;}
  $('fetchDetails').disabled=true;$('metadataStatus').textContent='Fetching paper details…';
  try{extra=await zotero('/inspect',{source});if(extra.manual){$('metadataStatus').textContent='Enter the title and publication date for this PDF.';return;}
    $('source').value=extra.source;$('title').value=extra.title;$('date').value=extra.date;$('metadataStatus').textContent='Details ready. Review the category and keywords.';saveDraft();
  }catch(e){$('metadataStatus').textContent=e.message;}finally{$('fetchDetails').disabled=false;}
}
async function watchPublication(active){
  if(watching)return;watching=true;
  try{
    for(let i=0;i<150;i++){
      const auth=gh();if(!auth){setResult('Publication request kept','Reconnect GitHub in Settings to check its progress.');return;}
      const result=await publicationResult(auth.token,active.id);
      if(result?.status==='error'){remove(localStorage,ACTIVE);setResult('Could not publish',result.message||'Check the publication run and retry.',true);link('View GitHub Actions','https://github.com/'+REPO+'/actions');return;}
      if(result?.fileId!==undefined){
        setResult(result.status==='already_exists'?'Already in your library':'Publishing website',result.status==='already_exists'?'The existing paper record has been kept.':'The paper has been processed. Waiting for the website update…');
        const response=await fetch('../reader/data/'+result.fileId+'.json?v='+encodeURIComponent(active.id),{cache:'no-store'});
        if(response.ok){const snapshot=await response.json();if(snapshot.fileId===result.fileId&&(!active.attachmentKey||snapshot.zotero?.attachmentKey===active.attachmentKey)){
          remove(localStorage,ACTIVE);setResult(result.status==='already_exists'?'Already in your library':'Paper published',result.title+(active.zotero?' · Saved in local Zotero.':''));link('Read paper','../reader/?id='+result.fileId);link('View library','../?v='+active.id);return;
        }}
      }
      await new Promise(resolve=>setTimeout(resolve,4000));
    }
    setResult('Publication is still running','Your request is saved. Return to this page to check again.');link('View GitHub Actions','https://github.com/'+REPO+'/actions');
  }catch(e){setResult('Publication request kept',e.message,true);link('View GitHub Actions','https://github.com/'+REPO+'/actions');}
  finally{watching=false;}
}
async function submit(event){
  event.preventDefault();if(working)return;
  const meta=fields(),file=document.querySelector('[name=mode]:checked').value==='file'?$('pdf').files[0]:null;
  try{validate(meta,file);}catch(e){setResult('Review paper details',e.message,true);return;}
  const exists=meta.source&&duplicate(records,meta.source);if(exists){already(exists);return;}
  const toZotero=$('syncZotero').checked,toWebsite=$('publish').checked;
  if(!toZotero&&!toWebsite){setResult('Choose where to save','Select Zotero, website publishing, or both.',true);return;}
  if((toZotero&&!connection())||(toWebsite&&!gh())){settings();$('githubStatus').textContent=toWebsite&&!gh()?'Connect GitHub before publishing. Your form has been kept.':'';$('zoteroStatus').textContent=toZotero&&!connection()?'Connect Zotero before synchronization. Your form has been kept.':'';return;}
  working=true;$('submitPaper').disabled=true;$('fetchDetails').disabled=true;
  const requestId=crypto.randomUUID();let pdf=null,z=null,active=null;
  try{
    saveDraft();setResult('Adding paper','Preparing the PDF…');
    if(file)pdf=await fileBase64(file);
    if(toZotero){
      const c=connection();setResult('Saving to Zotero','Saving the paper and verifying its PDF…');
      const result=await zotero('/import',{requestId,serverId:c.serverId,metadata:meta,pdfBase64:pdf});
      z={parentKey:result.parentKey,attachmentKey:result.attachmentKey,pdfSha256:result.pdfSha256};
      if(toWebsite&&!pdf){setResult('Preparing publication','Reading the verified PDF from Zotero…');const exported=await zotero('/file',{serverId:c.serverId,parentKey:z.parentKey,attachmentKey:z.attachmentKey});if(exported.sha256!==z.pdfSha256)throw new Error('Zotero PDF changed before publication. Retry with the current PDF.');pdf=exported.pdfBase64;}
    }
    if(toWebsite){
      setResult('Uploading paper','Uploading this publication request to your GitHub repository…');
      active={id:requestId,title:meta.title,zotero:!!z,attachmentKey:z?.attachmentKey||null,at:Date.now()};
      await submitPublication(gh().token,{requestId,metadata:meta,zotero:z},pdf);
      put(localStorage,ACTIVE,active);
      setResult('Publishing paper','GitHub is adding this paper and updating your website. You can leave this page and return later.');
      await watchPublication(active);
    }else {setResult('Saved in Zotero',meta.title+' and its PDF are available in your local Zotero library.');link('Open in Zotero','zotero://select/library/items/'+z.parentKey);}
  }catch(e){setResult('Could not finish',e.message+(z?' The paper is already saved in Zotero. Retrying will reuse its matching PDF.':''),true);}
  finally{working=false;$('submitPaper').disabled=false;$('fetchDetails').disabled=false;}
}
$('settingsButton').addEventListener('click',settings);$('openConnections').addEventListener('click',settings);$('closeSettings').addEventListener('click',()=>$('settings').close());
$('connectZotero').addEventListener('click',async()=>{
  $('connectZotero').disabled=true;$('zoteroStatus').textContent='Connecting… Check Zotero for its authorization request.';
  try {const record=await zotero('/connect',{authorizeZotero:true});if(record.url!==ZOTERO||!record.token||!record.serverId)throw new Error('Unexpected Zotero connection response.');if(!put(localStorage,CONNECTION_KEY,record))throw new Error('Allow browser storage to share this connection with the reader.');$('zoteroStatus').textContent='Zotero and DeepSeek share this connection across all papers. You can close Settings.';summaries();}
  catch(e){$('zoteroStatus').textContent=e.message;}finally{$('connectZotero').disabled=false;}
});
$('disconnectZotero').addEventListener('click',()=>{put(localStorage,CONNECTION_KEY,{disconnected:true,at:Date.now()});$('zoteroStatus').textContent='Zotero disconnected on this site.';summaries();});
$('connectGithub').addEventListener('click',async()=>{
  $('connectGithub').disabled=true;$('githubStatus').textContent='Checking repository access…';
  try{const token=$('githubToken').value.trim();const repo=await github(token,'/repos/'+REPO);if(!repo||repo.full_name.toLowerCase()!==REPO.toLowerCase())throw new Error('The token cannot access this repository.');
    const persist=$('rememberGithub').checked,record={token,expiresAt:Date.now()+(persist?30*24:8)*3600000};
    if(!put(persist?localStorage:sessionStorage,GITHUB,record))throw new Error('Browser storage is unavailable.');remove(persist?sessionStorage:localStorage,GITHUB);$('githubToken').value='';$('githubStatus').textContent='GitHub connected. Publishing is ready.';summaries();const active=get(localStorage,ACTIVE);if(active&&!watching)watchPublication(active);
  }catch(e){$('githubStatus').textContent=e.message;}finally{$('connectGithub').disabled=false;}
});
$('disconnectGithub').addEventListener('click',()=>{remove(localStorage,GITHUB);remove(sessionStorage,GITHUB);$('githubToken').value='';$('githubStatus').textContent='GitHub disconnected.';summaries();});
$('source').addEventListener('input',()=>{extra={};});document.querySelectorAll('[name=mode]').forEach(r=>r.addEventListener('change',()=>{extra={};}));
$('fetchDetails').addEventListener('click',inspect);$('paperForm').addEventListener('submit',submit);$('paperForm').addEventListener('input',saveDraft);$('paperForm').addEventListener('change',()=>{mode();saveDraft();});
window.addEventListener('storage',event=>{if([CONNECTION_KEY,GITHUB,null].includes(event.key))summaries();});
async function init(){
  const draft=get(localStorage,DRAFT);if(draft){for(const key of ['source','title','date','category','method','keywords'])if(typeof draft[key]==='string')$(key).value=draft[key];if(draft.mode==='file')document.querySelector('[name=mode][value=file]').checked=true;if(typeof draft.sync==='boolean')$('syncZotero').checked=draft.sync;if(typeof draft.publish==='boolean')$('publish').checked=draft.publish;extra={authors:draft.authors||[],abstract:draft.abstract||'',doi:draft.doi||''};}
  mode();summaries();
  try {const [a,b]=await Promise.all([fetch('../paper-metadata.json',{cache:'no-cache'}),fetch('../reader/papers.json',{cache:'no-cache'})]);if(a.ok)records=(await a.json()).records||[];if(b.ok){registry=(await b.json()).papers||[];const categories=[...new Set(registry.map(p=>p.category))].sort();for(const value of categories){const option=document.createElement('option');option.value=value;$('categories').append(option);}}}catch{$('metadataStatus').textContent='Catalog could not be refreshed. You can enter paper details manually.';}
  if(location.hash==='#connections')settings();
  const active=get(localStorage,ACTIVE);if(active&&gh()){setResult('Checking publication','Loading your last publication request…');watchPublication(active);}
}
init();

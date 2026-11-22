'use client';
import {useEffect,useState,useRef,type ReactNode} from 'react';
import {suggestKeywords,mergeKeywordVocabulary,keywordKey} from './public/keywords.mjs';
import baselineKeywords from './public/keyword-vocabulary.json';
import {api,serviceFetch,openPdf,readerUrl,nativeZoteroAvailable} from './service';
import CategoryPicker from './category-picker';
import KeywordEditor from './keyword-editor';
import Catalogue from './catalogue';
import ReadingDialog from './reading-dialog';
import {materialType} from './material-types.mjs';
import {backUpPaper,connectGithub} from './github-backup.mjs';
const loadBrowser=(name:string)=>import(/* @vite-ignore */ '/papers/add'+name);
const empty={source:'',title:'',date:'',category:'',method:'',keywords:'',authors:[] as string[],abstract:''};
async function fileDraft(draftKey:string,value?:File){return new Promise<File|undefined>((resolve)=>{const request=indexedDB.open('pl-cloud-upload',1);request.onupgradeneeded=()=>request.result.createObjectStore('draft');request.onerror=()=>resolve(undefined);request.onsuccess=()=>{const db=request.result,tx=db.transaction('draft',value?'readwrite':'readonly'),store=tx.objectStore('draft');const r=value?store.put(value,draftKey):store.get(draftKey);r.onsuccess=()=>{resolve(value||r.result);db.close();};r.onerror=()=>resolve(undefined);};});}
export default function Library({accountId,admin,accountControls,githubConnection,setGithubConnection,owner,categories,onConnect,destination,destinationName,destinationId,onBusy,settingsOpen,onSettingsChange,settingsView,onSettingsViewChange,connectionSettings,usage}:{accountId:string;admin:boolean;accountControls:ReactNode;githubConnection:any;setGithubConnection:(connection:any)=>void;owner:boolean;categories:string[];onConnect:(view?:string)=>void;destination:ReactNode;destinationName:string;destinationId:string;onBusy:(busy:boolean)=>void;settingsOpen:boolean;onSettingsChange:(open:boolean)=>void;settingsView:string;onSettingsViewChange:(view:string)=>void;connectionSettings:ReactNode;usage:ReactNode}){
 const draftKey='pl.cloud.form.'+accountId+'.'+(destinationId||'unassigned');
 const [connectionNotice,setConnectionNotice]=useState(''),[connecting,setConnecting]=useState('');
 const epoch=useRef(0),catalogJob=useRef(0),settingsDialog=useRef<HTMLDialogElement>(null),usageDialog=useRef<HTMLDialogElement>(null);
 const [addOpen,setAddOpen]=useState(false),addDialog=useRef<HTMLDialogElement>(null);
 const [readingsOpen,setReadingsOpen]=useState(false);
 const [githubRepository,setGithubRepository]=useState(''),[githubToken,setGithubToken]=useState('');
 const [githubNotice,setGithubNotice]=useState(''),[zoteroReady,setZoteroReady]=useState(false);
 const [catalogState,setCatalogState]=useState('loading');
 const [usageOpen,setUsageOpen]=useState(false);
 useEffect(()=>{
  const dialog=addDialog.current;
  if(addOpen&&!dialog?.open)dialog?.showModal();
  else if(!addOpen&&dialog?.open)dialog.close();
 },[addOpen]);
 useEffect(()=>{const dialog=settingsDialog.current;if(settingsOpen&&!dialog?.open)dialog?.showModal();else if(!settingsOpen&&dialog?.open)dialog.close();},[settingsOpen]);
 useEffect(()=>{const dialog=usageDialog.current;if(usageOpen&&!dialog?.open)dialog?.showModal();else if(!usageOpen&&dialog?.open)dialog.close();},[usageOpen]);
 const openAccess=()=>onConnect('access');
 const [vocabulary,setVocabulary]=useState<string[]>(baselineKeywords);
 const [form,setForm]=useState(empty),[mode,setMode]=useState('link'),[file,setFile]=useState<File>(),[papers,setPapers]=useState<any[]>([]),[busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[aiNotice,setAiNotice]=useState(''),[classifying,setClassifying]=useState(false),[saved,setSaved]=useState<any>(),[syncNotice,setSyncNotice]=useState(''),[backupUrl,setBackupUrl]=useState('');
 useEffect(()=>{onBusy(!!busy||classifying||!!connecting);return ()=>onBusy(false);},[busy,classifying,connecting,onBusy]);
 useEffect(()=>{try{const draft=JSON.parse(localStorage.getItem(draftKey)||'null');if(draft){setForm({...empty,...draft.form});setMode(draft.mode||'link');if(draft.mode==='file')fileDraft(draftKey).then(setFile);}}catch{}},[]);
 useEffect(()=>{epoch.current++;setSaved(undefined);setPapers([]);setVocabulary(baselineKeywords);setNotice('');setSyncNotice('');setAiNotice('');if(destinationId)refresh();else catalogJob.current++;},[destinationId]);
 useEffect(()=>{if(form.title||form.source)localStorage.setItem(draftKey,JSON.stringify({form,mode}));},[form,mode]);
 async function refresh(){
  const job=++catalogJob.current;
  setCatalogState('loading');
  try{
   const result=await api('/api/papers');
   if(job!==catalogJob.current)return;
   setPapers(result.papers);
   setVocabulary(mergeKeywordVocabulary(result.keywordVocabulary||[]));
   setCatalogState('ready');
  }catch{
   if(job===catalogJob.current)setCatalogState('error');
  }
 }
 const update=(key:string,value:string)=>{epoch.current++;setForm(prev=>key==='source'?{...empty,source:value}:{...prev,[key]:value});};
 async function inspect(source=form.source,existingJob?:number){const job=existingJob??++epoch.current;setBusy('metadata');setNotice('Fetching paper details…');try{const v=await api('/api/metadata?source='+encodeURIComponent(source));if(job!==epoch.current)return;const {keywordVocabulary:responseVocabulary,...details}=v;setVocabulary(prev=>mergeKeywordVocabulary(prev,responseVocabulary||[]));setForm(prev=>({...prev,...details,category:v.suggestion.category,keywords:suggestKeywords(v,mergeKeywordVocabulary(vocabulary,v.keywordVocabulary||[])).join(', ')}));setNotice('Details loaded with English keywords. Review the category and keywords, then Add to cloud.');}catch(e){if(job===epoch.current)setNotice((e as Error).message);}finally{if(job===epoch.current)setBusy('');}}
 async function upload(value?:File){if(!value)return;const job=++epoch.current;setForm({...empty});setFile(undefined);setSaved(undefined);setMode('file');if(value.size>25*1024*1024){setNotice('Choose a PDF up to 25 MB.');return;}setFile(value);setBusy('metadata');setNotice('Reading PDF details…');await fileDraft(draftKey,value);try{const pdfjs=await loadBrowser('/pdfjs/legacy/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/papers/add/pdfjs/legacy/pdf.worker.mjs?v=20261104-pdf-compat-1';const task=pdfjs.getDocument({data:await value.arrayBuffer(),isEvalSupported:false});const doc=await task.promise;let text='';for(let p=1;p<=Math.min(doc.numPages,2);p++){const page=await doc.getPage(p);text+=(await page.getTextContent()).items.map((i:any)=>i.str||'').join('\n')+'\n';}await task.destroy();if(job!==epoch.current)return;const id=text.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i)?.[1];if(id){setForm({...empty,source:'https://arxiv.org/abs/'+id});await inspect(id,job);}else{const details={title:text.split('\n').find(x=>x.trim().length>12)?.slice(0,500)||'',abstract:text.slice(0,8000)};setForm({...empty,...details,keywords:suggestKeywords(details,vocabulary).join(', ')});setNotice('Text extracted. Review the title and enter its date. English keywords were extracted; free AI suggestions are optional.');}}catch{if(job===epoch.current)setNotice('PDF selected. Enter its title and date manually; saving remains available.');}finally{if(job===epoch.current)setBusy('');}}
 async function classify(){const job=epoch.current;setClassifying(true);setAiNotice('Loading free classification…');try{const m=await loadBrowser('/classification.mjs?v=20261104-tags-2');const v=await m.classify(form,categories,(message:string)=>{if(epoch.current===job)setAiNotice(message);},vocabulary);if(epoch.current!==job){setAiNotice('Details changed. Request a fresh classification if needed.');return;}setForm(prev=>({...prev,category:v.category,keywords:v.keywords?.length?v.keywords.join(', '):prev.keywords}));setAiNotice(v.basis);}catch(e){setAiNotice((e as Error).message);}finally{setClassifying(false);}}
 async function save(e:React.FormEvent){e.preventDefault();epoch.current++;setSaved(undefined);if(!owner){setNotice('Choose an account storage space to save. Your draft is kept.');return;}setBusy('save');setNotice(`Saving the paper and its PDF to ${destinationName}…`);try{const data=new FormData();data.set('metadata',JSON.stringify({...form,source:mode==='link'?form.source:form.source||'',keywords:form.keywords.split(',').map(s=>s.trim()).filter(Boolean)}));if(mode==='file'){if(!file)throw new Error('Choose a PDF first.');data.set('pdf',file);}const v=await api('/api/papers',{method:'POST',body:data});setSaved(v.paper);window.dispatchEvent(new Event('papers-space-updated'));setNotice(v.already?'Already in the cloud library. The existing record was kept.':`Saved to ${destinationName}. Log in on your other devices to read it.`);await refresh();}catch(e){setNotice((e as Error).message);}finally{setBusy('');}}
 const keywordsSaved=(paper:any)=>{setVocabulary(prev=>mergeKeywordVocabulary(prev,paper.keywords||[]));setPapers(prev=>prev.map(p=>p.fileId===paper.fileId?paper:p));setSaved((prev:any)=>prev?.fileId===paper.fileId?paper:prev);};
 async function native(){return loadBrowser('/integrations/zotero.mjs');}
 useEffect(()=>{
  if(!admin||!settingsOpen||settingsView!=='integrations')return;
  let active=true;
  native().then(z=>{if(active)setZoteroReady(!!z.connection());}).catch(()=>{if(active)setZoteroReady(false);});
  return ()=>{active=false;};
 },[admin,settingsOpen,settingsView]);
 async function connectZotero(){
  setConnecting('zotero');setConnectionNotice('Connecting to Zotero. Check its authorization prompt…');
  try{
   const z=await native(),r=await z.zotero('/connect',{authorizeZotero:true});
   if(!z.connection({getItem:()=>JSON.stringify(r)})||!r.serverId)throw new Error('Invalid Zotero connection response.');
   localStorage.setItem(z.CONNECTION_KEY,JSON.stringify(r));
   setZoteroReady(true);setConnectionNotice('Zotero connected in this browser.');
  }catch(error){setConnectionNotice((error as Error).message);}
  finally{setConnecting('');}
 }
 async function disconnectZotero(){
  try{
   const z=await native();
   localStorage.setItem(z.CONNECTION_KEY,JSON.stringify({disconnected:true,at:Date.now()}));
   setZoteroReady(false);setConnectionNotice('Zotero disconnected in this browser.');
  }catch(error){setConnectionNotice((error as Error).message);}
 }
 async function connectPrivateGithub(event:React.FormEvent){
  event.preventDefault();
  setConnecting('github');setGithubNotice('Checking private repository access…');
  try{
   setGithubConnection(await connectGithub(githubToken.trim(),githubRepository));
   setGithubToken('');setGithubNotice('Private repository connected for this sign-in.');
  }catch(error){setGithubNotice((error as Error).message);}
  finally{setConnecting('');}
 }
 async function backup(paper:any){
  setSyncNotice('');setBackupUrl('');
  if(!githubConnection){onConnect('integrations');return;}
  if(!window.confirm('Back up this PDF and its details to '+githubConnection.repository+'?'))return;
  setBusy('github');setSyncNotice('Backing up to '+githubConnection.repository+'…');
  try{
   const result=await backUpPaper(githubConnection,destinationId,paper,async()=>{
    const response=await serviceFetch(paper.pdfUrl);
    if(!response.ok)throw new Error('Cloud PDF unavailable.');
    return response.arrayBuffer();
   });
   setSyncNotice(result.unchanged?'This paper is already backed up.':'GitHub backup complete.');
   setBackupUrl(result.url);
  }catch(error){setSyncNotice((error as Error).message);}
  finally{setBusy('');}
 }
 async function download(p:any){
  setBusy('download');setSyncNotice('');setBackupUrl('');
  try{await openPdf(p.pdfUrl);}catch(error){setSyncNotice((error as Error).message);}finally{setBusy('');}
 }
 async function pdf64(p:any){const r=await serviceFetch(p.pdfUrl);if(!r.ok)throw new Error('Cloud PDF unavailable.');const bytes=new Uint8Array(await r.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
 async function syncZotero(p:any){if(p.archived&&nativeZoteroAvailable()){location.href=readerUrl(p.fileId);return;}if(!nativeZoteroAvailable()){setSyncNotice('The installed Zotero extension supports the original cloud space only. Your paper and private drafts remain available in this space.');return;}setSaved(p);setBusy('zotero');try{const z=await native(),c=z.connection();if(!c)throw new Error('Use Connections → Connect Zotero. Your cloud paper is already saved.');const r=await z.zotero('/import',{requestId:crypto.randomUUID(),serverId:c.serverId,metadata:p,pdfBase64:await pdf64(p)});await api('/api/papers/'+p.fileId+'/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...r,serverId:c.serverId})});setSyncNotice('Synced to Zotero. The reader can now synchronize notes and annotations.');await refresh();}catch(e){setSyncNotice((e as Error).message);}finally{setBusy('');}}
 function paperActions(paper:any){
  return <details className="paper-actions">
   <summary>Manage</summary>
   {paper.format!=='text'&&<button type="button" disabled={!!busy} onClick={()=>download(paper)}>Download PDF</button>}
   <KeywordEditor paper={paper} vocabulary={vocabulary} onSaved={keywordsSaved}/>
   {admin&&materialType(paper)==='paper'&&<>
    <button type="button" disabled={!!busy||!nativeZoteroAvailable()} onClick={()=>syncZotero(paper)}>{paper.archived?'Open reader to sync':'Sync to Zotero'}</button>
    <button type="button" disabled={!!busy} onClick={()=>backup(paper)}>Back up to GitHub</button>
   </>}
  </details>;
 }
 return <main className="cloud-shell">
  <header className="site-header"><a href="/">← Home</a><span>WE VIBE THE VIBES</span><div className="header-tools">{accountControls}</div></header>
  <div className="page-heading"><p className="eyebrow">LIBRARY TOOLS</p><h1>My Library</h1><p>Papers and readings in your selected private space.</p></div>
  <div className="library-layout">
   <div className="library-results">
    {destinationId?<Catalogue papers={papers} state={catalogState} retry={refresh} actions={paperActions}/>
     :<section className="empty-state"><h2>Choose a cloud space</h2><p>Materials from your selected space will appear here.</p></section>}
   </div>
   <aside className="library-sidebar" aria-label="Library tools">
    <div className="library-sidebar-actions">
     <button type="button" className="primary" disabled={!destinationId} aria-haspopup="dialog" onClick={()=>setAddOpen(true)}>＋ Add paper</button>
     <button type="button" disabled={!destinationId||!!busy} aria-haspopup="dialog" onClick={()=>setReadingsOpen(true)}>＋ Add readings</button>
     {admin&&<button type="button" aria-haspopup="dialog" onClick={()=>onConnect('integrations')}>Connections</button>}
     <button type="button" aria-haspopup="dialog" onClick={()=>setUsageOpen(true)}>Storage &amp; usage</button>
     <button type="button" aria-haspopup="dialog" onClick={openAccess}>Space &amp; account settings</button>
    </div>
    {destination}
    {!addOpen&&syncNotice&&<p className="form-status" role="status">{syncNotice} {backupUrl&&<a href={backupUrl} target="_blank" rel="noopener noreferrer">View backup ↗</a>}</p>}
   </aside>
  </div>
  <ReadingDialog open={readingsOpen} close={()=>setReadingsOpen(false)} onBusy={active=>setBusy(active?'reading':'')} onSaved={refresh} categories={categories} spaceName={destinationName}/>
  <dialog className="settings-dialog add-paper-dialog" ref={addDialog} aria-labelledby="add-paper-title" onCancel={event=>{if(busy||classifying)event.preventDefault();else setAddOpen(false);}} onClose={()=>setAddOpen(false)}>
   <div className="dialog-heading"><div><h2 id="add-paper-title">Add paper</h2><p>{destinationName}</p></div><button type="button" className="dialog-close" aria-label="Close add paper" disabled={!!busy||classifying} onClick={()=>setAddOpen(false)}>×</button></div>
   <div className="dialog-content">
    <form className="paper-form" id="add-paper" onSubmit={save}>
     <section className="form-section source-section"><div className="step-heading"><span className="step-number">01</span><h3>Paper source</h3></div>
      <div className="source-switch" role="group" aria-label="Paper source"><label className={mode==='link'?'selected':''}><input disabled={!!busy} type="radio" name="paper-source" checked={mode==='link'} onChange={()=>setMode('link')}/>arXiv link or ID</label><label className={mode==='file'?'selected':''}><input disabled={!!busy} type="radio" name="paper-source" checked={mode==='file'} onChange={()=>setMode('file')}/>Upload PDF</label></div>
      {mode==='link'?<label>arXiv ID or link<div className="source-entry"><input disabled={!!busy} placeholder="2610.23127 or https://arxiv.org/abs/…" value={form.source} onChange={e=>update('source',e.target.value)}/><button type="button" className="fetch-button" disabled={!!busy||!owner||!form.source.trim()} onClick={()=>inspect()}>{busy==='metadata'?'Fetching…':'Fetch details ↗'}</button></div><small>Paste a link or an ID in YYMM.XXXXX format.</small></label>:<label className="upload-zone"><span className="upload-symbol" aria-hidden="true">↑</span><strong>Choose a PDF</strong><span>Up to 25 MB · details extracted automatically</span><input disabled={!!busy} type="file" accept="application/pdf,.pdf" onChange={e=>upload(e.target.files?.[0])}/>{file&&<small className="selected-file">{file.name}</small>}</label>}
      {!saved&&notice&&(busy==='metadata'||!form.title)&&<p className="form-status" role="status" aria-live="polite">{notice}</p>}
     </section>
     <section className="form-section"><div className="step-heading"><span className="step-number">02</span><h2>Make it yours</h2><span className="step-caption">Review the details</span></div>
      <label>Title<input disabled={!!busy} required value={form.title} onChange={e=>update('title',e.target.value)} placeholder="Paper title"/></label>
      <div className="fields"><label>Publication date<input disabled={!!busy} required placeholder="YYYY-MM or YYYY-MM-DD" value={form.date} onChange={e=>update('date',e.target.value)}/></label><label>Method short name<input disabled={!!busy} value={form.method} onChange={e=>update('method',e.target.value)} placeholder="e.g. BeJEPA"/></label></div>
      <CategoryPicker categories={categories} value={form.category} disabled={!!busy} onChange={value=>update('category',value)}/>
      <label>Keywords<input disabled={!!busy} placeholder="Humanoid robotics, World models, …" value={form.keywords} onChange={e=>update('keywords',e.target.value)}/><small>Existing library tags are preferred. New proposals cover topics not represented yet. Separate keywords with commas.</small>{form.keywords&&<small>{(()=>{const known=new Set(vocabulary.map(keywordKey));const proposed=form.keywords.split(',').map(k=>k.trim()).filter(k=>k&&!known.has(keywordKey(k)));return proposed.length?'New proposals to review: '+proposed.join(', '):'All keywords reuse existing library tags.';})()}</small>}</label>
      <div className="ai-row"><button type="button" className="ai-button" disabled={!!busy||classifying||!form.title||!categories.length} onClick={classify}>{classifying?'Suggesting…':'✧ Suggest category & keywords'}<span>Free AI</span></button></div><p className="form-status" role="status">{aiNotice}</p>
      <details className="source-details"><summary>Abstract &amp; authors</summary><label>Abstract<textarea disabled={!!busy} value={form.abstract} onChange={e=>update('abstract',e.target.value)}/></label><p className="authors">{form.authors.join(', ')||'Authors will appear after fetching details.'}</p></details>
     </section>
     <div className="save-section"><div><span className="eyebrow">READY WHEN YOU ARE</span><p>The paper and PDF will be saved to your private cloud space.</p>{!owner&&<button type="button" className="text-button" aria-haspopup="dialog" onClick={openAccess}>Choose a space to save →</button>}</div><button className="primary save-button" disabled={!!busy||classifying||!owner||!categories.length} type="submit">{busy==='save'?'Saving…':'Add to cloud →'}</button></div>
     {notice&&(saved||form.title&&busy!=='metadata')&&<p className="form-status save-status" role="status" aria-live="polite">{notice}</p>}
    </form>
    {saved&&<section className="saved-result" aria-label="Saved paper">
     <h3>{saved.title}</h3>
     <div className="actions">
      <a className="primary" href={readerUrl(saved.fileId)}>Read paper →</a>
      {saved.format!=='text'&&<button type="button" disabled={!!busy} onClick={()=>download(saved)}>Download PDF</button>}
      {admin&&materialType(saved)==='paper'&&<>
       <button type="button" disabled={!!busy||!nativeZoteroAvailable()} onClick={()=>syncZotero(saved)}>{saved.archived?'Open reader to sync':'Sync to Zotero'}</button>
       <button type="button" disabled={!!busy} onClick={()=>{if(!githubConnection)setAddOpen(false);backup(saved);}}>Back up to GitHub</button>
      </>}
     </div>
    </section>}
    {addOpen&&syncNotice&&<p className="form-status" role="status">{syncNotice} {backupUrl&&<a href={backupUrl} target="_blank" rel="noopener noreferrer">View backup ↗</a>}</p>}
   </div>
  </dialog>
  <dialog className="settings-dialog" id="connections" ref={settingsDialog} aria-labelledby="settings-title" onCancel={()=>onSettingsChange(false)} onClose={()=>onSettingsChange(false)}>
   <div className="dialog-heading"><div><p className="eyebrow">YOUR LIBRARY</p><h2 id="settings-title">Library settings</h2></div><button type="button" className="dialog-close" aria-label="Close settings" onClick={()=>onSettingsChange(false)}>×</button></div>
   <div className="dialog-tabs" role="group" aria-label="Settings view"><button type="button" aria-pressed={settingsView==='access'} onClick={()=>onSettingsViewChange('access')}>Cloud spaces</button>{admin&&<button type="button" aria-pressed={settingsView==='integrations'} onClick={()=>onSettingsViewChange('integrations')}>Connections</button>}</div>
   <div className="dialog-content" hidden={settingsView!=='access'}>{connectionSettings}</div>
   {admin&&<div className="dialog-content" hidden={settingsView!=='integrations'}>
    <section className="settings-section integration-section">
     <h3>Zotero</h3><p className="helper">Connect the Paper Library Web extension to sync with your local Zotero library.</p>
     <div className="actions">
      <button disabled={!!connecting} onClick={connectZotero}>{connecting==='zotero'?'Connecting…':zoteroReady?'Reconnect Zotero':'Connect Zotero'}</button>
      {zoteroReady&&<button disabled={!!connecting} onClick={disconnectZotero}>Disconnect Zotero</button>}
      <a className="download-link" href="/papers/add/paper-library-web.xpi" download>Download Zotero extension ↗</a>
     </div>
     <p className="inline-notice" role="status">{connectionNotice|| (zoteroReady?'Zotero connection saved in this browser.':'')}</p>
    </section>
    <section className="settings-section integration-section">
     <h3>GitHub</h3><p className="helper">Back up a paper’s PDF and metadata to a private GitHub repository. Use a token limited to that repository with Contents read and write access.</p>
     {githubConnection?<div className="actions"><strong>{githubConnection.repository}</strong>
      <button type="button" disabled={!!busy} onClick={()=>{setGithubConnection(null);setGithubNotice('GitHub disconnected.');}}>Disconnect GitHub</button>
     </div>:<form onSubmit={connectPrivateGithub}>
      <label>Private repository<input required value={githubRepository} placeholder="owner/repository" onChange={e=>setGithubRepository(e.target.value)} disabled={!!connecting}/></label>
      <label>GitHub token<input required type="password" autoComplete="off" value={githubToken} onChange={e=>setGithubToken(e.target.value)} disabled={!!connecting}/></label>
      <button type="submit" disabled={!!connecting}>{connecting==='github'?'Connecting…':'Connect GitHub'}</button>
     </form>}
     {githubNotice&&<p className="inline-notice" role="status">{githubNotice}</p>}
    </section>
   </div>}
  </dialog>
  <dialog className="usage-dialog" ref={usageDialog} aria-labelledby="usage-title" onCancel={()=>setUsageOpen(false)} onClose={()=>setUsageOpen(false)}><div className="dialog-heading"><div><p className="eyebrow">YOUR CLOUD SPACE</p><h2 id="usage-title">Storage &amp; usage</h2></div><button type="button" className="dialog-close" aria-label="Close usage" onClick={()=>setUsageOpen(false)}>×</button></div><div className="dialog-content">{usageOpen&&usage}</div></dialog>
  <footer><span>Paper Library</span><p>Your papers and notes are private.</p></footer>
 </main>;
}

import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import DOMPurify from './assets/vendor/dompurify/purify.es.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./assets/vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;

const CMAP = new URL('./assets/vendor/pdfjs/cmaps/', import.meta.url).href;
const STDFONT = new URL('./assets/vendor/pdfjs/standard_fonts/', import.meta.url).href;
const WASM = new URL('./assets/vendor/pdfjs/wasm/', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const LS = (() => { try { const k='__pl_probe'; localStorage.setItem(k,'1'); localStorage.removeItem(k); return true; } catch { return false; } })();
const STATUS_KEY='plr.status', SETTINGS_KEY='plr.settings', TRANS_KEY='plr.translation', TOKEN_KEY='plr.token';
const paperKey = (id, suffix) => `plr.p${id}.${suffix}`;

function lsGet(key){ try { return LS ? localStorage.getItem(key) : null; } catch { return null; } }
function lsSet(key,val){ try { if(!LS) return false; localStorage.setItem(key,val); return true; } catch { return false; } }
function lsDel(key){ try { if(LS) localStorage.removeItem(key); } catch {} }

/* ---------------- IndexedDB with localStorage fallback ---------------- */
const DB_NAME='plr-reader', DB_STORE='state';
let dbPromise=null;
function openDb(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = ()=>{ const db=req.result; if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE); };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error||new Error('IndexedDB open failed'));
  });
  return dbPromise;
}
async function idbGet(key){
  try{ const db=await openDb(); return await new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readonly'); const r=tx.objectStore(DB_STORE).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
  catch{ return undefined; }
}
async function idbSet(key,val){
  const db=await openDb(); return await new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readwrite'); tx.objectStore(DB_STORE).put(val,key); tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); });
}
async function idbDel(key){
  const db=await openDb(); return await new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readwrite'); tx.objectStore(DB_STORE).delete(key); tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); });
}
async function storeGet(key){ const v=await idbGet(key); if(v!==undefined) return v; const raw=lsGet(key); if(raw==null) return undefined; try{return JSON.parse(raw);}catch{return undefined;} }
async function storeSet(key,val){ try{ await idbSet(key,val); return true; }catch{ if(lsSet(key, JSON.stringify(val))) return true; throw new Error('Browser storage is unavailable. Export your drafts before closing this page.'); } }

/* ---------------- State ---------------- */
const state = {
  fileId:null, paper:null, data:null, pdf:null, pages:[], curPage:1, numPages:0,
  scale:1.15, fitMode:'width', rotation:0, split:64, splitMin:20, splitMax:85,
  annotations:[], notes:[], pending:[], baselines:{}, tombstones:{}, keyMap:{},
  selectedAnno:null, selectedNote:null, activeNoteDraftId:null,
  tool:null, translateEnabled:false, translation:null,
  companion:{url:null, token:null, status:null, serverId:null, connected:false},
  syncState:'snapshot', dirty:false, saveTimer:null, snapRevision:null,
  renderGen:0, scrollObserver:null, lastSelection:null, editorDirty:false, conflicts:[]
};

/* ---------------- Utilities ---------------- */
function uuid(){ return (crypto.randomUUID && crypto.randomUUID()) || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0; const v=c==='x'?r:(r&0x3|0x8); return v.toString(16);}); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function clamp(v,a,b){ return Math.min(b,Math.max(a,v)); }
function debounce(fn,ms){ let t=null; const d=(...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; d.cancel=()=>clearTimeout(t); return d; }
function toast(msg,kind='',ms=4200){ const el=$('toast'); el.textContent=msg; el.className='toast '+kind; el.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>{ el.hidden=true; },ms); }
function setStatusMsg(msg){ $('statusMsg').textContent=msg||''; }
function setChip(id,stateVal,text){ const el=$(id); el.dataset.state=stateVal; el.textContent=text; }

const PURIFY_CONFIG = {
  ADD_ATTR:['data-schema-version','data-citation-items','data-citation','data-zotero-citation','data-annotation','data-annotation-id','data-note-key','data-item-key','data-parent-key','class','rel'],
  ADD_TAGS:['cite'],
  FORBID_TAGS:['script','style','iframe','object','embed','form','input','button','textarea','select'],
  FORBID_ATTR:['onerror','onclick','onload','onmouseover','onfocus','onfocusin','srcdoc','style'],
  ALLOW_DATA_ATTR:true,
  ALLOW_UNKNOWN_PROTOCOLS:false,
  ALLOWED_URI_REGEXP:/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|zotero:\/\/(?:open-pdf|select|note)\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  USE_PROFILES:{html:true},
};
function sanitizeHtml(html){ try{ return DOMPurify.sanitize(String(html||''), PURIFY_CONFIG); }catch{ return esc(html); } }

/* ---------------- Theme states ---------------- */
function renderStateChips(){
  const st = state.syncState;
  if(st==='draft') setChip('stateChip','draft','Local draft');
  else if(st==='synced') setChip('stateChip','synced','Synced with Zotero');
  else if(st==='error') setChip('stateChip','error','Sync error - drafts kept');
  else setChip('stateChip','snapshot','Published snapshot');
  const c = state.companion;
  const paperLinked=!!(state.data?.zotero?.parentKey||state.paper?.zotero?.parentKey);
  if(state.data && !paperLinked) setChip('zoteroChip','off','Zotero: paper not linked');
  else if(state.data?.mapping?.status==='unmatched') setChip('zoteroChip','warn','Zotero: PDF version not matched');
  else if(c.connected && c.status){
    const z=c.status.zotero||{};
    const label = z.writable ? `Zotero: connected${z.version?' '+z.version:''}` : (z.readable ? 'Zotero: read-only' : 'Zotero: not reachable');
    setChip('zoteroChip', z.writable?'ok':(z.readable?'warn':'off'), label);
  } else setChip('zoteroChip','off', 'Zotero: not connected');
  const t = c.status && c.status.translation;
  if(t) setChip('translationChip', t.available?'ok':'warn', t.available?`Translation: ${t.model||'available'}`:'Translation: unavailable');
  else setChip('translationChip','off','Translation: needs local companion');
  const translationHelp=translationSetupMessage();
  $('btnTranslate').disabled = !!translationHelp || !$('transSource').value.trim();
  $('btnTranslateSel').disabled = !selectedTranslationText();
  const translateAction=$('selPopup').querySelector('[data-act="translate"]'); if(translateAction) translateAction.hidden=false;
  $('transSetupStatus').textContent=translationHelp;
  $('btnTranslationSetup').hidden=!translationHelp;
  $('zoteroStatusDialog').textContent = c.serverMismatch?'Different Zotero library detected. Use Review new Zotero library; local drafts are retained.':(state.conflicts.length?`${state.conflicts.length} conflict(s) retained. Sync opens them for review.`:(c.connected ? (c.status?`Zotero reachable: ${!!(c.status.zotero||{}).reachable}; writable: ${!!(c.status.zotero||{}).writable}`:'Status unknown') : 'Not connected to local companion.'));
}

/* ---------------- Bootstrap ---------------- */
async function boot(){
  bindEvents();
  await consumeFragment();
  loadSettings();
  const params = new URLSearchParams(location.search);
  const idRaw = params.get('id');
  const id = idRaw!=null ? Number(idRaw) : NaN;
  if(!Number.isInteger(id) || id<0){ $('paperTitle').textContent='Choose a paper'; $('pdfLoading').hidden=true; $('pdfDirect').hidden=true; $('btnNewNote').disabled=true; showPdfError('Choose a paper from the library to start reading.'); return; }
  state.fileId=id;
  setStatusMsg('Loading paper data\u2026');
  await restoreSplit();
  renderStateChips();
  try{
    await loadPaper(id);
  }catch(e){ showPdfError('Could not load paper data: '+e.message); return; }
  await loadLocalState();
  renderStateChips();
  renderPanels();
  if(state.notes.length) selectNote(state.selectedNote && state.notes.some(n=>n.id===state.selectedNote) ? state.selectedNote : state.notes[0].id);
  else { showTab('notes'); refreshActiveEditor(); }
  await loadPdf();
  await maybeConnectFromToken();
  setStatusMsg(state.pending.length ? 'Local drafts retained' : 'Ready · published notes and annotations');
}

async function consumeFragment(){
  if(!location.hash) return;
  try{
    const frag = new URLSearchParams(location.hash.slice(1));
    const tok = frag.get('token');
    if(tok){
      try{ sessionStorage.setItem(TOKEN_KEY, tok); }catch{}
      history.replaceState(null,'',location.pathname+location.search);
    }
  }catch{}
}

function loadSettings(){
  try{ const s=JSON.parse(lsGet(SETTINGS_KEY)||'{}'); state.companion.url=s.url||null; }catch{}
  try{ state.companion.token = sessionStorage.getItem(TOKEN_KEY)||null; }catch{ state.companion.token=null; }
  if(state.companion.token) $('tokenInput').value=state.companion.token;
  if(state.companion.url) $('localUrlInput').value=state.companion.url;
  try{ const t=JSON.parse(lsGet(TRANS_KEY)||'{}'); state.translateEnabled=!!t.enabled; }catch{}
  $('chkTranslate').checked=state.translateEnabled;
}
function saveSettings(){ lsSet(SETTINGS_KEY, JSON.stringify({url:state.companion.url})); }
function saveToken(t){ try{ if(t) sessionStorage.setItem(TOKEN_KEY,t); else sessionStorage.removeItem(TOKEN_KEY); }catch{} state.companion.token=t||null; }

async function maybeConnectFromToken(){
  if(!state.companion.token) return;
  const url = state.companion.url || (['127.0.0.1','localhost'].includes(location.hostname) ? location.origin : 'http://127.0.0.1:23120');
  await connectCompanion(url, state.companion.token, true);
}

/* ---------------- Paper + snapshot ---------------- */
async function loadPaper(id){
  let idx=null;
  try{ const r=await fetch('./papers.json',{cache:'no-cache'}); if(!r.ok) throw new Error('papers.json HTTP '+r.status); idx=await r.json(); }catch(e){ idx=null; }
  let entry=null;
  if(idx && Array.isArray(idx.papers)) entry=idx.papers.find(p=>Number(p.fileId)===id)||null;
  if(entry){
    state.paper=entry;
    document.title=(entry.title||('Paper '+id))+' - Paper Library Reader';
    $('paperTitle').textContent=entry.title||('Paper '+id);
    const pdfUrl = entry.pdfUrl || `data/${id}.pdf`;
    const a=$('pdfDirect'); a.href=pdfUrl; a.setAttribute('download','');
    state.paper._pdfUrl=pdfUrl;
    if(entry.dataUrl){
      try{ const dr=await fetch(entry.dataUrl,{cache:'no-cache'}); if(dr.ok) state.data=await dr.json(); }catch(e){ setStatusMsg('Snapshot data unavailable: '+e.message); }
    }
  }else{
    // Fallback: try per-paper data, which includes pdf url
    try{ const dr=await fetch(`data/${id}.json`,{cache:'no-cache'}); if(dr.ok) state.data=await dr.json(); }catch{}
    if(!state.data){
      $('paperTitle').textContent='Paper not found'; document.title='Paper not found · Paper Library';
      $('pdfLoading').hidden=true; $('pdfDirect').hidden=true; $('btnNewNote').disabled=true;
      throw new Error('This paper is not in the library. Choose another paper using Library.');
    }
    const title=state.data && state.data.title || ('Paper '+id);
    document.title=title+' - Paper Library Reader';
    $('paperTitle').textContent=title;
    const pdfUrl=(state.data&&state.data.pdf&&state.data.pdf.url)||`data/${id}.pdf`;
    $('pdfDirect').href=pdfUrl;
    state.paper={fileId:id,title,pdfUrl};
    state.paper._pdfUrl=pdfUrl;
  }
  if(state.data){
    state.snapRevision=state.data.revision||null;
    state.annotations=(state.data.annotations||[]).map(normalizeAnno);
    state.notes=(state.data.notes||[]).map(normalizeNote);
    if(state.data.zotero && state.data.zotero.serverId) state.companion.serverId=state.data.zotero.serverId;
  }
  $('backLink').href='../index.html';
}

function normalizeAnno(a){
  const o = Object.assign({}, a);
  o.id = String(o.id||o.key||uuid());
  o.key = o.key||null;
  o.kind='annotation';
  o.type = (o.type||'highlight').toLowerCase();
  o.color = o.color || '#ffd400';
  o.comment = o.comment||'';
  o.text = o.text||o.quote||'';
  if(!o.position) o.position = {};
  if(o.position.pageIndex==null && o.pageIndex!=null) o.position.pageIndex=o.pageIndex;
  if(!Array.isArray(o.position.rects)) o.position.rects=[];
  o.local = !!a.local;
  if(!['highlight','underline','note'].includes(o.type)) o.readOnly=true;
  return o;
}
function normalizeNote(n){
  const o=Object.assign({},n);
  o.id=String(o.id||o.key||uuid());
  o.key=o.key||null;
  o.kind='note';
  o.html = o.html!=null ? o.html : (o.note||o.content||'');
  o.local=!!n.local;
  return o;
}

/* ---------------- Local persistence ---------------- */
function defaultLocal(){ return {pending:[],baselines:{},tombstones:{},keyMap:{},drafts:{},notes:{},created:{},serverId:state.companion.serverId||null, updatedAt:null}; }
async function loadLocalState(){
  const key=paperKey(state.fileId,'state');
  let s = await storeGet(key);
  if(!s || typeof s!=='object') s=null;
  if(!s){
    // also attempt legacy localStorage json
    try{ const raw=lsGet(key); if(raw) s=JSON.parse(raw); }catch{}
  }
  const d = Object.assign(defaultLocal(), s||{});
  state.pending = Array.isArray(d.pending)?d.pending:[];
  state.selectedNote=d.selectedNote||null;
  state.baselines = d.baselines||{};
  state.tombstones = d.tombstones||{};
  state.keyMap = d.keyMap||{};
  state.local={ drafts:d.drafts||{}, notes:d.notes||{}, created:d.created||{} };
  if(d.serverId) state.companion.serverId=d.serverId;
  state.companion.serverMismatch=!!d.serverMismatch;
  state.conflicts=Array.isArray(d.conflicts)?d.conflicts:[];
  if(d.liveSnapshot && !d.liveSnapshot.stale && Array.isArray(d.liveSnapshot.annotations) && Array.isArray(d.liveSnapshot.notes)){
    state.liveSnapshot=d.liveSnapshot;
    state.annotations=d.liveSnapshot.annotations.map(normalizeAnno);
    state.notes=d.liveSnapshot.notes.map(normalizeNote);
  }
  // Current objects are recovery seeds, never replacement baselines. This also
  // recovers transferred updates whose original item was never published.
  for(const [plural,normalize] of [['annotations',normalizeAnno],['notes',normalizeNote]]){
    for(const item of d.current?.[plural]||[]){
      if(!state[plural].some(existing=>existing.id===item.id)) state[plural].push(normalize(item));
    }
  }
  applyLocalToSnapshot();
  if(state.pending.length) setSyncState('draft');
}
function applyLocalToSnapshot(){
  // Apply local notes (overrides by id) and pending annotation edits/removals
  const byId=new Map(state.annotations.map(a=>[a.id,a]));
  for(const p of state.pending){
    if(p.kind==='annotation'){
      if(p.action==='delete'){ byId.delete(p.id); }
      else if(p.action==='create'){ if(p.value) byId.set(p.id, normalizeAnno(Object.assign({},p.value,{id:p.id,local:true}))); }
      else if(p.action==='update'){ const cur=byId.get(p.id)||baselineValue(p.id); if(cur) byId.set(p.id, normalizeAnno(Object.assign({},cur,p.value||{}, {id:p.id,key:p.key||cur.key,local:true}))); }
    }
  }
  state.annotations=Array.from(byId.values());
  const noteMap=new Map(state.notes.map(n=>[n.id,n]));
  for(const p of state.pending){
    if(p.kind==='note'){
      if(p.action==='delete') noteMap.delete(p.id);
      else if(p.action==='create'){ if(p.value) noteMap.set(p.id, normalizeNote(Object.assign({},p.value,{id:p.id,local:true}))); }
      else if(p.action==='update'){ const cur=noteMap.get(p.id)||baselineValue(p.id); if(cur) noteMap.set(p.id,normalizeNote(Object.assign({},cur,p.value||{},{id:p.id,key:p.key||cur.key,local:true}))); }
    }
  }
  state.notes=Array.from(noteMap.values());
}

async function persistLocal(opts={}){
  if(state.fileId==null) return;
  const payload = {
    schemaVersion:1, fileId:state.fileId, serverId:state.companion.serverId||null, serverMismatch:!!state.companion.serverMismatch, liveSnapshot:state.liveSnapshot||null,
    pending:state.pending, baselines:state.baselines, tombstones:state.tombstones, keyMap:state.keyMap, selectedNote:state.selectedNote, conflicts:state.conflicts, current:{annotations:state.annotations,notes:state.notes},
    drafts:state.local?state.local.drafts:{}, notes:state.local?state.local.notes:{}, created:state.local?state.local.created:{},
    updatedAt:new Date().toISOString()
  };
  const key=paperKey(state.fileId,'state');
  const backedUp=lsSet(key,JSON.stringify(payload));
  try{ await storeSet(key,payload); }catch(e){ if(!backedUp){ $('noteSaveState').textContent='Save failed'; toast('Could not save local draft: '+e.message,'error'); throw e; } }
}

function setSyncState(s,msg){
  state.syncState=s;
  renderStateChips();
  if(msg) setStatusMsg(msg);
}

/* ---------------- Sync pending queue helpers ---------------- */
function enqueue(change){
  const existing = state.pending.find(p=>p.id===change.id && p.kind===change.kind);
  const item = Object.assign({}, change, {operationId:change.operationId||uuid(), localUpdatedAt:new Date().toISOString()});
  if(existing){
    const wasCreate=existing.action==='create';
    const mergedValue=Object.assign({},existing.value||{},item.value||{});
    Object.assign(existing,item);
    if(wasCreate && change.action!=='delete') existing.action='create';
    if(change.action!=='delete') existing.value=mergedValue;
    existing.localUpdatedAt=item.localUpdatedAt;
  } else {
    state.pending.push(item);
  }
  setSyncState('draft','Local draft - unsynced changes');
  persistLocal({quiet:true});
}
function removePending(id,kind){ state.pending=state.pending.filter(p=>!(p.id===id&&p.kind===kind)); }
function ensureBaseline(item){
  if(!item) return;
  const kind=item.kind|| (item.type?'annotation':'note');
  if(!state.baselines[item.id]){
    state.baselines[item.id]={ id:item.id, kind, key:item.key||null, version:item.version??null, contentHash:contentHashOf(item), value:JSON.parse(JSON.stringify(item)), at:new Date().toISOString() };
  }
}
function baselineValue(id){ const b=state.baselines[id]; return b?b.value:null; }
function contentHashOf(obj){ return obj && /^[a-f0-9]{64}$/.test(obj.contentHash||'') ? obj.contentHash : null; }
function stableJson(value){
  if(Array.isArray(value)) return '['+value.map(stableJson).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJson(value[k])).join(',')+'}';
  return JSON.stringify(value==null?null:value);
}
function editableValue(item,kind){
  if(!item) return null;
  if(kind==='note') return {html:item.html??item.note??''};
  return {type:item.type??item.annotationType??'highlight',text:item.text??item.annotationText??'',comment:item.comment??item.annotationComment??'',color:item.color??item.annotationColor??'#ffd400',pageLabel:String(item.pageLabel??item.annotationPageLabel??''),position:item.position??{},tags:(item.tags||[]).map(t=>typeof t==='string'?t:t.tag).filter(Boolean).sort()};
}
function sameEditable(a,b,kind){ return stableJson(editableValue(a,kind))===stableJson(editableValue(b,kind)); }
function liveBaseline(item,kind){ return {id:item.id,kind,key:item.key||null,version:item.version??null,contentHash:contentHashOf(item),value:JSON.parse(JSON.stringify(item)),at:new Date().toISOString()}; }
function refreshActiveEditor(){
  if(state.editorDirty) return;
  const note=currentNote();
  $('noteEditor').innerHTML=note?sanitizeHtml(note.local?note.html:(note.displayHtml||note.html||'')):'';
  $('noteEditor').contentEditable=note&&!note.readOnly?'true':'false';
  $('btnUndoDelete').disabled=!Object.keys(state.tombstones).length;
}
function fastHash(str){
  let h1=0xdeadbeef, h2=0x41c6ce57;
  for(let i=0;i<str.length;i++){ const ch=str.charCodeAt(i); h1=Math.imul(h1^ch,2654435761); h2=Math.imul(h2^ch,1597334677); }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (h2>>>0).toString(16).padStart(8,'0')+(h1>>>0).toString(16).padStart(8,'0');
}

/* ---------------- Split pane ---------------- */
async function restoreSplit(){
  const v=await storeGet(paperKey(state.fileId,'ui'));
  if(v && typeof v.split==='number') state.split=clamp(v.split,25,80);
  state.scale=(v&&v.scale)||1.15; state.rotation=(v&&v.rotation)||0; state.curPage=(v&&v.page)||1;
  if(v&&v.fitMode) state.fitMode=v.fitMode;
  $('pageInput').value=state.curPage;
  applySplit();
}
function applySplit(){
  const ws=$('workspace');
  if(window.innerWidth<=820){ ws.classList.add('stack'); ws.style.removeProperty('--split'); }
  else { ws.classList.remove('stack'); ws.style.setProperty('--split',state.split+'%'); }
  $('divider').setAttribute('aria-valuenow',String(Math.round(state.split)));
}
const saveUi = debounce(async ()=>{
  if(state.fileId==null) return;
  await storeSet(paperKey(state.fileId,'ui'), {split:state.split, scale:state.scale, rotation:state.rotation, page:state.curPage, fitMode:state.fitMode});
},600);

function setupDivider(){
  const div=$('divider'); let dragging=false, startX=0, startSplit=0;
  div.addEventListener('pointerdown',e=>{
    if(window.innerWidth<=820) return;
    dragging=true; startX=e.clientX; startSplit=state.split; div.classList.add('dragging'); div.setPointerCapture(e.pointerId); e.preventDefault();
  });
  div.addEventListener('pointermove',e=>{
    if(!dragging) return;
    const ws=$('workspace'); const w=ws.getBoundingClientRect().width;
    if(w<=0) return;
    const pct=startSplit+((e.clientX-startX)/w)*100;
    state.split=clamp(pct,state.splitMin,state.splitMax); applySplit();
  });
  const end=e=>{ if(!dragging) return; dragging=false; div.classList.remove('dragging'); saveUi(); };
  div.addEventListener('pointerup',end); div.addEventListener('pointercancel',end);
  div.addEventListener('keydown',e=>{
    let step=0;
    if(e.key==='ArrowLeft') step=-2; else if(e.key==='ArrowRight') step=2; else if(e.key==='Home'){ state.split=state.splitMin; applySplit(); saveUi(); e.preventDefault(); return; } else if(e.key==='End'){ state.split=state.splitMax; applySplit(); saveUi(); e.preventDefault(); return; } else return;
    state.split=clamp(state.split+step,state.splitMin,state.splitMax); applySplit(); saveUi(); e.preventDefault();
  });
}

/* ---------------- PDF loading / lazy pages ---------------- */
async function loadPdf(){
  const src = state.paper._pdfUrl;
  $('pdfLoading').hidden=false;
  try{
    const loadingTask = pdfjsLib.getDocument({url:src, cMapUrl:CMAP, cMapPacked:true, standardFontDataUrl:STDFONT, wasmUrl:WASM, enableXfa:true});
    const pdf = await loadingTask.promise;
    state.pdf=pdf; state.numPages=pdf.numPages;
    $('pageTotal').textContent='of '+pdf.numPages;
    $('pageInput').max=String(pdf.numPages);
    buildPagePlaceholders();
    updatePdfError(null);
    if(state.curPage>pdf.numPages) state.curPage=pdf.numPages;
    $('pageInput').value=state.curPage;
    await renderVisiblePages(true);
    $('pdfLoading').hidden=true;
    if(state.curPage>1) scrollToPage(state.curPage,false);
  }catch(e){
    $('pdfLoading').hidden=true;
    showPdfError('Could not render PDF: '+e.message+'. Use Open PDF to view the file directly, or try the local companion.');
  }
}

function buildPagePlaceholders(){
  const container=$('pagesContainer'); container.innerHTML='';
  state.pages=[];
  for(let i=1;i<=state.numPages;i++){
    const wrap=document.createElement('div');
    wrap.className='pdf-page placeholder'; wrap.dataset.page=i;
    wrap.setAttribute('aria-label','Page '+i);
    wrap.style.width=Math.floor(612*state.scale)+'px'; wrap.style.height=Math.floor(792*state.scale)+'px';
    container.appendChild(wrap);
    state.pages.push({num:i, wrapper:wrap, rendered:false, rendering:false, canvas:null, textLayer:null, viewport:null});
  }
  if(state.scrollObserver) state.scrollObserver.disconnect();
  state.scrollObserver=new IntersectionObserver(entries=>{
    for(const en of entries){ if(en.isIntersecting) renderPageByElement(en.target); }
  },{root:$('pdfScroll'), rootMargin:'150% 0px'});
  for(const p of state.pages) state.scrollObserver.observe(p.wrapper);
}

async function renderPageByElement(el){
  const num=Number(el.dataset.page); if(!num) return;
  await renderPage(num);
}

async function renderPage(num){
  const p=state.pages[num-1]; if(!p) return;
  if(p.rendered||p.rendering) { if(p.rendered) { renderOverlayForPage(num); } return; }
  p.rendering=true;
  try{
    const page=await state.pdf.getPage(num);
    const vpBase=page.getViewport({scale:1, rotation:state.rotation});
    const wrapEl=p.wrapper.parentElement; // pages
    const paneW=Math.max(280, $('pdfScroll').clientWidth-36);
    let scale=state.scale;
    if(state.fitMode==='width') scale=paneW/vpBase.width;
    else if(state.fitMode==='page'){ const availH=$('pdfScroll').clientHeight-40; scale=Math.min(paneW/vpBase.width, availH/vpBase.height); }
    scale=clamp(scale,0.15,6);
    if(num===state.curPage || num===1 && !state.pages[state.curPage-1]?.rendered){ state.scale=scale; $('zoomVal').textContent=Math.round(scale*100)+'%'; }
    const viewport=page.getViewport({scale, rotation:state.rotation});
    p.viewport=viewport; p.scaleUsed=scale;
    p.wrapper.classList.remove('placeholder');
    p.wrapper.style.width=Math.floor(viewport.width)+'px';
    p.wrapper.style.height=Math.floor(viewport.height)+'px';
    p.wrapper.innerHTML='';
    p.wrapper.style.setProperty('--total-scale-factor',String(viewport.scale));
    p.wrapper.style.setProperty('--scale-factor',String(viewport.scale));
    p.wrapper.style.setProperty('--scale-round-x','1px');
    p.wrapper.style.setProperty('--scale-round-y','1px');
    const dpr=Math.min(window.devicePixelRatio||1, 2.5);
    const canvas=document.createElement('canvas');
    canvas.width=Math.floor(viewport.width*dpr); canvas.height=Math.floor(viewport.height*dpr);
    canvas.style.width=Math.floor(viewport.width)+'px'; canvas.style.height=Math.floor(viewport.height)+'px';
    p.wrapper.appendChild(canvas);
    const ctx=canvas.getContext('2d',{alpha:false});
    await page.render({canvasContext:ctx, viewport, transform: dpr!==1?[dpr,0,0,dpr,0,0]:null}).promise;
    p.canvas=canvas; p.rendered=true;
    // Text layer
    let TextLayerCtor = pdfjsLib.TextLayer;
    if(TextLayerCtor && typeof TextLayerCtor==='object' && TextLayerCtor.TextLayer) TextLayerCtor=TextLayerCtor.TextLayer;
    if(TextLayerCtor){
      try{
        const textContent=await page.getTextContent();
        const textContainer=document.createElement('div'); textContainer.className='textLayer';
        p.wrapper.appendChild(textContainer);
        const tl = new TextLayerCtor({textContentSource:textContent, container:textContainer, viewport});
        await tl.render();
        const layerEl = p.wrapper.querySelector('.textLayer');
        if(layerEl){ p.textLayer=layerEl; } else { p.textLayer=textContainer; }
      }catch(e){ await renderTextLayerManual(p, page, viewport); }
    }else{
      await renderTextLayerManual(p, page, viewport);
    }
    const badge=document.createElement('span'); badge.className='page-num-badge'; badge.textContent=String(num); p.wrapper.appendChild(badge);
    const layer=document.createElement('div'); layer.className='annot-layer'; layer.dataset.page=num; p.wrapper.appendChild(layer); p.overlayEl=layer;
    renderOverlayForPage(num);
  }catch(e){
    p.rendering=false; p.wrapper.classList.add('placeholder'); p.wrapper.textContent='Page '+num+' failed: '+e.message; return;
  }
  p.rendering=false;
  if(p.needsRender){ p.needsRender=false; p.rendered=false; await renderPage(num); }
}

async function renderTextLayerManual(p,page,viewport){
  try{
    const tc=await page.getTextContent();
    const layer=document.createElement('div'); layer.className='textLayer';
    const util=pdfjsLib.Util;
    for(const item of tc.items){
      if(!item.str) continue;
      const span=document.createElement('span'); span.textContent=item.str;
      let tx;
      if(util && util.transform){
        tx=util.transform(viewport.transform, item.transform);
        const angle=Math.atan2(tx[1],tx[0]);
        const fontHeight=Math.hypot(tx[2],tx[3]);
        span.style.left=tx[4]+'px'; span.style.top=(tx[5]-fontHeight)+'px';
        span.style.fontSize=fontHeight+'px'; span.style.fontFamily=item.fontName||'sans-serif';
        if(angle!==0) span.style.transform=`rotate(${angle}rad)`;
        if(item.width>0) span.style.width=(item.width*viewport.scale)+'px';
      }
      layer.appendChild(span);
    }
    p.wrapper.appendChild(layer); p.textLayer=layer;
  }catch(e){}
}

async function renderVisiblePages(force){
  if(!state.pdf) return;
  const scroll=$('pdfScroll'); const sr=scroll.getBoundingClientRect();
  const jobs=[];
  for(const p of state.pages){
    const r=p.wrapper.getBoundingClientRect();
    if(r.bottom>=sr.top-300 && r.top<=sr.bottom+300) jobs.push(p.num);
  }
  if(!jobs.length) jobs.push(state.curPage);
  for(const n of jobs) await renderPage(n);
  renderAllOverlays();
}

/* Re-render all currently rendered pages for zoom/rotation (memory-safe: only visible) */
let rerenderTimer=null;
async function reRenderAll(){
  if(!state.pdf) return;
  const scroll=$('pdfScroll'); const scrollTop=scroll.scrollTop; const sr=scroll.getBoundingClientRect();
  const toRender=[];
  for(const p of state.pages){
    if(!p.rendered && !p.rendering) continue;
    const r=p.wrapper.getBoundingClientRect();
    const near = r.bottom>=sr.top-600 && r.top<=sr.bottom+600;
    // unload far pages to free memory
    if(!near && p.canvas){
      p.wrapper.classList.add('placeholder'); p.wrapper.innerHTML=''; p.rendered=false; p.canvas=null; p.textLayer=null; p.overlayEl=null;
      p.wrapper.style.width=Math.floor(612*state.scale)+'px'; p.wrapper.style.height=Math.floor(792*state.scale)+'px';
    } else if(near){
      p.rendered=false;
      if(p.rendering) { p.needsRender=true; continue; }
      toRender.push(p.num);
    }
  }
  $('pdfScroll').scrollTop=scrollTop;
  for(const n of toRender) await renderPage(n);
  if($('zoomVal')) $('zoomVal').textContent=Math.round(state.scale*100)+'%';
}

function requestRerender(){ clearTimeout(rerenderTimer); rerenderTimer=setTimeout(()=>{ reRenderAll(); },120); }

/* ---------------- Page navigation ---------------- */
function goToPage(n, smooth=true){
  if(!state.numPages) return;
  n=clamp(Math.round(n),1,state.numPages);
  state.curPage=n; $('pageInput').value=n;
  scrollToPage(n,smooth);
  const p=state.pages[n-1]; if(p) renderPage(n);
  saveUi();
}
function scrollToPage(n,smooth){
  const p=state.pages[n-1]; if(!p) return;
  const scroll=$('pdfScroll');
  const target=p.wrapper.offsetTop - 10;
  if(smooth && 'scrollTo' in scroll) scroll.scrollTo({top:target,behavior:'smooth'});
  else scroll.scrollTop=target;
}
function updateCurrentPageFromScroll(){
  if(!state.pages.length) return;
  const scroll=$('pdfScroll'); const mid=scroll.scrollTop+scroll.clientHeight*0.35;
  let best=state.curPage, bestD=Infinity;
  for(const p of state.pages){
    const top=p.wrapper.offsetTop, h=p.wrapper.offsetHeight||1;
    const d=Math.abs((top+h/2)-mid);
    if(d<bestD){ bestD=d; best=p.num; }
  }
  if(best!==state.curPage){ state.curPage=best; $('pageInput').value=best; saveUi(); }
}

/* ---------------- Zoom / fit / rotate ---------------- */
function setZoom(scale){
  state.scale=clamp(scale,0.15,6); state.fitMode=null;
  $('zoomVal').textContent=Math.round(state.scale*100)+'%';
  $('btnFitWidth').setAttribute('aria-pressed','false'); $('btnFitPage').setAttribute('aria-pressed','false');
  requestRerender(); saveUi();
}
function chooseFit(mode){
  state.fitMode=mode;
  $('btnFitWidth').setAttribute('aria-pressed',mode==='width'?'true':'false');
  $('btnFitPage').setAttribute('aria-pressed',mode==='page'?'true':'false');
  reRenderAll(); saveUi();
}
function rotatePage(){
  state.rotation=(state.rotation+90)%360;
  // rotation does not change scale; full re-render of visible pages
  reRenderAll(); saveUi();
  renderAllOverlays();
  toast('Rotated page to '+state.rotation+'\u00b0');
}

/* ---------------- Overlay geometry ---------------- */
async function renderOverlayForPage(num){
  const p=state.pages[num-1]; if(!p||!p.overlayEl) return;
  const layer=p.overlayEl; layer.innerHTML='';
  const pageAnnos=state.annotations.filter(a=>a.position && Number(a.position.pageIndex)===num-1);
  for(const a of pageAnnos) addAnnoMark(layer,a,p);
}
function renderAllOverlays(){ for(let n=1;n<=state.numPages;n++) renderOverlayForPage(n); }
function pdfRectToCss(rect,p){
  // rect in PDF user-space coordinates; p.viewport maps to CSS pixels
  const v=p.viewport; if(!v||!Array.isArray(rect)||rect.length<4) return null;
  let [x1,y1,x2,y2]=rect.map(Number);
  if([x1,y1,x2,y2].some(v=>!isFinite(v))) return null;
  if(x1>x2) [x1,x2]=[x2,x1];
  if(y1>y2) [y1,y2]=[y2,y1];
  const c1=p.viewport.convertToViewportPoint(x1,y1);
  const c2=p.viewport.convertToViewportPoint(x2,y2);
  const left=Math.min(c1[0],c2[0]), top=Math.min(c1[1],c2[1]);
  const w=Math.abs(c2[0]-c1[0])||2, h=Math.abs(c2[1]-c1[1])||2;
  return {left,top,width:w,height:h};
}
function addAnnoMark(layer,a,p){
  const color=safeColor(a.color||'#ffd400');
  const rects=(a.position&&Array.isArray(a.position.rects))?a.position.rects:[];
  const type=a.type||'highlight';
  const isUnknown=!['highlight','underline','note'].includes(type);
  let firstMark=null;
  const makeMark=(g)=>{ const el=document.createElement('div'); el.className='anno-mark type-'+type+' '+(state.selectedAnno===a.id?'selected':'')+(isUnknown?' unknown':'');
    el.style.left=g.left+'px'; el.style.top=g.top+'px'; el.style.width=g.width+'px'; el.style.height=g.height+'px';
    el.style.background=type==='underline'?'transparent':color; el.style.color=color;
    el.dataset.id=a.id; el.tabIndex=0; el.setAttribute('role','button'); el.setAttribute('aria-label',`${type} annotation on page ${p.num}${a.comment?': '+a.comment.slice(0,80):''}`);
    const lbl=document.createElement('span'); lbl.className='mark-label'; lbl.textContent=type; el.appendChild(lbl);
    if(a.local || isPending(a.id)){ const dot=document.createElement('span'); dot.className='pending-dot'; dot.title='Unsynced local change'; el.appendChild(dot); }
    if(isUnknown) el.textContent='? ';
    el.addEventListener('click',ev=>{ ev.stopPropagation(); selectAnnotation(a.id,true); });
    el.addEventListener('keydown',ev=>{ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); selectAnnotation(a.id,true); } });
    return el; };
  if(type==='note' || !rects.length){
    let g=null;
    if(rects.length) g=pdfRectToCss(rects[0],p);
    if(!g) g={left:8,top:8,width:16,height:16};
    firstMark=makeMark(g); layer.appendChild(firstMark);
  } else {
    for(const r of rects){ const g=pdfRectToCss(r,p); if(!g) continue; const el=makeMark(g); layer.appendChild(el); if(!firstMark) firstMark=el; }
  }
}
function isPending(id){ return state.pending.some(p=>p.id===id); }
function safeColor(c){ return /^#[0-9a-f]{3,8}$/i.test(c||'')?c:'#ffd400'; }

/* ---------------- Selection -> PDF coords ---------------- */
function pageElementFromNode(node){
  let el=node && (node.nodeType===1?node:node.parentElement);
  while(el && !(el.classList && el.classList.contains('pdf-page'))) el=el.parentElement;
  return el;
}
function collectSelectionRects(){
  const sel=window.getSelection();
  if(!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range=sel.getRangeAt(0);
  const perPage=new Map();
  for(const p of state.pages){
    if(!p.viewport || !p.textLayer || !range.intersectsNode(p.textLayer)) continue;
    // Intersect DOM ranges first: screen hit testing misattributes offscreen pages.
    const pageRange=document.createRange(); pageRange.selectNodeContents(p.textLayer);
    if(range.compareBoundaryPoints(0,pageRange)>0) pageRange.setStart(range.startContainer,range.startOffset);
    if(range.compareBoundaryPoints(2,pageRange)<0) pageRange.setEnd(range.endContainer,range.endOffset);
    if(pageRange.collapsed) continue;
    const pr=p.wrapper.getBoundingClientRect();
    if(pr.width<=0 || pr.height<=0) continue;
    const rects=[];
    for(const r of pageRange.getClientRects()){
      const left=Math.max(r.left,pr.left), right=Math.min(r.right,pr.right);
      const top=Math.max(r.top,pr.top), bottom=Math.min(r.bottom,pr.bottom);
      if(right-left<=0.5 || bottom-top<=0.5) continue;
      const sx=p.viewport.width/pr.width, sy=p.viewport.height/pr.height;
      const p1=p.viewport.convertToPdfPoint((left-pr.left)*sx,(top-pr.top)*sy);
      const p2=p.viewport.convertToPdfPoint((right-pr.left)*sx,(bottom-pr.top)*sy);
      rects.push([Math.min(p1[0],p2[0]),Math.min(p1[1],p2[1]),Math.max(p1[0],p2[0]),Math.max(p1[1],p2[1])]);
    }
    if(rects.length) perPage.set(p.num,{pageIndex:p.num-1,rects:mergeRects(rects),text:pageRange.toString().trim()});
  }
  if(!perPage.size) return null;
  const pages=Array.from(perPage.values());
  return {text:pages.map(pg=>pg.text).join('\n'),pages,clientRect:range.getBoundingClientRect()};
}
function mergeRects(rects){
  // group rects on same line (similar y center), produce union per line
  const arr=rects.map(r=>({x1:r[0],y1:r[1],x2:r[2],y2:r[3]})).sort((a,b)=>a.y1-b.y1||a.x1-b.x1);
  const out=[];
  for(const r of arr){
    if(!out.length){ out.push(r); continue; }
    const last=out[out.length-1];
    const h=Math.min(last.y2,last.y2)-Math.max(last.y1,r.y1);
    const overlap=Math.min(last.y2,r.y2)-Math.max(last.y1,r.y1);
    if(overlap>Math.min(last.y2-last.y1,r.y2-r.y1)*0.5){
      last.x1=Math.min(last.x1,r.x1); last.x2=Math.max(last.x2,r.x2); last.y1=Math.min(last.y1,r.y1); last.y2=Math.max(last.y2,r.y2);
    } else out.push(r);
  }
  return out.map(r=>[r.x1,r.y1,r.x2,r.y2]);
}
function getSelectedPdfText(){ const sel=window.getSelection(); return sel?sel.toString().trim():''; }
// Controls can take focus and collapse the DOM selection before their click fires.
function selectedTranslationText(){ return state.lastSelection?.text || collectSelectionRects()?.text || ''; }

function showSelPopup(clientRect){
  const pop=$('selPopup');
  pop.hidden=false;
  const w=pop.offsetWidth||240;
  let left=clamp(clientRect.left+clientRect.width/2-w/2, 6, window.innerWidth-w-6);
  let top=clientRect.top-42; if(top<70) top=clientRect.bottom+8;
  pop.style.left=left+'px'; pop.style.top=top+'px';
}
function hideSelPopup(){ $('selPopup').hidden=true; }

function handleSelectionEnd(){
  setTimeout(()=>{
    const info=collectSelectionRects();
    if(!info || !info.text){ hideSelPopup(); state.lastSelection=null; $('btnTranslateSel').disabled=true; return; }
    state.lastSelection=info;
    showSelPopup(info.clientRect);
    $('btnTranslateSel').disabled = !info.text;
  },10);
}

async function createAnnoFromSelection(type){
  const info=state.lastSelection || collectSelectionRects();
  if(!info || !info.pages.length){ toast('Select text in the PDF first.','error'); return; }
  const color = type==='underline' ? '#b5362a' : (await lastUsedColor()||'#ffd400');
  const ids=[];
  for(const pg of info.pages){
    const id=uuid(); ids.push(id);
    const anno={
      id, kind:'annotation', type, text: pg.text??info.text, comment:'', color,
      pageLabel: String(pg.pageIndex+1), position:{pageIndex:pg.pageIndex, rects:pg.rects},
      tags:[], dateModified:new Date().toISOString(), local:true
    };
    state.annotations.push(normalizeAnno(anno));
    enqueue({action:'create',kind:'annotation',id,value:cleanAnnoValue(anno)});
  }
  window.getSelection()?.removeAllRanges(); hideSelPopup();
  renderAllOverlays(); renderPanels();
  if(ids.length) selectAnnotation(ids[0],true);
  toast(type[0].toUpperCase()+type.slice(1)+' added locally on '+ids.length+' page(s).','ok');
}
let _lastColor=null;
async function lastUsedColor(){ if(_lastColor) return _lastColor; const v=await storeGet('plr.lastColor'); if(v) _lastColor=v; return _lastColor; }
async function setLastColor(c){ _lastColor=c; try{ await storeSet('plr.lastColor',c);}catch{} }

function cleanAnnoValue(a){
  const o={};
  for(const k of ['id','type','text','comment','color','pageLabel','position','tags','dateModified']){ if(a[k]!==undefined) o[k]=a[k]; }
  return o;
}

/* Point note tool */
let pointToolActive=false;
function togglePointNote(){
  pointToolActive=!pointToolActive;
  $('btnPointNote').setAttribute('aria-pressed',pointToolActive?'true':'false');
  $('pdfScroll').style.cursor=pointToolActive?'crosshair':'';
  if(pointToolActive) toast('Click on the PDF to place a point note.');
}
function placePointNote(clientX,clientY){
  const el=document.elementFromPoint(clientX,clientY);
  const pageEl=pageElementFromNode(el); if(!pageEl) return;
  const num=Number(pageEl.dataset.page); const p=state.pages[num-1]; if(!p||!p.viewport) return;
  const pr=pageEl.getBoundingClientRect();
  const pt=p.viewport.convertToPdfPoint(clientX-pr.left, clientY-pr.top);
  const id=uuid();
  const anno={id,kind:'annotation',type:'note',text:'',comment:'',color:'#ffd400',pageLabel:String(num),
    position:{pageIndex:num-1,rects:[[pt[0]-1,pt[1]-1,pt[0]+1,pt[1]+1]]},tags:[],dateModified:new Date().toISOString(),local:true};
  state.annotations.push(normalizeAnno(anno));
  enqueue({action:'create',kind:'annotation',id,value:cleanAnnoValue(anno)});
  renderOverlayForPage(num); renderPanels(); selectAnnotation(id,true);
  pointToolActive=false; $('btnPointNote').setAttribute('aria-pressed','false'); $('pdfScroll').style.cursor='';
  toast('Point note placed. Add a comment in the card.','ok');
  const card=document.querySelector(`.anno-card[data-id="${CSS.escape(id)}"]`); const c=card&&card.querySelector('.ac-comment'); if(c) c.focus();
}

/* ---------------- Annotation panel ---------------- */
function selectAnnotation(id,scrollTo){
  state.selectedAnno=id;
  document.querySelectorAll('.anno-card').forEach(c=>c.classList.toggle('selected',c.dataset.id===id));
  document.querySelectorAll('.anno-mark').forEach(m=>m.classList.toggle('selected',m.dataset.id===id));
  const a=state.annotations.find(x=>x.id===id); if(!a) return;
  showTab('anno');
  const card=document.querySelector(`.anno-card[data-id="${CSS.escape(id)}"]`);
  if(card && scrollTo) card.scrollIntoView({block:'nearest',behavior:'smooth'});
  const pi=Number(a.position&&a.position.pageIndex);
  if(Number.isInteger(pi) && scrollTo){
    goToPage(pi+1);
    setTimeout(()=>{ const mark=document.querySelector(`.anno-mark[data-id="${CSS.escape(id)}"]`); if(mark) mark.scrollIntoView({block:'center',behavior:'smooth'}); },200);
  }
  const q=state.annotations.find(x=>x.id===id);
  $('btnInsertQuote').disabled=!(state.activeNoteDraftId && q);
}

const COLORS=['#ffd400','#5fb236','#2ea8e5','#a28ae5','#e56eee','#f19837','#ff6666','#aaaaaa'];
function renderAnnoList(){
  const list=$('annoList'); list.innerHTML='';
  $('annoCount').textContent=String(state.annotations.length);
  if(!state.annotations.length){
    const e=document.createElement('div'); e.className='empty-state';
    e.textContent='No annotations for this paper. Select text in the PDF (or use Point note) to add highlights, underlines and notes.';
    list.appendChild(e); return;
  }
  const sorted=[...state.annotations].sort((a,b)=>{ const pa=Number(a.position&&a.position.pageIndex)||0, pb=Number(b.position&&b.position.pageIndex)||0; return pa-pb; });
  for(const a of sorted) list.appendChild(renderAnnoCard(a));
}
function renderAnnoCard(a){
  const card=document.createElement('div'); card.className='anno-card'+(state.selectedAnno===a.id?' selected':''); card.dataset.id=a.id; card.tabIndex=0;
  const displayColor=safeColor(a.color); card.style.borderLeftColor=displayColor;
  const head=document.createElement('div'); head.className='ac-head';
  const typeSpan=document.createElement('span'); typeSpan.className='ac-type'; typeSpan.textContent=a.type||'annotation';
  head.appendChild(typeSpan);
  const sw=document.createElement('span'); sw.className='color-swatches';
  for(const c of COLORS){ const b=document.createElement('button'); b.type='button'; b.className='swatch'+(a.color===c?' sel':''); b.style.background=c; b.title='Set color '+c; b.setAttribute('aria-label','Set highlight color');
    b.addEventListener('click',e=>{ e.stopPropagation(); updateAnnotation(a.id,{color:c},false); setLastColor(c); }); sw.appendChild(b); }
  head.appendChild(sw);
  if(a.local) { const b=document.createElement('span'); b.className='badge loc'; b.textContent='Local draft'; head.appendChild(b); }
  if(a.readOnly){ const b=document.createElement('span'); b.className='badge ro'; b.textContent='Read-only (external)'; head.appendChild(b); }
  if(!['highlight','underline','note'].includes(a.type)){ const b=document.createElement('span'); b.className='badge ro'; b.textContent='Unsupported type: '+(a.type||'unknown'); head.appendChild(b); }
  const pg=document.createElement('span'); pg.className='ac-page'; pg.textContent='p. '+(a.pageLabel||(a.position&&Number(a.position.pageIndex)!=null?Number(a.position.pageIndex)+1:'?')); head.appendChild(pg);
  card.appendChild(head);
  if(a.text){ const q=document.createElement('div'); q.className='ac-quote'; q.textContent=a.text; card.appendChild(q); }
  const cm=document.createElement('div'); cm.className='ac-comment'; cm.contentEditable = a.readOnly?'false':'true';
  cm.textContent=a.comment||''; cm.setAttribute('role','textbox'); cm.setAttribute('aria-label','Annotation comment');
  if(!a.comment) cm.dataset.placeholder='Add comment\u2026';
  cm.addEventListener('click',e=>e.stopPropagation());
  cm.addEventListener('focus',()=>ensureBaseline(a));
  const saveCm=debounce(()=>{ if(a.readOnly){ toast('This annotation is read-only and cannot be edited.','error'); cm.textContent=a.comment||''; return; } updateAnnotation(a.id,{comment:cm.textContent},true); },500);
  cm.addEventListener('input',saveCm);
  card.appendChild(cm);
  const acts=document.createElement('div'); acts.className='ac-actions';
  const quoteBtn=document.createElement('button'); quoteBtn.type='button'; quoteBtn.className='btn small'; quoteBtn.textContent='Quote to note';
  quoteBtn.addEventListener('click',e=>{ e.stopPropagation(); quoteToNote(a); }); acts.appendChild(quoteBtn);
  const locateBtn=document.createElement('button'); locateBtn.type='button'; locateBtn.className='btn small'; locateBtn.textContent='Show page';
  locateBtn.addEventListener('click',e=>{ e.stopPropagation(); const pi=Number(a.position&&a.position.pageIndex); if(Number.isInteger(pi)) goToPage(pi+1); }); acts.appendChild(locateBtn);
  const delBtn=document.createElement('button'); delBtn.type='button'; delBtn.className='btn small danger'; delBtn.textContent='Delete';
  delBtn.disabled=!!a.readOnly;
  delBtn.addEventListener('click',e=>{ e.stopPropagation(); deleteAnnotation(a.id); }); acts.appendChild(delBtn);
  card.appendChild(acts);
  card.addEventListener('click',()=>selectAnnotation(a.id,false));
  card.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target===card) selectAnnotation(a.id,true); });
  return card;
}
function updateAnnotation(id,patch,isEdit){
  const idx=state.annotations.findIndex(a=>a.id===id); if(idx<0) return;
  const cur=state.annotations[idx]; if(cur.readOnly){ toast('Read-only annotation.','error'); return; }
  ensureBaseline(cur);
  Object.assign(cur,patch); cur.local=true; cur.dateModified=new Date().toISOString();
  const b=state.baselines[id];
  enqueue({action:'update',kind:'annotation',id,key:cur.key||state.keyMap[id]||null,baseVersion:b?b.version:undefined,baseContentHash:b?b.contentHash:undefined,value:cleanAnnoValue(cur)});
  renderOverlayForPage((cur.position&&cur.position.pageIndex||0)+1); renderAnnoList();
}
function deleteAnnotation(id){
  const a=state.annotations.find(x=>x.id===id); if(!a) return;
  if(a.readOnly){ toast('This annotation is read-only and cannot be deleted here.','error'); return; }
  ensureBaseline(a);
  rememberDeletion(a,'annotation');
  state.annotations=state.annotations.filter(x=>x.id!==id);
  const isNew = state.pending.some(p=>p.id===id&&p.kind==='annotation'&&p.action==='create');
  if(isNew){ removePending(id,'annotation'); }
  else { enqueue({action:'delete',kind:'annotation',id,key:a.key||state.keyMap[id]||null,baseVersion:(state.baselines[id]||{}).version,baseContentHash:(state.baselines[id]||{}).contentHash}); setSyncState('draft','Deletion stored as local tombstone until sync'); }
  persistLocal({quiet:true}); renderAllOverlays(); renderPanels();
  toast('Deleted locally. Changes remain local until you sync.');
  refreshActiveEditor();
}

function rememberDeletion(item,kind){
  const pending=state.pending.find(p=>p.id===item.id&&p.kind===kind)||null;
  state.tombstones[item.id]=JSON.parse(JSON.stringify({id:item.id,kind,key:item.key||null,value:item,pending,baseline:state.baselines[item.id]||null,at:new Date().toISOString()}));
}
function undoLocalDeletion(){
  if(syncing){ toast('Wait for Sync to finish before undoing a deletion.','error'); return; }
  const deleted=Object.values(state.tombstones).filter(t=>t.value).sort((a,b)=>String(a.at).localeCompare(String(b.at))).pop();
  if(!deleted){ toast('No local deletion to undo.'); return; }
  const {id,kind}=deleted;
  removePending(id,kind);
  if(deleted.baseline) state.baselines[id]=deleted.baseline;
  if(deleted.pending) state.pending.push(deleted.pending);
  const items=kind==='note'?state.notes:state.annotations;
  if(!items.some(item=>item.id===id)) items.push((kind==='note'?normalizeNote:normalizeAnno)(deleted.value));
  delete state.tombstones[id];
  if(kind==='note'){ state.selectedNote=id; state.activeNoteDraftId=id; state.editorDirty=false; }
  persistLocal({quiet:true}); renderAllOverlays(); renderPanels(); refreshActiveEditor();
  setSyncState(state.pending.length?'draft':'snapshot','Local deletion undone');
  toast('Deletion undone.','ok');
}

function quoteToNote(a){
  showTab('notes');
  let noteId=state.selectedNote;
  if(!noteId){ noteId=newNote(false); }
  const ed=$('noteEditor');
  const div=document.createElement('div'); div.className='quote-block';
  div.textContent=a.text||(a.comment||a.type);
  const src=document.createElement('div'); src.className='src';
  const sourceLink=document.createElement('a');
  const pageNumber=(Number(a.position&&a.position.pageIndex)||0)+1;
  const attachment=state.data?.zotero?.attachmentKey;
  sourceLink.href=attachment&&a.key ? `zotero://open-pdf/library/items/${encodeURIComponent(attachment)}?page=${pageNumber}&annotation=${encodeURIComponent(a.key)}` : new URL(state.paper.pdfUrl,'https://yak9ce3teeh.github.io/papers/reader/').href+'#page='+pageNumber;
  sourceLink.textContent=`Page ${a.pageLabel||pageNumber}`; src.appendChild(sourceLink);
  div.appendChild(src);
  ed.focus();
  const sel=window.getSelection(); const range=document.createRange(); range.selectNodeContents(ed); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
  ed.appendChild(div); ed.appendChild(document.createElement('p'));
  scheduleNoteSave();
  toast('Quote inserted into note.','ok');
}

/* ---------------- Exported annotation colors ---------------- */

/* ---------------- Notes ---------------- */
function newNote(select=true){
  flushNoteSaveSync();
  const id=uuid();
  const note={id,kind:'note',html:'',dateModified:new Date().toISOString(),local:true};
  state.notes.push(normalizeNote(note));
  enqueue({action:'create',kind:'note',id,value:{html:''}});
  state.local.notes[id]='';
  persistLocal({quiet:true});
  renderNoteList(); renderNoteSelect();
  if(select) selectNote(id);
  else { state.selectedNote=id; state.activeNoteDraftId=id; $('noteEditor').innerHTML=''; state.editorDirty=false; refreshActiveEditor(); }
  $('noteEditor').focus();
  return id;
}
function renderNoteSelect(){
  const sel=$('noteSelect'); sel.innerHTML='';
  if(!state.notes.length){ const o=document.createElement('option'); o.value=''; o.textContent='No notes yet'; sel.appendChild(o); return; }
  for(const n of state.notes){ const o=document.createElement('option'); o.value=n.id; o.textContent=noteTitle(n); sel.appendChild(o); }
  if(state.selectedNote) sel.value=state.selectedNote;
}
function noteTitle(n){ const tmp=document.createElement('div'); tmp.innerHTML=sanitizeHtml(n.html||''); const t=(tmp.textContent||'').trim().replace(/\s+/g,' '); return t? t.slice(0,60):'Untitled note'; }
function selectNote(id){
  if(state.saveTimer){ state.saveTimer.cancel(); }
  flushNoteSaveSync();
  state.selectedNote=id; state.activeNoteDraftId=id;
  const n=state.notes.find(x=>x.id===id);
  const ed=$('noteEditor');
  if(n){ ed.innerHTML=sanitizeHtml(n.local?n.html:(n.displayHtml||n.html||'')); }
  else ed.innerHTML='';
  ed.contentEditable=n&&!n.readOnly?'true':'false';
  state.editorDirty=false;
  $('noteSelect').value=id||'';
  $('btnDeleteNote').disabled=!n;
  $('btnInsertQuote').disabled=!(n && state.selectedAnno);
  $('noteSaveState').textContent='Saved';
  showTab('notes');
  renderNoteList();
  persistLocal({quiet:true});
}
function currentNote(){ return state.notes.find(n=>n.id===state.selectedNote)||null; }
function currentEditorHtml(){ return $('noteEditor').innerHTML||''; }
function scheduleNoteSave(){
  if(!state.selectedNote) return;
  state.editorDirty=true;
  $('noteSaveState').textContent='Saving\u2026';
  if(state.saveTimer) state.saveTimer.cancel();
  state.saveTimer=debounce(async ()=>{ await flushNoteSave(); },700);
  state.saveTimer();
}
async function flushNoteSave(){
  try { await persistCurrentNote(true); $('noteSaveState').textContent='Saved'; }
  catch(e) { $('noteSaveState').textContent='Save failed'; }
}
function flushNoteSaveSync(){
  if(!state.selectedNote) return;
  persistCurrentNote(false);
}
async function persistCurrentNote(asyncPersist){
  if(!state.editorDirty) return;
  const id=state.selectedNote; if(!id) return;
  const n=state.notes.find(x=>x.id===id); if(!n) return;
  if(n.readOnly){ return; }
  const html=sanitizeHtml(currentEditorHtml());
  ensureBaseline(n);
  n.html=html; n.local=true; n.dateModified=new Date().toISOString();
  if(!state.local) state.local={drafts:{},notes:{},created:{}};
  state.local.notes[id]=html;
  const b=state.baselines[id];
  enqueue({action:'update',kind:'note',id,key:n.key||state.keyMap[id]||null,baseVersion:b?b.version:undefined,baseContentHash:b?b.contentHash:undefined,value:{html}});
  if(asyncPersist) await persistLocal({quiet:true});
  state.editorDirty=false;
  renderNoteList(); renderNoteSelect();
}
function deleteNote(){ const id=state.selectedNote; if(!id){ toast('Select a note to delete.','error'); return; } deleteNoteById(id); }
function deleteNoteById(id){
  if(state.selectedNote===id){ if(state.saveTimer) state.saveTimer.cancel(); flushNoteSaveSync(); }
  const n=state.notes.find(x=>x.id===id); if(!n) return;
  if(n.readOnly){ toast('This note is read-only.','error'); return; }
  ensureBaseline(n);
  rememberDeletion(n,'note');
  state.notes=state.notes.filter(x=>x.id!==id);
  const isNew=state.pending.some(p=>p.id===id&&p.kind==='note'&&p.action==='create');
  if(isNew){ removePending(id,'note'); }
  else { enqueue({action:'delete',kind:'note',id,key:n.key||state.keyMap[id]||null,baseVersion:(state.baselines[id]||{}).version,baseContentHash:(state.baselines[id]||{}).contentHash}); setSyncState('draft','Note deletion stored locally'); }
  persistLocal({quiet:true});
  state.selectedNote=null; state.activeNoteDraftId=null;
  $('noteEditor').innerHTML=''; $('btnDeleteNote').disabled=true;
  $('noteSaveState').textContent='Saved';
  state.editorDirty=false; refreshActiveEditor();
  renderNoteList(); renderNoteSelect(); renderAnnoList();
  toast('Note deleted locally.','ok');
}
function renderNoteList(){
  const list=$('noteList'); list.innerHTML='';
  $('noteCount').textContent=String(state.notes.length);
  if(!state.notes.length){ const e=document.createElement('div'); e.className='empty-state'; e.textContent='No reading notes for this paper in the published snapshot. Create one with New note.'; list.appendChild(e); return; }
  for(const n of state.notes){
    const card=document.createElement('div'); card.className='anno-card'+(state.selectedNote===n.id?' selected':''); card.dataset.noteId=n.id; card.tabIndex=0;
    const head=document.createElement('div'); head.className='ac-head';
    const t=document.createElement('span'); t.className='ac-type'; t.textContent='Note'; head.appendChild(t);
    if(n.local){ const b=document.createElement('span'); b.className='badge loc'; b.textContent='Local draft'; head.appendChild(b); }
    const dm=document.createElement('span'); dm.className='ac-page'; dm.textContent=n.dateModified?new Date(n.dateModified).toLocaleDateString():''; head.appendChild(dm);
    card.appendChild(head);
    const body=document.createElement('div'); body.className='note-render'; body.textContent=noteTitle(n); card.appendChild(body);
    const acts=document.createElement('div'); acts.className='ac-actions';
    const edit=document.createElement('button'); edit.type='button'; edit.className='btn small'; edit.textContent='Edit'; edit.addEventListener('click',e=>{ e.stopPropagation(); selectNote(n.id); }); acts.appendChild(edit);
    const del=document.createElement('button'); del.type='button'; del.className='btn small danger'; del.textContent='Delete'; del.addEventListener('click',e=>{ e.stopPropagation(); if(confirm('Delete this note locally? This is reversible only before sync.')) deleteNoteById(n.id); }); acts.appendChild(del);
    card.appendChild(acts);
    card.addEventListener('click',()=>selectNote(n.id));
    card.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target===card) selectNote(n.id); });
    list.appendChild(card);
  }
}

/* ---------------- Tabs ---------------- */
function showTab(kind){
  const map={anno:['tabAnno','annoPanel'],notes:['tabNotes','notesPanel'],trans:['tabTrans','transPanel']};
  for(const k in map){ const [tab,panel]=map[k]; $(tab).classList.toggle('active',k===kind); $(tab).setAttribute('aria-selected',k===kind?'true':'false'); $(panel).hidden=k!==kind; }
  $('btnInsertQuote').disabled=!(state.activeNoteDraftId && state.selectedAnno);
}

/* ---------------- Translation ---------------- */
function bindTranslationControls(){
  $('chkTranslate').addEventListener('change',()=>{
    state.translateEnabled=$('chkTranslate').checked;
    lsSet(TRANS_KEY,JSON.stringify({enabled:state.translateEnabled}));
    renderStateChips();
    if(state.translateEnabled){ const text=selectedTranslationText(); if(text) openTranslate(text); }
  });
  $('btnTranslateSel').addEventListener('click',translateSelection);
  $('btnTranslationSetup').addEventListener('click',()=>$('settingsDialog').showModal());
  // Keep the PDF range intact for mouse, pen and touch popup actions.
  $('selPopup').addEventListener('pointerdown',e=>{ if(e.target.closest('button')) e.preventDefault(); });
  $('selPopup').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; const act=b.dataset.act;
    if(act==='copy'){ const t=getSelectedPdfText(); navigator.clipboard&&navigator.clipboard.writeText(t).then(()=>toast('Copied.','ok')).catch(()=>toast('Copy failed.','error')); hideSelPopup(); }
    else if(act==='translate'){ translateSelection(); hideSelPopup(); }
    else if(act==='highlight'){ createAnnoFromSelection('highlight'); }
    else if(act==='underline'){ createAnnoFromSelection('underline'); }
  });
}
function translationSetupMessage(){
  const c=state.companion;
  if(!c.connected || !c.url || !c.token) return 'Start Paper Reader.cmd on this computer, then open Settings / Connect to connect the local companion. Translation keys stay on the companion.';
  if(!c.status?.translation?.available) return 'Translation is unavailable on the local companion. Configure its DeepSeek API key, restart the companion, then reconnect in Settings / Connect.';
  return '';
}
function translateSelection(){
  const text=selectedTranslationText();
  if(!text){ toast('Select text in the PDF first.','error'); return; }
  state.translateEnabled=true;
  $('chkTranslate').checked=true;
  lsSet(TRANS_KEY,JSON.stringify({enabled:true}));
  openTranslate(text);
}
function openTranslate(text){
  showTab('trans');
  $('transSource').value=(text||getSelectedPdfText()||'').slice(0,4000);
  $('transStatus').textContent='';
  constrainText();
  renderStateChips();
  $('transSource').focus();
}
function constrainText(){ const el=$('transSource'); if(el.value.length>4000) el.value=el.value.slice(0,4000); }
async function doTranslate(){
  const text=$('transSource').value.trim();
  if(!text){ $('transStatus').textContent='Nothing to translate.'; return; }
  if(text.length>4000){ $('transStatus').textContent='Text too long (max 4000 characters).'; return; }
  const c=state.companion;
  const setupMessage=translationSetupMessage();
  if(setupMessage){ $('transStatus').textContent=setupMessage; return; }
  const t=c.status&&c.status.translation;
  $('btnTranslate').disabled=true; $('transStatus').textContent='Translating\u2026';
  try{
    const res=await apiFetch('/api/translate',{method:'POST',body:{text,targetLanguage:'zh-CN',sourceLanguage:'auto'}});
    const out=res&&res.text?res.text:'';
    state.translation={original:text,translated:out,model:res.model||t.model||''};
    const box=$('transResult'); box.hidden=false;
    box.innerHTML='';
    const o=document.createElement('div'); o.className='orig'; o.textContent=text; box.appendChild(o);
    const tr=document.createElement('div'); tr.textContent=out; box.appendChild(tr);
    const m=document.createElement('div'); m.className='hint'; m.textContent=res.model?('Model: '+res.model):''; box.appendChild(m);
    $('btnAddTransToNote').disabled=false;
    $('transStatus').textContent='Done.';
  }catch(e){ $('transStatus').textContent='Translation failed: '+e.message; }
  finally{ $('btnTranslate').disabled=false; renderStateChips(); }
}
function addTranslationToNote(){
  if(!state.translation) return;
  showTab('notes');
  if(!state.selectedNote) newNote(false);
  const ed=$('noteEditor');
  ed.focus();
  const sel=window.getSelection(); const range=document.createRange(); range.selectNodeContents(ed); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
  const q=document.createElement('div'); q.className='quote-block';
  const orig=document.createElement('div'); orig.textContent=state.translation.original; q.appendChild(orig);
  const tr=document.createElement('div'); tr.textContent=state.translation.translated; q.appendChild(tr);
  const src=document.createElement('div'); src.className='src'; src.textContent='Translation ('+(state.translation.model||'companion')+')'; q.appendChild(src);
  ed.appendChild(q); ed.appendChild(document.createElement('p'));
  scheduleNoteSave();
  toast('Translation added to note.','ok');
}

/* ---------------- Companion / API ---------------- */
async function apiFetch(path,opts={}){
  const c=state.companion;
  if(!c.url) throw new Error('No local companion URL configured');
  if(!c.token) throw new Error('No session token');
  const url=c.url.replace(/\/$/,'')+path;
  const headers={'Authorization':'Bearer '+c.token};
  let body;
  if(opts.body!==undefined){ headers['Content-Type']='application/json'; body=JSON.stringify(opts.body); }
  let res;
  try{
    res=await fetch(url,{method:opts.method||'GET',headers,body,mode:'cors',credentials:'omit',cache:'no-store'});
  }catch(e){
    throw new Error('Could not reach local companion at '+c.url+'. Start it locally, or use Open local reader / export drafts.');
  }
  if(res.status===401) throw new Error('Authorization rejected by local companion (token expired?). Open the local reader again for a fresh token.');
  if(res.status===403) throw new Error('Local companion refused the request (origin or host not allowed).');
  let data=null; try{ data=await res.json(); }catch{}
  if(!res.ok){ const msg=data?.error?.message||data?.message||(typeof data?.error==='string'?data.error:null)||('HTTP '+res.status); throw new Error(msg); }
  return data;
}

async function connectCompanion(url,token,quiet){
  if(!url){ toast('Enter a local companion URL.','error'); return; }
  if(!token){ toast('Enter the per-launch session token.','error'); return; }
  if(token.startsWith('http://')) { try { const sessionLink=new URL(token); token=new URLSearchParams(sessionLink.hash.slice(1)).get('token')||''; url=sessionLink.origin; } catch { toast('Invalid local session link.','error'); return; } }
  if(!token){ toast('The session link does not contain a token. Open the local workspace again.','error'); return; }
  try { const parsed=new URL(url); if(parsed.protocol!=='http:' || !['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname!=='/') throw new Error(); url=parsed.origin; }
  catch { toast('Use a localhost companion address, such as http://127.0.0.1:23120.','error'); return; }
  state.companion.url=url.replace(/\/$/,''); state.companion.token=token; saveToken(token); saveSettings();
  $('connectStatus').textContent='Connecting\u2026';
  try{
    const st=await apiFetch('/api/status');
    state.companion.status=st; state.companion.connected=true;
    if(st.zotero && st.zotero.serverId){
      const prev=state.companion.serverId;
      if(prev && prev!==st.zotero.serverId){
        setStatusMsg('A different Zotero library is open. Use Review new Zotero library before syncing.');
        state.companion.serverMismatch=true;
        await persistLocal({quiet:true});
      }
      if(!prev || prev===st.zotero.serverId) state.companion.serverId=st.zotero.serverId;
    }
    $('connectStatus').textContent='Connected to local companion.';
    renderStateChips();
    if(state.data?.zotero?.parentKey && !state.companion.serverMismatch) await pullFromZotero(true);
    if(!quiet) toast('Connected to local companion.','ok');
  }catch(e){
    state.companion.connected=false; state.companion.status=null;
    $('connectStatus').textContent='Connection failed: '+e.message;
    renderStateChips();
    if(!quiet) toast('Connection failed: '+e.message,'error');
  }
}
function disconnectCompanion(){
  state.companion.connected=false; state.companion.status=null; state.companion.token=null; saveToken(null);
  $('connectStatus').textContent='Disconnected.';
  $('tokenInput').value='';
  renderStateChips();
}

/* Pull fresh remote, keeping drafts. Does not overwrite pending items. */
async function pullFromZotero(quiet){
  await flushNoteSave();
  if(!state.companion.connected){ toast('Connect the local companion first.','error'); return; }
  if(!state.fileId && state.fileId!==0){ toast('No paper id.','error'); return; }
  const c=state.companion;
  if(c.serverMismatch){ setSyncState('error','Different Zotero library: use Review new Zotero library. Drafts retained.'); return; }
  try{
    const remote=await apiFetch('/api/papers/'+encodeURIComponent(state.fileId));
    if(!remote){ throw new Error('Empty response from companion'); }
    if(remote.serverId && c.serverId && remote.serverId!==c.serverId){
      setStatusMsg('Zotero server identity changed; previous baselines invalid. Review local drafts carefully.');
      state.companion.serverMismatch=true;
      await persistLocal({quiet:true});
      throw new Error('A different Zotero library is open. Drafts were retained; export them before relinking this paper.');
    }
    if(remote.serverId) c.serverId=remote.serverId;
    const conflicts=findRemoteConflicts(remote);
    mergeRemote(remote);
    state.conflicts=conflicts;
    if(conflicts.length) openConflicts(conflicts);
    state.snapRevision=remote.revision||state.snapRevision;
    if(remote.live===false) setSyncState('snapshot','This paper is not linked to a live Zotero attachment.');
    else if(!state.pending.length) setSyncState('synced','Pulled from Zotero');
    else setSyncState('draft','Pulled remote; local drafts kept unsynced');
    persistLocal({quiet:true});
    renderAllOverlays(); renderPanels(); refreshActiveEditor();
    if(!quiet) toast('Pulled from Zotero. Local drafts were kept.','ok');
  }catch(e){ toast('Pull failed: '+e.message,'error'); setSyncState('error','Pull failed: '+e.message); }
}

function findRemoteConflicts(remote){
  if(remote.stale || !Array.isArray(remote.annotations) || !Array.isArray(remote.notes)) throw new Error('Incomplete Zotero snapshot; drafts retained.');
  const byKey=new Map([...remote.annotations.map(normalizeAnno),...remote.notes.map(normalizeNote)].map(item=>[item.key||item.id,item]));
  return state.pending.flatMap(p=>{
    const fresh=byKey.get(p.key||state.keyMap[p.id]||p.id)||null;
    const base=state.baselines[p.id];
    if(p.action==='create'&&!fresh) return [];
    if(p.action!=='create'&&base&&fresh&&fresh.kind===p.kind&&sameEditable(base.value,fresh,p.kind)) return [];
    return [{id:p.id,kind:p.kind,local:p.action==='delete'?null:p.value,remote:fresh,reason:!fresh?'Original object is absent in Zotero':(!base?'No matching original baseline':'Changed locally and in Zotero')}];
  });
}

async function reconcileLibrary(){
  if(syncing){ toast('Wait for Sync to finish before reviewing the library.','error'); return; }
  if(!state.companion.connected){ toast('Connect the local companion first.','error'); return; }
  try{
    await flushNoteSave();
    const remote=await apiFetch('/api/papers/'+encodeURIComponent(state.fileId));
    if(!remote?.serverId || remote.live!==true) throw new Error('A fresh verified live Zotero snapshot is required.');
    const conflicts=findRemoteConflicts(remote);
    mergeRemote(remote);
    state.companion.serverId=remote.serverId;
    state.companion.serverMismatch=false;
    state.conflicts=conflicts;
    await persistLocal({quiet:true});
    renderAllOverlays(); renderPanels(); refreshActiveEditor();
    if(conflicts.length) openConflicts(conflicts);
    setSyncState(state.pending.length?'draft':'synced',conflicts.length?'Library reviewed. Resolve conflicts before Sync.':'Library reviewed. Local drafts retained; Sync remains a separate action.');
    toast(conflicts.length?'Review the conflicts; nothing was written to Zotero.':'Library reviewed. Nothing was written to Zotero.','ok');
  }catch(e){ await persistLocal({quiet:true}); setSyncState('error','Library review failed: '+e.message); toast('Library review failed; drafts retained. '+e.message,'error'); }
}

function mergeRemote(remote){
  if(remote.stale || !Array.isArray(remote.annotations) || !Array.isArray(remote.notes)) throw new Error('Incomplete Zotero snapshot; local drafts and baselines were retained.');
  state.liveSnapshot=remote;
  const rAnnos=(remote.annotations||[]).map(normalizeAnno);
  const rNotes=(remote.notes||[]).map(normalizeNote);
  for(const note of rNotes){ const old=state.notes.find(n=>(n.key||n.id)===(note.key||note.id)); if(old && old.html===note.html && old.displayHtml) note.displayHtml=old.displayHtml; }
  const remoteByKey=new Map([...rAnnos,...rNotes].map(item=>[item.key||item.id,item]));
  for(const pending of state.pending){
    if(pending.action==='create') continue;
    const base=state.baselines[pending.id];
    const fresh=remoteByKey.get(pending.key||state.keyMap[pending.id]||pending.id);
    if(base && fresh && sameEditable(base.value,fresh,pending.kind)){
      state.baselines[pending.id]=liveBaseline(Object.assign({},fresh,{id:pending.id}),pending.kind);
      pending.key=fresh.key; pending.baseVersion=fresh.version; pending.baseContentHash=contentHashOf(fresh);
    }
  }
  // Prefer fresh remote for unmodified items; keep local pending ones from being wiped.
  const pendingAnno=state.pending.filter(p=>p.kind==='annotation');
  const pendingNotes=state.pending.filter(p=>p.kind==='note');
  const pendingAnnoIds=new Set(pendingAnno.map(p=>p.id));
  const pendingNoteIds=new Set(pendingNotes.map(p=>p.id));
  const localAnnoById=new Map(state.annotations.map(a=>[a.id,a]));
  const mergedAnnos=[];
  for(const a of rAnnos){
    if(pendingAnnoIds.has(a.id)){ const change=pendingAnno.find(p=>p.id===a.id); if(change.action==='delete') continue; const loc=localAnnoById.get(a.id); mergedAnnos.push(loc||a); }
    else mergedAnnos.push(a);
  }
  for(const a of state.annotations){ if(pendingAnnoIds.has(a.id) && !mergedAnnos.find(x=>x.id===a.id)) mergedAnnos.push(a); }
  const localNotesById=new Map(state.notes.map(n=>[n.id,n]));
  const mergedNotes=[];
  for(const n of rNotes){ if(pendingNoteIds.has(n.id)){ const change=pendingNotes.find(p=>p.id===n.id); if(change.action==='delete') continue; const loc=localNotesById.get(n.id); mergedNotes.push(loc||n); } else mergedNotes.push(n); }
  for(const n of state.notes){ if(pendingNoteIds.has(n.id) && !mergedNotes.find(x=>x.id===n.id)) mergedNotes.push(n); }
  state.annotations=mergedAnnos; state.notes=mergedNotes;
  // Update baselines for non-pending items, preserve existing baselines for pending
  for(const a of rAnnos){ if(!pendingAnnoIds.has(a.id)) state.baselines[a.id]=liveBaseline(a,'annotation'); }
  for(const n of rNotes){ if(!pendingNoteIds.has(n.id)) state.baselines[n.id]=liveBaseline(n,'note'); }
}

/* Sync */
let syncing=false;
async function syncNow(){
  if(syncing) return;
  if(!state.companion.connected || !state.companion.token){ toast('Connect the local companion before syncing.','error'); return; }
  if(state.companion.serverMismatch){ toast('Server identity changed. Pull from Zotero and reconcile before writing.','error'); return; }
  if(state.conflicts.length){ openConflicts(state.conflicts); toast('Resolve or export existing conflicts before syncing.','error'); return; }
  syncing=true; $('btnSync').disabled=true; setStatusMsg('Syncing\u2026');
  try{
    await flushNoteSave();
    if(!state.pending.length){ toast('No local changes to sync.'); return; }
    await pullFromZotero(true);
    if(state.syncState==='error' || state.companion.serverMismatch || state.conflicts.length) return;
    const operationId=uuid();
    const changes=state.pending.map(p=>{
      const ch={action:p.action,kind:p.kind,id:p.id};
      const key=p.key||state.keyMap[p.id]; if(key) ch.key=key;
      const b=state.baselines[p.id];
      if(p.baseVersion!=null) ch.baseVersion=p.baseVersion; else if(b&&b.version!=null) ch.baseVersion=b.version;
      const hash=p.baseContentHash||b&&b.contentHash; if(/^[a-f0-9]{64}$/.test(hash||'')) ch.baseContentHash=hash;
      if(p.action!=='delete') ch.value=JSON.parse(JSON.stringify(p.value));
      return ch;
    });
    const res=await apiFetch('/api/papers/'+encodeURIComponent(state.fileId)+'/sync',{method:'POST',body:{serverId:state.companion.serverId,operationId,changes}});
    handleSyncResponse(res,changes);
  }catch(e){
    setSyncState('error','Sync failed: '+e.message); toast('Sync failed; drafts retained. '+e.message,'error',6000);
  }finally{ syncing=false; $('btnSync').disabled=false; }
}
function handleSyncResponse(res,changes){
  const applied=res.applied||[]; const conflicts=res.conflicts||[]; const failed=res.failed||[];
  const appliedBy={}; for(const a of applied) appliedBy[a.id+'|'+a.kind]=a;
  const snapshotGood=res.snapshot&&!res.snapshot.stale&&Array.isArray(res.snapshot.annotations)&&Array.isArray(res.snapshot.notes);
  for(const ch of changes){
    const a=appliedBy[ch.id+'|'+ch.kind];
    if(a){
      if(a.key) state.keyMap[ch.id]=a.key;
      const current=state.pending.find(p=>p.id===ch.id&&p.kind===ch.kind);
      const newer=current && (current.action!==ch.action || ch.action!=='delete' && !sameEditable(current.value,ch.value,ch.kind));
      if(!newer) removePending(ch.id,ch.kind);
      const item=(ch.kind==='annotation'?state.annotations:state.notes).find(x=>x.id===ch.id);
      if(item){ item.local=false; if(a.key) item.key=a.key; if(a.version!=null) item.version=a.version; }
      if(ch.action==='delete'){ delete state.baselines[ch.id]; delete state.tombstones[ch.id]; }
      else {
        const fresh=snapshotGood?(ch.kind==='annotation'?res.snapshot.annotations:res.snapshot.notes).find(x=>(x.key||x.id)===a.key):null;
        const baseline=fresh?liveBaseline(Object.assign({},fresh,{id:ch.id}),ch.kind):{id:ch.id,kind:ch.kind,key:a.key,version:a.version??null,contentHash:null,value:JSON.parse(JSON.stringify(ch.value)),at:new Date().toISOString()};
        state.baselines[ch.id]=baseline;
        if(newer){ current.action=current.action==='delete'?'delete':'update'; current.key=a.key; current.baseVersion=baseline.version; current.baseContentHash=baseline.contentHash; if(item) item.local=true; }
        if(a.key && a.key!==ch.id){
          if(item) item.id=a.key;
          for(const p of state.pending) if(p.id===ch.id&&p.kind===ch.kind) p.id=a.key;
          state.baselines[a.key]=Object.assign({},baseline,{id:a.key}); delete state.baselines[ch.id];
          if(state.selectedNote===ch.id) state.selectedNote=a.key;
          if(state.activeNoteDraftId===ch.id) state.activeNoteDraftId=a.key;
          if(state.selectedAnno===ch.id) state.selectedAnno=a.key;
        }
      }
      if(a.action==='delete'||ch.action==='delete') delete state.tombstones[ch.id];
    }
  }
  if(snapshotGood){ mergeRemote(res.snapshot); refreshActiveEditor(); }
  persistLocal({quiet:true});
  renderAllOverlays(); renderPanels();
  if(conflicts.length){ openConflicts(conflicts); setSyncState('draft','Conflicts need resolution; unsynced drafts kept'); }
  else if(failed.length){ setSyncState('error',`${failed.length} item(s) failed; drafts retained`); toast(failed.length+' change(s) could not be synced; drafts retained.','error'); }
  else if(state.pending.length){ setSyncState('draft',`${state.pending.length} local change(s) remaining`); }
  else if(!snapshotGood) setSyncState('error','Writes returned, but a fresh Zotero snapshot is unavailable. Pull again to confirm the current state.');
  else setSyncState('synced','Synced with Zotero');
  if(conflicts.length===0 && failed.length===0 && snapshotGood) toast('Sync complete.','ok');
}

function openConflicts(conflicts){
  state.conflicts=conflicts;
  persistLocal({quiet:true});
  const list=$('conflictList'); list.innerHTML='';
  for(const c of conflicts){
    const item=document.createElement('div'); item.className='conflict-item';
    const h=document.createElement('h3'); h.textContent=(c.kind||'item')+' '+String(c.id).slice(0,8)+' - '+(c.reason||'changed on both sides'); item.appendChild(h);
    const cols=document.createElement('div'); cols.className='conflict-cols';
    const lc=document.createElement('div'); lc.className='col'; const lh=document.createElement('h4'); lh.textContent='Your local draft'; lc.appendChild(lh); const lv=document.createElement('div'); lv.textContent=summarize(c.local); lc.appendChild(lv); cols.appendChild(lc);
    const rc=document.createElement('div'); rc.className='col'; const rh=document.createElement('h4'); rh.textContent='Zotero (remote)'; rc.appendChild(rh); const rv=document.createElement('div'); rv.textContent=summarize(c.remote); rc.appendChild(rv); cols.appendChild(rc);
    item.appendChild(cols);
    const acts=document.createElement('div'); acts.className='conflict-actions';
    const keep=document.createElement('button'); keep.type='button'; keep.className='btn small primary'; keep.textContent='Keep local (rebase)'; keep.addEventListener('click',()=>resolveConflict(c,'local')); acts.appendChild(keep);
    const use=document.createElement('button'); use.type='button'; use.className='btn small'; use.textContent='Use Zotero'; use.addEventListener('click',()=>resolveConflict(c,'remote')); acts.appendChild(use);
    const defer=document.createElement('button'); defer.type='button'; defer.className='btn small'; defer.textContent='Defer'; defer.addEventListener('click',()=>{ item.remove(); toast('Conflict deferred; nothing overwritten.'); }); acts.appendChild(defer);
    item.appendChild(acts); list.appendChild(item);
  }
  if(!list.children.length){ const p=document.createElement('p'); p.className='hint'; p.textContent='No conflicts remaining.'; list.appendChild(p); }
  if(!$('conflictDialog').open) $('conflictDialog').showModal();
}
function summarize(v){
  if(v==null) return '(none)';
  if(typeof v==='string') return v.slice(0,400);
  if(v.html) { const t=document.createElement('div'); t.innerHTML=sanitizeHtml(v.html); return t.textContent.slice(0,400); }
  if(v.text||v.comment) return [v.text,v.comment].filter(Boolean).join(' / ').slice(0,400);
  try{ return JSON.stringify(v).slice(0,400); }catch{ return String(v); }
}
function resolveConflict(c,choice){
  const candidate=state.pending.find(p=>p.id===c.id);
  const kind=c.kind||candidate&&candidate.kind||(c.local&&Object.hasOwn(c.local,'html')?'note':'annotation');
  const id=c.id;
  const idxPending=state.pending.findIndex(p=>p.id===id&&p.kind===kind);
  if(choice==='remote'){
    const remoteVal=c.remote;
    const items=kind==='note'?state.notes:state.annotations;
    const i=items.findIndex(item=>item.id===id);
    if(remoteVal){ const value=(kind==='note'?normalizeNote:normalizeAnno)(Object.assign({},remoteVal,{id})); if(i>=0) items[i]=value; else items.push(value); }
    else if(i>=0) items.splice(i,1);
    delete state.tombstones[id];
    if(idxPending>=0) state.pending.splice(idxPending,1);
    if(remoteVal){ state.baselines[id]={id,kind,key:(remoteVal.key||null),version:remoteVal.version??null,contentHash:(remoteVal.contentHash||null),value:remoteVal,at:new Date().toISOString()}; }
    else { delete state.baselines[id]; }
    toast('Used Zotero version for '+String(id).slice(0,8)+'.','ok');
  } else {
    // Keep local and rebase to remote version/hash
    const remoteVal=c.remote;
    if(!remoteVal || !remoteVal.key || !Number.isInteger(remoteVal.version)) { toast('The original Zotero object is unavailable. Keep the draft or export it; it will not be recreated automatically.','error'); return; }
    if(idxPending>=0){
      state.pending[idxPending].baseVersion=remoteVal.version!=null?remoteVal.version:undefined;
      state.pending[idxPending].baseContentHash=contentHashOf(remoteVal);
      state.pending[idxPending].key=remoteVal.key;
      if(state.pending[idxPending].action==='create') state.pending[idxPending].action='update';
    }
    state.baselines[id]={id,kind,key:(remoteVal.key||null),version:remoteVal.version??null,contentHash:(remoteVal.contentHash||contentHashOf(remoteVal)),value:remoteVal,at:new Date().toISOString()};
    toast('Kept local; draft rebased and will be sent on next Sync.','ok');
  }
  state.conflicts=state.conflicts.filter(entry=>entry!==c);
  persistLocal({quiet:true}); renderAllOverlays(); renderPanels(); refreshActiveEditor();
  if(state.conflicts.length) openConflicts(state.conflicts);
  else $('conflictDialog').close();
  setSyncState(state.pending.length?'draft':'synced', state.pending.length?'Local drafts remaining':'Synced with Zotero');
}

/* Authorize */
async function authorizeZotero(){
  if(!state.companion.connected){ toast('Connect the local companion first.','error'); return; }
  try{
    const r=await apiFetch('/api/zotero/authorize',{method:'POST',body:{}});
    toast('Authorization requested. Allow access in the Zotero dialog.','ok',6000);
    setTimeout(async()=>{ try{ const st=await apiFetch('/api/status'); state.companion.status=st; renderStateChips(); $('connectStatus').textContent='Status refreshed after authorization.'; }catch{} },1500);
  }catch(e){ toast('Authorization failed: '+e.message,'error'); }
}

/* ---------------- Draft export / import ---------------- */
async function exportDrafts(){
  await flushNoteSave();
  await persistLocal({quiet:true});
  const out={schemaVersion:1,kind:'plr-drafts',exportedAt:new Date().toISOString(),fileId:state.fileId,state:null};
  try{ out.state=await storeGet(paperKey(state.fileId,'state'))||{pending:state.pending,baselines:state.baselines,tombstones:state.tombstones,keyMap:state.keyMap}; }catch{ out.state={pending:state.pending}; }
  // safety: include current in-memory drafts too
  out.current={annotations:state.annotations,notes:state.notes,pending:state.pending,baselines:state.baselines};
  const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`paper-${state.fileId}-drafts-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast('Drafts exported. Keep this file to transfer to the local reader.','ok');
}
function validateDraftDocument(parsed){
  const forbidden=new Set(['__proto__','constructor','prototype']);
  const visit=(value,depth=0)=>{
    if(depth>60) throw new Error('Draft structure is too deeply nested');
    if(!value||typeof value!=='object') return;
    for(const key of Object.keys(value)){ if(forbidden.has(key)) throw new Error('Unsafe draft property'); visit(value[key],depth+1); }
  };
  visit(parsed);
  if(!parsed||parsed.schemaVersion!==1||parsed.kind!=='plr-drafts') throw new Error('Unsupported reader drafts schema');
  if(!Number.isSafeInteger(parsed.fileId)||parsed.fileId!==state.fileId) throw new Error('Drafts file belongs to a different paper');
  const validId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)&&!forbidden.has(id);
  const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
  for(const source of [parsed.state,parsed.current]){
    if(source===undefined||source===null) continue;
    if(!record(source)) throw new Error('Invalid draft state');
    for(const key of ['baselines','tombstones','keyMap']) if(source[key]!==undefined){
      if(!record(source[key])||Object.keys(source[key]).some(id=>!validId(id))) throw new Error('Invalid draft identity map');
    }
    for(const key of (source===parsed.current?['pending','notes','annotations','conflicts']:['pending','conflicts'])) if(source[key]!==undefined){
      if(!Array.isArray(source[key])||source[key].length>10000) throw new Error('Invalid draft item list');
      const ids=new Set();
      for(const item of source[key]){
        if(!record(item)||!validId(item.id)||ids.has(item.id)) throw new Error('Invalid or duplicate draft item ID');
        ids.add(item.id);
        if(key==='pending'&&(!['note','annotation'].includes(item.kind)||!['create','update','delete'].includes(item.action)||item.action!=='delete'&&!record(item.value))) throw new Error('Invalid pending change');
        if(key==='conflicts'&&!['note','annotation'].includes(item.kind)) throw new Error('Invalid conflict kind');
        if(item.baseVersion!=null&&(!Number.isSafeInteger(item.baseVersion)||item.baseVersion<0)) throw new Error('Invalid original item version');
        if(item.key!=null&&!/^[A-Z0-9]{8}$/.test(item.key)) throw new Error('Invalid Zotero item key');
      }
    }
    for(const [id,baseline] of Object.entries(source.baselines||{})){
      if(!record(baseline)||!['note','annotation'].includes(baseline.kind)||!record(baseline.value)||baseline.id!==id) throw new Error('Invalid draft baseline');
    }
    if(source.serverId!=null&&typeof source.serverId!=='string') throw new Error('Invalid library identity');
    if(Object.values(source.keyMap||{}).some(key=>typeof key!=='string'||!/^[A-Z0-9]{8}$/.test(key))) throw new Error('Invalid Zotero key map');
  }
  if(!parsed.state&&!parsed.current) throw new Error('Draft state is missing');
}
function draftPair(change,baseline){
  return stableJson({action:change?.action,kind:change?.kind,key:change?.key||null,value:change?.value||null,baseVersion:change?.baseVersion??null,baseContentHash:change?.baseContentHash||null,baseline:baseline?{key:baseline.key||null,version:baseline.version??null,contentHash:baseline.contentHash||null,value:baseline.value}:null});
}
async function importDrafts(file){
  try{
    const text=await file.text(); if(text.length>20*1024*1024) throw new Error('File too large');
    const parsed=JSON.parse(text);
    validateDraftDocument(parsed);
    await flushNoteSave();
    const imports=parsed.state||{}, current=parsed.current||{};
    const pending=current.pending??imports.pending??[];
    const baselines=Object.assign({},imports.baselines||{},current.baselines||{});
    const existingById=new Map(state.pending.map(p=>[p.id,p]));
    // Validate the complete merge before changing any queue, baseline, or object.
    for(const p of pending){
      const existing=existingById.get(p.id);
      if(existing&&draftPair(existing,state.baselines[p.id])!==draftPair(p,baselines[p.id])) throw new Error('Item '+p.id+' has different local edits or baseline. Existing drafts were kept. Export both versions and resolve them separately before importing.');
      const baseline=baselines[p.id];
      if(baseline&&baseline.kind!==p.kind) throw new Error('Draft kind does not match its baseline');
      if(baseline?.key&&p.key&&baseline.key!==p.key) throw new Error('Draft key does not match its baseline');
    }
    for(const [id,tombstone] of Object.entries(imports.tombstones||{})){
      if(!tombstone||tombstone.id!==id||!['note','annotation'].includes(tombstone.kind)) throw new Error('Invalid deletion recovery record');
      if(state.tombstones[id]&&stableJson(state.tombstones[id])!==stableJson(tombstone)) throw new Error('Different local deletion for '+id+'. Export both versions before importing.');
    }
    for(const conflict of imports.conflicts||[]){
      const existing=state.conflicts.find(c=>c.id===conflict.id);
      if(existing&&stableJson(existing)!==stableJson(conflict)) throw new Error('Different unresolved conflict for '+conflict.id+'. Export both versions before importing.');
    }
    const additions={annotation:new Map(),note:new Map()};
    for(const kind of ['annotation','note']){
      const plural=kind==='note'?'notes':'annotations';
      const objects=[...(imports.liveSnapshot?.[plural]||[]),...(current[plural]||[])];
      for(const object of objects){
        if(!object||typeof object!=='object'||typeof object.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(object.id)||['constructor','prototype','__proto__'].includes(object.id)) throw new Error('Invalid restored object');
        if(kind==='note'&&typeof object.html!=='string'||kind==='annotation'&&typeof object.type!=='string') throw new Error('Invalid restored item content');
        additions[kind].set(object.id,JSON.parse(JSON.stringify(object)));
      }
      for(const p of pending.filter(p=>p.kind===kind)){
        if(p.action==='delete') continue;
        const seed=additions[kind].get(p.id)||baselines[p.id]?.value;
        const object=Object.assign({},seed||{},p.value,{id:p.id,key:p.key||seed?.key||null,local:true});
        if(kind==='note'&&typeof object.html!=='string'||kind==='annotation'&&(typeof object.type!=='string'||!object.position||!Array.isArray(object.position.rects))) throw new Error('Missing original object for '+p.id+'. Export again from the source browser with its current draft.');
        additions[kind].set(p.id,object);
      }
    }
    for(const p of pending) if(!existingById.has(p.id)){
      state.pending.push(p);
      if(baselines[p.id]) state.baselines[p.id]=baselines[p.id];
      if(imports.tombstones?.[p.id]) state.tombstones[p.id]=imports.tombstones[p.id];
      if(imports.keyMap?.[p.id]) state.keyMap[p.id]=imports.keyMap[p.id];
    }
    for(const [id,tombstone] of Object.entries(imports.tombstones||{})) if(!state.tombstones[id]&&!existingById.has(id)){
      state.tombstones[id]=tombstone;
      if(baselines[id]) state.baselines[id]=baselines[id];
    }
    for(const conflict of imports.conflicts||[]) if(!state.conflicts.some(c=>c.id===conflict.id)) state.conflicts.push(conflict);
    for(const kind of ['annotation','note']){
      const items=kind==='note'?state.notes:state.annotations;
      for(const [id,object] of additions[kind]){
        if(existingById.has(id)) continue;
        const index=items.findIndex(item=>item.id===id);
        if(index<0||pending.some(p=>p.id===id&&p.kind===kind)){
          const value=(kind==='note'?normalizeNote:normalizeAnno)(object);
          if(index<0) items.push(value); else items[index]=value;
          if(baselines[id]) state.baselines[id]=baselines[id];
        }
      }
    }
    // Keep a pristine recovery snapshot: pending values must never become the
    // original used by Revert view. Current values are persisted separately.
    const original=state.liveSnapshot||state.data||{};
    const recovered=Object.assign({},original);
    for(const kind of ['annotation','note']){
      const plural=kind==='note'?'notes':'annotations';
      const originals=new Map((original[plural]||[]).map(item=>[item.id||item.key,item]));
      for(const p of state.pending.filter(p=>p.kind===kind)){
        const baseline=state.baselines[p.id];
        if(!originals.has(p.id)&&baseline?.value) originals.set(p.id,baseline.value);
      }
      for(const [id,object] of additions[kind]) if(!originals.has(id)&&!state.pending.some(p=>p.id===id)) originals.set(id,object);
      recovered[plural]=Array.from(originals.values());
    }
    state.liveSnapshot=recovered;
    if(imports.serverId&&state.companion.serverId&&imports.serverId!==state.companion.serverId) state.companion.serverMismatch=true;
    else if(!state.companion.serverId&&imports.serverId) state.companion.serverId=imports.serverId;
    if(imports.serverMismatch) state.companion.serverMismatch=true;
    applyLocalToSnapshot();
    if(!currentNote()&&state.notes.length) state.selectedNote=state.notes[0].id;
    await persistLocal({quiet:true});
    renderAllOverlays(); renderPanels(); refreshActiveEditor();
    if(state.pending.length) setSyncState('draft','Drafts imported; local changes pending');
    toast('Drafts imported. Use Sync with Zotero from the local reader when ready.','ok',6000);
  }catch(e){ toast('Import failed: '+e.message,'error'); }
}

/* ---------------- Panels render ---------------- */
function renderPanels(){ renderAnnoList(); renderNoteList(); renderNoteSelect(); $('btnUndoDelete').disabled=!Object.values(state.tombstones).some(t=>t.value); }

/* ---------------- PDF error ---------------- */
function showPdfError(msg){ updatePdfError(msg); }
function updatePdfError(msg){
  const el=$('pdfError');
  if(!msg){ el.hidden=true; el.textContent=''; return; }
  el.hidden=false; el.innerHTML='';
  const p=document.createElement('p'); p.textContent=msg; el.appendChild(p);
  const library=document.createElement('a'); library.className='btn'; library.href='../index.html'; library.textContent='Choose from library'; el.appendChild(library);
  if(!state.paper) return;
  const local=document.createElement('button'); local.type='button'; local.className='btn'; local.textContent='Open local reader'; local.addEventListener('click',()=>window.open(localReaderUrl(),'_blank','noopener')); el.appendChild(local);
  const direct=$('pdfDirect').cloneNode(true); direct.className='btn'; direct.textContent='Open PDF directly'; el.appendChild(direct);
  const exp=document.createElement('button'); exp.type='button'; exp.className='btn'; exp.textContent='Export drafts (JSON)'; exp.addEventListener('click',exportDrafts); el.appendChild(exp);
}
function localReaderUrl(){
  const base=(state.companion.url||'http://127.0.0.1:23120').replace(/\/$/,'');
  return base+'/reader/?id='+(state.fileId!=null?state.fileId:'')+(state.companion.token?'#token='+encodeURIComponent(state.companion.token):'');
}

/* ---------------- Events ---------------- */
function bindEvents(){
  setupDivider();
  window.addEventListener('beforeunload',()=>{ flushNoteSaveSync(); persistLocal({quiet:true}); });
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) { flushNoteSaveSync(); persistLocal({quiet:true}); } });
  window.addEventListener('resize',debounce(()=>{ applySplit(); if(state.fitMode) requestRerender(); else reRenderAll(); updateCurrentPageFromScroll(); },250));
  ['tabAnno','tabNotes','tabTrans'].forEach(id=>$(id).addEventListener('click',()=>showTab(id==='tabAnno'?'anno':id==='tabNotes'?'notes':'trans')));
  $('btnPrev').addEventListener('click',()=>goToPage(state.curPage-1));
  $('btnNext').addEventListener('click',()=>goToPage(state.curPage+1));
  $('btnFirst').addEventListener('click',()=>goToPage(1));
  $('btnLast').addEventListener('click',()=>goToPage(state.numPages));
  $('pageInput').addEventListener('change',()=>{ const v=parseInt($('pageInput').value,10); if(!Number.isFinite(v)||v<1||v>state.numPages){ toast('Enter a page between 1 and '+(state.numPages||'?'),'error'); $('pageInput').value=state.curPage; return; } goToPage(v); });
  $('pageInput').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('pageInput').blur(); $('pageInput').dispatchEvent(new Event('change')); } });
  $('btnZoomIn').addEventListener('click',()=>setZoom(state.scale*1.15));
  $('btnZoomOut').addEventListener('click',()=>setZoom(state.scale/1.15));
  $('btnFitWidth').addEventListener('click',()=>chooseFit('width'));
  $('btnFitPage').addEventListener('click',()=>chooseFit('page'));
  $('btnRotate').addEventListener('click',rotatePage);
  $('btnHighlight').addEventListener('click',()=>{ if(getSelectedPdfText()){ state.lastSelection=collectSelectionRects(); createAnnoFromSelection('highlight'); } else { toast('Select text in the PDF, then press Highlight.','error'); } });
  $('btnUnderline').addEventListener('click',()=>{ if(getSelectedPdfText()){ state.lastSelection=collectSelectionRects(); createAnnoFromSelection('underline'); } else { toast('Select text in the PDF, then press Underline.','error'); } });
  $('btnPointNote').addEventListener('click',togglePointNote);
  $('btnUndoDelete').addEventListener('click',undoLocalDeletion);
  $('btnCopy').addEventListener('click',async()=>{ const t=getSelectedPdfText(); if(!t){ toast('Select text first.','error'); return; } try{ await navigator.clipboard.writeText(t); toast('Copied selected text.','ok'); }catch{ toast('Copy failed; select and copy manually.','error'); } });
  bindTranslationControls();
  document.addEventListener('selectionchange',()=>{ if(!state.pdf) return; const sel=window.getSelection(); if(!sel||sel.isCollapsed){ hideSelPopup(); return; } const an=sel.anchorNode; if(an && pageElementFromNode(an)) handleSelectionEnd(); });
  document.addEventListener('mousedown',e=>{ if(!$('selPopup').hidden && !$('selPopup').contains(e.target)){ const inPdf=pageElementFromNode(e.target); if(!inPdf) hideSelPopup(); } });
  $('pdfScroll').addEventListener('click',e=>{ if(pointToolActive){ placePointNote(e.clientX,e.clientY); return; } });
  $('pdfScroll').addEventListener('scroll',debounce(()=>{ updateCurrentPageFromScroll(); },150));
  $('pdfScroll').addEventListener('pointerup',()=>{ if(pointToolActive){ /* click handler already placed note */ } handleSelectionEnd(); });
  const noteEditor=$('noteEditor');
  noteEditor.addEventListener('input',()=>{ scheduleNoteSave(); });
  noteEditor.addEventListener('focus',()=>{ if(state.selectedNote) state.activeNoteDraftId=state.selectedNote; $('btnInsertQuote').disabled=!(state.activeNoteDraftId && state.selectedAnno); });
  noteEditor.addEventListener('paste',e=>{ e.preventDefault(); const text=(e.clipboardData||window.clipboardData).getData('text/plain'); if(text) document.execCommand('insertText',false,text); });
  document.querySelectorAll('.note-toolbar [data-cmd]').forEach(btn=>{
    btn.addEventListener('click',()=>{ const cmd=btn.dataset.cmd; noteEditor.focus(); try{ if(cmd==='createLink'){ const url=prompt('Link URL:'); if(url) document.execCommand('createLink',false,url); } else document.execCommand(cmd,false,null); }catch{} scheduleNoteSave(); });
  });
  $('noteBlock').addEventListener('change',()=>{ const v=$('noteBlock').value; noteEditor.focus(); try{ document.execCommand('formatBlock',false,v); }catch{} scheduleNoteSave(); });
  $('btnNewNote').addEventListener('click',()=>newNote(true));
  $('btnDeleteNote').addEventListener('click',()=>deleteNote());
  $('noteSelect').addEventListener('change',()=>{ const id=$('noteSelect').value; if(id) selectNote(id); });
  $('btnInsertQuote').addEventListener('click',()=>{ const a=state.annotations.find(x=>x.id===state.selectedAnno); if(a) quoteToNote(a); else toast('Select an annotation first.','error'); });
  $('btnTranslate').addEventListener('click',()=>doTranslate());
  $('transSource').addEventListener('input',()=>{ constrainText(); renderStateChips(); });
  $('btnAddTransToNote').addEventListener('click',()=>addTranslationToNote());
  $('btnInvertPending').addEventListener('click',()=>{ if(!state.pending.length){ toast('No unsynced local changes to revert.','info'); return; } if(!confirm('Discard unsynced local changes and restore the last snapshot? Export drafts first if you want a backup.')) return; state.editorDirty=false; if(state.saveTimer) state.saveTimer.cancel(); state.pending=[]; state.baselines={}; state.tombstones={}; const original=state.liveSnapshot||state.data||{}; state.annotations=(original.annotations||[]).map(normalizeAnno); state.notes=(original.notes||[]).map(normalizeNote); persistLocal({quiet:true}); renderAllOverlays(); renderPanels(); refreshActiveEditor(); setSyncState('snapshot','Reverted view to snapshot'); toast('Local view reverted to snapshot.','ok'); });
  $('btnSettings').addEventListener('click',()=>$('settingsDialog').showModal());
  $('btnConnect').addEventListener('click',()=>{ const url=$('localUrlInput').value.trim(); const tok=$('tokenInput').value.trim(); connectCompanion(url,tok,false); });
  $('btnDisconnect').addEventListener('click',disconnectCompanion);
  $('btnOpenLocal').addEventListener('click',()=>{ window.open(localReaderUrl(),'_blank','noopener'); });
  $('btnCopySession').addEventListener('click',async()=>{ if(!state.companion.token){ toast('Open Paper Reader.cmd first to create a private local session.','error'); return; } try { await navigator.clipboard.writeText(localReaderUrl()); toast('Local session link copied. Keep it private.','ok'); } catch { toast('Clipboard unavailable. Use the local workspace directly.','error'); } });
  $('btnAuthorize').addEventListener('click',authorizeZotero);
  $('btnPull').addEventListener('click',()=>pullFromZotero(false));
  $('btnReconcile').addEventListener('click',reconcileLibrary);
  $('btnSync').addEventListener('click',syncNow);
  $('btnExportDrafts').addEventListener('click',exportDrafts);
  $('draftImportInput').addEventListener('change',e=>{ const f=e.target.files&&e.target.files[0]; if(f) importDrafts(f); e.target.value=''; });
  $('btnConflictClose').addEventListener('click',()=>{ $('conflictDialog').close(); });
}

/* ---------------- Init ---------------- */
function applySavedUi(){ if($('zoomVal')) $('zoomVal').textContent=Math.round(state.scale*100)+'%'; if($('btnFitWidth')) $('btnFitWidth').setAttribute('aria-pressed',state.fitMode==='width'?'true':'false'); if($('btnFitPage')) $('btnFitPage').setAttribute('aria-pressed',state.fitMode==='page'?'true':'false'); const t=$('chkTranslate'); if(t) t.checked=state.translateEnabled; }

function bootstrap(){
  applySavedUi();
  renderPanels();
  renderStateChips();
  boot().catch(e=>{ showPdfError('Initialization failed: '+(e&&e.message?e.message:e)); try{ $('pdfLoading').hidden=true; }catch{} });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bootstrap);
else bootstrap();


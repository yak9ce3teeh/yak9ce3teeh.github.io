/* Runs inside Zotero. No listener, subprocess, database SQL, or external daemon. */
PaperLibraryWeb = (() => {
  'use strict';
  const C=PaperLibraryCore, PREFIX='/paper-library', TTL=8*60*60*1000;
  const sessions=new Map(), mappings=new Map(), hashes=new Map();
  let nativeKey=null, serverId=null, originalResponse=null, responseWrapper=null, stopped=false, busy=false;
  const routes=[];
  const allowedOrigin=origin=>origin===C.ORIGIN;
  const base=()=> 'http://127.0.0.1:'+Zotero.Server.port;
  const data=item=>item?.data||item;
  const guid=()=>Services.uuid.generateUUID().toString().replace(/[{}-]/g,'');
  const itemKey=()=>{const a='23456789ABCDEFGHIJKLMNPQRSTUVWXYZ',bytes=crypto.getRandomValues(new Uint8Array(8));return [...bytes].map(n=>a[n%a.length]).join('');};
  function saveAccess(){
    const active=[...sessions.values()].filter(r=>r.expiresAt>Date.now()).slice(-64);
    Zotero.Prefs.set('paperLibraryWeb.access',JSON.stringify({serverId,nativeKey,sessions:active}));
  }
  function restoreAccess(){
    try{
      const saved=JSON.parse(Zotero.Prefs.get('paperLibraryWeb.access')||'{}');
      if(typeof saved.serverId!=='string')return;
      serverId=saved.serverId;nativeKey=typeof saved.nativeKey==='string'?saved.nativeKey:null;
      for(const r of saved.sessions||[]){
        if(r.url===base()&&r.serverId===serverId&&/^[a-f0-9]{64}$/.test(r.token||'')&&Number.isFinite(r.createdAt)&&Number.isFinite(r.expiresAt)&&r.createdAt<=Date.now()&&r.expiresAt>Date.now()&&r.expiresAt-r.createdAt<=TTL)sessions.set(r.token,r);
      }
    }catch{}
  }
  function sha(value) {
    const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
    const h=Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
    h.init(h.SHA256);h.update(bytes,bytes.length);
    return [...h.finish(false)].map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  }
  function journal() { try {return JSON.parse(Zotero.Prefs.get('paperLibraryWeb.journal')||'{}');} catch {return {};} }
  function remember(id,value) {const j=journal();j[id]=value;const keys=Object.keys(j);for(const old of keys.slice(0,Math.max(0,keys.length-2000)))delete j[old];Zotero.Prefs.set('paperLibraryWeb.journal',JSON.stringify(j));}
  async function native(method,path,body,headers={}) {
    if(!/^\/(?:users\/0\/(?:items|collections)|local\/authorize)(?:[/?]|$)/.test(path) && path!=='/') C.fail('Invalid native API route.');
    const write=!['GET','HEAD'].includes(method);
    if(write && path!=='/local/authorize' && !nativeKey) C.fail('Authorize Zotero in Settings / Connect. Translation remains available.','authorization_required',403);
    const h={'Zotero-API-Version':'3','Zotero-Allowed-Request':'1',...headers};
    if(serverId)h['Zotero-Server-ID']=serverId;
    if(write && nativeKey)h['Zotero-API-Key']=nativeKey;
    const opts={headers:h,successCodes:false,timeout:path==='/local/authorize'?600000:180000,responseType:'text',debug:false,logBodyLength:0};
    if(body!==undefined){h['Content-Type']='application/json';opts.body=JSON.stringify(body);}
    const r=await Zotero.HTTP.request(method,base()+'/api'+path,opts);
    const sid=r.getResponseHeader('Zotero-Server-ID');
    if(serverId && sid && serverId!==sid){nativeKey=null;sessions.clear();mappings.clear();hashes.clear();serverId=sid;saveAccess();C.fail('The Zotero library changed. Connect again.','server_changed',409);}
    if(sid)serverId=sid;
    let result=null;try{result=JSON.parse(r.responseText||'null');}catch{}
    if(r.status===404)return null;
    if(r.status===401){nativeKey=null;saveAccess();C.fail('Zotero write authorization expired. Authorize Zotero in Settings / Connect.','authorization_required',403);}
    if(r.status===403&&write)C.fail('Zotero denied write access to this library.','read_only_library',403);
    if(r.status<200||r.status>=300)C.fail('Zotero rejected the operation ('+r.status+').','zotero_error',r.status===412?409:502);
    return result;
  }
  async function probe() {await native('GET','/');if(!serverId)C.fail('Enable the Zotero local API in Settings → Advanced.','local_api_disabled',503);return serverId;}
  function nativeValidatorAvailable(){return typeof Zotero.Server.LocalAPI?.Item?.prototype?._authenticateWriteRequest==='function';}
  async function validNativeGrant(strict=false){
    // Use Zotero's own local-API validator, without a write request or access
    // to its credential store. Only Always Allow grants are retained here.
    const Endpoint=Zotero.Server.LocalAPI?.Item;
    if(!nativeValidatorAvailable()){
      if(strict)C.fail('This Zotero version cannot validate write authorization. Update Zotero before importing.','authorization_unavailable',503);
      return false;
    }
    if(!nativeKey)return false;
    const request={headers:new (Zotero.getMainWindow().Headers)({'Zotero-API-Key':nativeKey}),searchParams:new URL(base()).searchParams};
    let denied;try{denied=await new Endpoint()._authenticateWriteRequest(request);}catch{
      if(strict)C.fail('Zotero could not validate write authorization. Try again before importing.','authorization_unavailable',503);
      return false;
    }
    if(denied){nativeKey=null;saveAccess();return false;}
    return true;
  }
  async function requireNativeGrant(){
    if(!await validNativeGrant(true))C.fail('Authorize Zotero in Settings / Connect before importing or changing items. Translation remains available.','authorization_required',403);
    if(!Zotero.Libraries.get(Zotero.Libraries.userLibraryID)?.editable)C.fail('This Zotero library is read-only.','read_only_library',403);
  }
  function authorized(request) {
    if(stopped)C.fail('The Zotero extension is stopping.','offline',503);
    const headers=new (Zotero.getMainWindow().Headers)(request.headers),origin=headers.get('Origin');
    if(!allowedOrigin(origin))C.fail('This website is not allowed.','bad_origin',403);
    const token=(headers.get('Authorization')||'').replace(/^Bearer /,'');
    const record=sessions.get(token);
    if(!record || record.expiresAt<=Date.now())C.fail('Connect Zotero from the Paper Library website.','unauthorized',401);
    if((record.origin||C.ORIGIN)!==origin)C.fail('This session belongs to a different website.','bad_origin',403);
    return record;
  }
  function checkServer(value) {if(value!==serverId)C.fail('The Zotero library changed. Reconnect before writing.','server_changed',409);}
  async function authorizeNative() {
    if(await validNativeGrant(true))return {ok:true,authorized:true};
    const result=await native('POST','/local/authorize',{appName:'Paper Library Web'});
    if(!result?.key || !result.remember)C.fail('Choose Always Allow in Zotero to support PDF imports and note synchronization.','authorization_required',403);
    nativeKey=result.key;saveAccess();return {ok:true,authorized:true};
  }
  async function connect(body={},request={}) {
    await probe();
    if(body.authorizeZotero===true)await authorizeNative();
    const origin=new (Zotero.getMainWindow().Headers)(request.headers).get('Origin')||C.ORIGIN;
    const token=guid()+guid(),createdAt=Date.now(),record={url:base(),token,createdAt,expiresAt:createdAt+TTL,serverId,origin};
    for(const [old,r] of sessions)if(r.expiresAt<=createdAt)sessions.delete(old);
    sessions.set(token,record);saveAccess();return {...record,transport:'zotero-addon',schemaVersion:1};
  }
  async function external(url,type='text',accountToken='') {
    for(let redirects=0;redirects<6;redirects++) {
      url=C.remoteUrl(url);
      const response=await Zotero.HTTP.request('GET',url,{responseType:type,followRedirects:false,timeout:90000,successCodes:false,debug:false,logBodyLength:0,headers:{'Cache-Control':'no-cache',...(accountToken?{Authorization:'Bearer '+accountToken}:{})}});
      if([301,302,303,307,308].includes(response.status)) {
        if(accountToken)C.fail('The private paper service redirected.','source_unavailable',502);
        const location=response.getResponseHeader('Location');
        if(!location)C.fail('The paper source returned an invalid redirect.');
        url=C.remoteUrl(new URL(location,url).href);continue;
      }
      if(response.status<200||response.status>=300)C.fail('The paper source returned HTTP '+response.status+'.','source_unavailable',502);
      return type==='arraybuffer'?new Uint8Array(response.response):response.responseText;
    }
    C.fail('The paper source redirected too many times.');
  }
  async function inspect(source) {
    const id=C.arxiv(source);
    if(!id)return {source:C.remoteUrl(source),manual:true};
    const xml=await external('https://export.arxiv.org/api/query?id_list='+encodeURIComponent(id.id+id.version));
    const parser=new (Zotero.getMainWindow().DOMParser)();
    const doc=parser.parseFromString(xml,'application/xml'),entry=doc.getElementsByTagName('entry')[0];
    if(!entry || entry.getElementsByTagName('id')[0]?.textContent.includes('/errors'))C.fail('This arXiv paper was not found.');
    const text=name=>C.clean(entry.getElementsByTagName(name)[0]?.textContent,30000).replace(/\s+/g,' ');
    const exact=C.arxiv(text('id'))||id;
    return {source:'https://arxiv.org/abs/'+exact.id+exact.version,title:text('title'),date:text('published').slice(0,10),authors:[...entry.getElementsByTagName('author')].map(a=>C.clean(a.getElementsByTagName('name')[0]?.textContent,160)),abstract:text('summary'),doi:entry.getElementsByTagNameNS('http://arxiv.org/schemas/atom','doi')[0]?.textContent||'',pdfUrl:'https://arxiv.org/pdf/'+exact.id+exact.version,arxivId:exact.id};
  }
  async function nativeItem(key) {return native('GET','/users/0/items/'+C.key(key));}
  async function children(key,kind='') {return (await native('GET','/users/0/items/'+C.key(key)+'/children?format=json'+(kind?'&itemType='+encodeURIComponent(kind):'')))||[];}
  async function fileBytes(attachment,parent) {
    const wrapped=await nativeItem(attachment),d=data(wrapped);
    if(!d || d.itemType!=='attachment'||d.parentItem!==parent||d.deleted)C.fail('PDF attachment identity is invalid.','wrong_pdf',409);
    const item=await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID,attachment);
    const path=await item?.getFilePathAsync();if(!path)C.fail('The Zotero PDF is not available locally.','missing_pdf',409);
    const stat=await IOUtils.stat(path);
    if(stat.size>C.MAX_PDF)C.fail('PDF exceeds the 50 MB web limit.');
    return IOUtils.read(path);
  }
  async function create(item,identity) {
    const existing=await nativeItem(item.key);
    if(existing){if(data(existing).itemType!==item.itemType || (item.parentItem && data(existing).parentItem!==item.parentItem))C.fail('A reserved key belongs to a different item.','key_conflict',409);return existing;}
    const result=await native('POST','/users/0/items',[item],{'Zotero-Write-Token':guid()});
    const verified=await nativeItem(item.key);
    if(!verified)C.fail('Zotero did not confirm the new item.','write_not_confirmed',502);
    if(identity)remember(identity,{key:item.key,status:'applied'});
    return verified;
  }
  async function collection(category) {
    let parent=false;
    const all=(await native('GET','/users/0/collections?format=json'))||[];
    for(const name of ['Paper Library',...category.split('/')]) {
      let found=all.find(x=>data(x).name===name && (data(x).parentCollection||false)===parent);
      if(!found){const key=itemKey();await native('POST','/users/0/collections',[{key,version:0,name,parentCollection:parent}],{'Zotero-Write-Token':guid()});found={key,data:{key,name,parentCollection:parent}};all.push(found);}
      parent=found.key||data(found).key;
    }
    return parent;
  }
  async function importPaper(body) {
    checkServer(body.serverId);
    await requireNativeGrant();
    if(!/^[a-zA-Z0-9-]{16,100}$/.test(body.requestId||''))C.fail('A valid import request ID is required.');
    const meta=C.metadata(body.metadata),requestHash=sha(C.canonical(meta)),identity='import:'+serverId+':'+body.requestId,prior=journal()[identity];
    if(prior && prior.requestHash!==requestHash)C.fail('This request ID was used for different paper details.','request_conflict',409);
    if(busy)C.fail('Another paper is being imported. Retry shortly.','busy',409);
    busy=true;let temp=null;
    try {
      let bytes;
      if(body.pdfBase64){if(typeof body.pdfBase64!=='string'||body.pdfBase64.length>C.MAX_PDF*1.34+8)C.fail('PDF exceeds the 50 MB web limit.');const raw=Zotero.getMainWindow().atob(body.pdfBase64);bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));}
      else if(prior?.status==='applied')bytes=await fileBytes(prior.attachmentKey,prior.parentKey);
      else {const info=await inspect(meta.source);bytes=await external(info.pdfUrl||meta.source,'arraybuffer');}
      if(!bytes?.length||bytes.length>C.MAX_PDF||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')C.fail('The selected file is not a valid PDF, or exceeds 50 MB.');
      const fingerprint=sha(bytes),id=C.arxiv(meta.source),query=id?.id||meta.title;
      if(prior?.pdfSha256 && prior.pdfSha256!==fingerprint)C.fail('This request ID was used for a different PDF.','request_conflict',409);
      if(prior?.status==='applied') {
        if(sha(await fileBytes(prior.attachmentKey,prior.parentKey))!==fingerprint)C.fail('The imported PDF changed in Zotero.','wrong_pdf',409);
        return prior;
      }
      let parent=prior?.parentKey?await nativeItem(prior.parentKey):null;
      // A new click has a new request ID. Reuse a previous verified import by
      // fingerprint as well, without scanning unrelated PDFs or notes.
      if(!parent) {
        const imported=Object.values(journal()).reverse().filter(r=>r.status==='applied'&&r.serverId===serverId&&r.pdfSha256===fingerprint);
        for(const record of imported) {
          try {
            const existing=await nativeItem(C.key(record.parentKey)),d=data(existing);
            if(d&&!d.deleted&&!['attachment','note','annotation'].includes(d.itemType)&&sha(await fileBytes(C.key(record.attachmentKey),record.parentKey))===fingerprint){parent=existing;break;}
          }catch(error){ /* A removed or changed import is not a duplicate. */ }
        }
      }
      if(!parent) {
        // Zotero defaults to title/creator/year. arXiv IDs are usually in the
        // URL or Extra field, so they require an all-fields metadata search.
        const matches=(await native('GET','/users/0/items?format=json&limit=100&qmode=everything&q='+encodeURIComponent(query)))||[];
        parent=matches.find(x=>{const d=data(x);return !['attachment','note','annotation'].includes(d.itemType)&&!d.deleted&&(id?C.arxiv(d.url)?.id===id.id:meta.source?d.url===meta.source:d.title===meta.title);});
      }
      if(!parent){
        const key=prior?.parentKey||itemKey();remember(identity,{status:'reserved',parentKey:key,pdfSha256:fingerprint,requestHash});
        parent=await create({key,version:0,itemType:'preprint',title:meta.title,date:meta.date,url:meta.source?(id?'https://arxiv.org/abs/'+id.id+id.version:meta.source):'',DOI:meta.doi,abstractNote:meta.abstract,creators:meta.authors.map(name=>({creatorType:'author',name})),tags:[...new Set(['Paper Library',meta.category,...meta.keywords])].map(tag=>({tag})),collections:[await collection(meta.category)],extra:id?'arXiv: '+id.id:''});
      }
      const parentData=data(parent);
      if(['attachment','note','annotation'].includes(parentData.itemType)||parentData.deleted || (prior?.parentKey && (parentData.title!==meta.title || (meta.source && (id?C.arxiv(parentData.url)?.id!==id.id:parentData.url!==meta.source)))))C.fail('The reserved Zotero item changed.','key_conflict',409);
      const parentKey=parent.key||data(parent).key;
      let attachmentKey=null;
      for(const child of await children(parentKey)) {
        if(data(child).itemType!=='attachment'||data(child).contentType!=='application/pdf')continue;
        try {if(sha(await fileBytes(child.key||data(child).key,parentKey))===fingerprint){attachmentKey=child.key||data(child).key;break;}}catch{}
      }
      if(!attachmentKey){
        temp=PathUtils.join(Zotero.getTempDirectory().path,'paper-library-'+body.requestId+'.pdf');await IOUtils.write(temp,bytes);
        const parentItem=await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID,parentKey);
        await requireNativeGrant();
        const attachment=await Zotero.Attachments.importFromFile({file:temp,parentItemID:parentItem.id,title:'PDF',contentType:'application/pdf'});
        attachmentKey=attachment.key;
      }
      if(sha(await fileBytes(attachmentKey,parentKey))!==fingerprint)C.fail('The saved Zotero PDF did not match the uploaded file.','wrong_pdf',409);
      const result={status:'applied',parentKey,attachmentKey,pdfSha256:fingerprint,title:meta.title,serverId,metadata:meta,requestHash};
      remember(identity,result);return result;
    }finally{busy=false;if(temp)await IOUtils.remove(temp,{ignoreAbsent:true});}
  }
  let workerCache=null;
  async function cloudOrigin(){
    if(workerCache&&workerCache.until>Date.now())return workerCache.origin;
    const response=await Zotero.HTTP.request('GET',C.ORIGIN+'/papers/service-config.json',{responseType:'text',followRedirects:false,timeout:15000,successCodes:false,headers:{'Cache-Control':'no-cache'}});
    if(response.status!==200||typeof response.responseText!=='string'||response.responseText.length>4096)C.fail('Paper service configuration unavailable.','source_unavailable',502);
    let value;try{value=JSON.parse(response.responseText);}catch{C.fail('Invalid service configuration.');}
    const origin=C.workerOrigin(value.apiBase);
    if(origin!=='https://paper-library-service.aper--ibrary--ervice.workers.dev')C.fail('Unexpected library service.');
    workerCache={origin,until:Date.now()+300000};return origin;
  }
  function cloudToken(request){
    const token=new (Zotero.getMainWindow().Headers)(request.headers).get('X-Paper-Library-Session')||'';
    return /^[a-f0-9]{64}$/.test(token)?token:'';
  }
  async function mapping(fid,accountToken='') {
    if(!/^\d{1,9}$/.test(String(fid)))C.fail('Invalid paper ID.');
    if(!accountToken)C.fail('Log in to My Library to synchronize this private paper.','authentication_required',401);
    const origin=await cloudOrigin();
    const value=JSON.parse(await external(origin+'/api/papers/'+fid+'/reader?serverId='+encodeURIComponent(serverId),'text',accountToken));
    if(value.fileId!==Number(fid))C.fail('Paper mapping does not match its stable ID.');
    if(value.spaceId!=='personal')C.fail('Private paper is outside the original Zotero space.','unlinked',409);
    return value;
  }
  async function verifiedMapping(fid,accountToken) {
    const m=await mapping(fid,accountToken),parent=m.zotero?.parentKey,attachment=m.mapping?.status==='matched'?m.zotero?.attachmentKey:null;
    if(!parent)C.fail('This paper has no Zotero association yet.','unlinked',409);
    C.key(parent);
    if(attachment){
      const expected=m.pdf?.sha256;
      if(!/^[a-f0-9]{64}$/i.test(expected||''))C.fail('A verified PDF fingerprint is required.','wrong_pdf',409);
      if(sha(await fileBytes(C.key(attachment),parent))!==expected.toLowerCase())C.fail('The Zotero PDF differs from the published paper.','wrong_pdf',409);
      const hashKey=fid+':'+expected;
      if(!hashes.has(hashKey)){
        const worker=await cloudOrigin();
        const target=new URL(m.pdf.url,worker||C.ORIGIN+'/papers/reader/');
        if(target.origin!==worker||target.pathname!=='/api/papers/'+fid+'/pdf')C.fail('Invalid published PDF mapping.');
        const publicBytes=await external(target.href,'arraybuffer',worker?accountToken:'');
        if(sha(publicBytes)!==expected.toLowerCase())C.fail('The published PDF fingerprint changed.','wrong_pdf',409);
        hashes.set(hashKey,true);
      }
    }
    return {m,parent,attachment};
  }
  async function snapshot(fid,verified=null,accountToken) {
    const {m,parent,attachment}=verified||await verifiedMapping(fid,accountToken);
    const notes=(await children(parent,'note')).map(x=>C.normalize(x,'note'));
    const annotations=attachment?(await children(attachment,'annotation')).map(x=>C.normalize(x,'annotation')):[];
    for(const item of [...notes,...annotations])item.contentHash=sha(C.canonical(item.html!==undefined?{note:item.html}:{type:item.type,text:item.text,comment:item.comment,color:item.color,position:item.position,tags:item.tags}));
    const p=await nativeItem(parent);
    return {fileId:Number(fid),serverId,revision:p?.version||data(p)?.version||0,zotero:m.zotero,mapping:m.mapping,annotations,notes,annotationEditable:!!attachment,parentKey:parent,attachmentKey:attachment,live:true,source:'live'};
  }
  async function sync(fid,body,accountToken) {
    checkServer(body.serverId);
    if(busy)C.fail('A Zotero operation is in progress. Retry shortly.','busy',409);
    if(!Array.isArray(body.changes)||body.changes.length>50)C.fail('Sync accepts at most 50 changes.');
    busy=true;
    const applied=[],conflicts=[],failed=[];
    try {
      const verified=await verifiedMapping(fid,accountToken),{parent,attachment}=verified;
      for(const ch of body.changes){
        try{
          if(!ch || !['note','annotation'].includes(ch.kind)||!['create','update','delete'].includes(ch.action)||typeof ch.id!=='string'||ch.id.length>200)C.fail('Invalid change.');
          const owner=ch.kind==='note'?parent:attachment;if(!owner)C.fail('Annotations need an exact matching PDF.');
          let key=ch.key;
          if(ch.action==='create'){
            const identity='create:'+serverId+':'+owner+':'+ch.kind+':'+ch.id,prior=journal()[identity];
            key=prior?.key||itemKey();const expected=C.writeBody(ch,key,owner),existing=await nativeItem(key);
            if(existing){C.owner(existing,ch.kind,parent,attachment);const d=data(existing);if(Object.keys(expected).some(k=>!['key','version'].includes(k)&&C.canonical(d[k])!==C.canonical(expected[k])))C.fail('A previously created item has changed.','conflict',409);}
            else {if(prior?.status==='applied')C.fail('The previously created item was removed in Zotero.','conflict',409);remember(identity,{key,status:'reserved'});await create(expected,identity);}
          }else{
            key=C.key(key);const remote=await nativeItem(key);if(!remote)C.fail('The original item was removed in Zotero.','conflict',409);
            C.owner(remote,ch.kind,parent,attachment);
            const version=remote.version||data(remote).version||0;
            if(!Number.isInteger(ch.baseVersion)||ch.baseVersion!==version)C.fail('The item changed in Zotero. Review both versions.','conflict',409);
            const headers={'If-Unmodified-Since-Version':String(version)};
            if(ch.action==='delete')await native('DELETE','/users/0/items/'+key,undefined,headers);
            else {const updated=C.writeBody(ch,key,owner);updated.version=version;await native('PUT','/users/0/items/'+key,updated,headers);}
          }
          const saved=ch.action==='delete'?null:await nativeItem(key);
          applied.push({id:ch.id,key,kind:ch.kind,action:ch.action,version:saved?.version||data(saved)?.version||0});
        }catch(e){const list=e.status===409?conflicts:failed;list.push({id:ch?.id,kind:ch?.kind,local:ch?.value,remote:null,reason:e.message,code:e.code||'zotero_error'});}
      }
      return {ok:!failed.length&&!conflicts.length,fileId:Number(fid),applied,conflicts,failed,snapshot:await snapshot(fid,verified)};
    }finally{busy=false;}
  }
  function response(status,value) {return [status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},JSON.stringify(value)];}
  function endpoint(path,methods,fn,open=false) {
    const Endpoint=function(){};
    Endpoint.prototype={supportedMethods:methods,supportedDataTypes:['application/json'],allowRequestsFromUnsafeWebContent:true,init:async function(request){
      try{
        if(!allowedOrigin(new (Zotero.getMainWindow().Headers)(request.headers).get('Origin')))C.fail('This website is not allowed.','bad_origin',403);
        if(!open)authorized(request);
        await probe();
        return response(200,await fn(request.data||{},request));
      }catch(e){return response(e.status||500,{ok:false,error:{code:e.code||'zotero_error',message:String(e.message||'Zotero operation failed.').replace(/sk-[A-Za-z0-9]+/g,'[redacted]')}});}
    }};
    Zotero.Server.Endpoints[PREFIX+path]=Endpoint;routes.push(PREFIX+path);
  }
  async function startup() {
    restoreAccess();
    const proto=Zotero.Server.RequestHandler.prototype;originalResponse=proto._generateResponse;
    responseWrapper=function(status,headers,body){
      if(this.pathname?.startsWith(PREFIX+'/') && allowedOrigin(this.origin)){
        headers=typeof headers==='string'?{'Content-Type':headers}:{...(headers||{})};
        Object.assign(headers,{'Access-Control-Allow-Origin':this.origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Paper-Library-Session','Access-Control-Allow-Private-Network':'true','Access-Control-Max-Age':'600','Vary':'Origin'});
      }
      return originalResponse.call(this,status,headers,body);
    };proto._generateResponse=responseWrapper;
    endpoint('/status',['GET'],()=>({ok:true,version:'1.2.3',serverId,maxPdfBytes:C.MAX_PDF}),true);
    endpoint('/connect',['POST'],connect,true);
    endpoint('/inspect',['POST'],body=>inspect(body.source));
    endpoint('/import',['POST'],importPaper);
    endpoint('/file',['POST'],async body=>{checkServer(body.serverId);const bytes=await fileBytes(C.key(body.attachmentKey),C.key(body.parentKey));let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return {pdfBase64:Zotero.getMainWindow().btoa(binary),sha256:sha(bytes)};});
    endpoint('/api/health',['GET'],()=>({ok:true,schemaVersion:1}));
    endpoint('/api/status',['GET'],async()=>({ok:true,schemaVersion:1,zotero:{reachable:true,serverId,version:Zotero.version,readable:true,authorizationAvailable:nativeValidatorAvailable(),writable:await validNativeGrant()&&!!Zotero.Libraries.get(Zotero.Libraries.userLibraryID)?.editable},translation:PaperLibraryTranslation.status(),transport:'zotero-addon'}));
    endpoint('/api/translate',['POST'],body=>PaperLibraryTranslation.translate(body));
    endpoint('/api/zotero/authorize',['POST'],authorizeNative);
    endpoint('/api/papers/:fileID',['GET'],(_,r)=>snapshot(r.pathParams.fileID,null,cloudToken(r)));
    endpoint('/api/papers/:fileID/sync',['POST'],(body,r)=>sync(r.pathParams.fileID,body,cloudToken(r)));
    Zotero.debug('Paper Library Web enabled for '+C.ORIGIN);
  }
  function shutdown(){stopped=true;nativeKey=null;sessions.clear();mappings.clear();hashes.clear();for(const route of routes)delete Zotero.Server.Endpoints[route];const proto=Zotero.Server.RequestHandler.prototype;if(proto._generateResponse===responseWrapper)proto._generateResponse=originalResponse;}
  return {startup,shutdown};
})();

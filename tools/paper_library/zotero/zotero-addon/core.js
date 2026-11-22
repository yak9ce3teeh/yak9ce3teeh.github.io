/* Pure validation and wire-format helpers, shared by the add-on and its checks. */
var PaperLibraryCore = (() => {
  'use strict';
  const ORIGIN = 'https://yak9ce3teeh.github.io';
  function workerOrigin(value){let u;try{u=new URL(value);}catch{fail('Invalid service endpoint.');}if(u.protocol!=='https:'||!/^([a-z0-9-]+\.)+workers\.dev$/.test(u.hostname)||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)fail('Invalid service endpoint.');return u.origin;}
  const KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
  const MAX_PDF = 50 * 1024 * 1024;
  const fail = (message, code='invalid_request', status=400) => { const e=new Error(message); e.code=code; e.status=status; throw e; };
  const key = value => { if(!KEY.test(value||'')) fail('Invalid Zotero item key.'); return value; };
  const clean = (value,max=1000) => typeof value==='string' ? value.trim().slice(0,max) : '';
  function canonical(value) {
    if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
    if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function arxiv(value) {
    value=clean(value).replace(/^arxiv\s*:/i,'');
    const match=value.match(/^(?:https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(v\d+)?(?:\.pdf)?(?:[?#].*)?$/i);
    return match ? {id:match[1].toLowerCase(),version:(match[2]||'').toLowerCase()} : null;
  }
  function remoteUrl(value) {
    let url; try { url=new URL(value); } catch { fail('Enter an arXiv link or a public HTTPS PDF URL.'); }
    if(url.protocol!=='https:' || url.username || url.password || !url.hostname.includes('.') || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || url.hostname.endsWith('.local') || url.hostname.includes(':')) fail('Use a public HTTPS paper URL.');
    return url.href;
  }
  function metadata(value) {
    if(!value || typeof value!=='object' || Array.isArray(value)) fail('Paper metadata is required.');
    const title=clean(value.title,500), date=clean(value.date||value.publication_date,10), category=clean(value.category,160);
    if(!title) fail('Enter a paper title.');
    if(!/^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/.test(date)) fail('Enter a publication date as YYYY-MM or YYYY-MM-DD.');
    if(date.length===10 && new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) fail('The publication date does not exist.');
    if(!/^[^<>:"\\|?*\x00-\x1f]+\/[^<>:"\\|?*\x00-\x1f]+$/.test(category) || category.split('/').some(s=>!s.trim()||s==='.'||s==='..')) fail('Choose an Area/Topic category.');
    const source=clean(value.source,2000), identity=arxiv(source);
    if(source && !identity) remoteUrl(source);
    return {title,date,category,source,method:clean(value.method,100),keywords:(Array.isArray(value.keywords)?value.keywords:String(value.keywords||'').split(',')).map(s=>clean(s,80)).filter(Boolean).slice(0,30),authors:(Array.isArray(value.authors)?value.authors:[]).map(s=>clean(s,160)).filter(Boolean).slice(0,100),abstract:clean(value.abstract,30000),doi:clean(value.doi,200)};
  }
  function position(value) {
    if(!value || !Number.isInteger(value.pageIndex) || value.pageIndex<0 || value.pageIndex>99999 || !Array.isArray(value.rects) || !value.rects.length) fail('Annotation needs a valid page and rectangles.');
    const rects=value.rects.map(r=>{if(!Array.isArray(r)||r.length!==4||r.some(v=>typeof v!=='number'||!Number.isFinite(v))) fail('Invalid annotation coordinates.');return [Math.min(r[0],r[2]),Math.min(r[1],r[3]),Math.max(r[0],r[2]),Math.max(r[1],r[3])];});
    return {...value,rects};
  }
  function writeBody(change,itemKey,parent) {
    const v=change.value||{};
    if(change.kind==='note') {
      const note=clean(v.html||v.note,1500001); if(!note || note.length>1500000) fail('Note is empty or too large.');
      return {key:key(itemKey),version:0,itemType:'note',parentItem:key(parent),note,tags:Array.isArray(v.tags)?v.tags:[]};
    }
    if(change.kind!=='annotation') fail('Unknown change kind.');
    const type=v.type||v.annotationType||'highlight';
    if(!['highlight','underline','note'].includes(type)) fail('This annotation type is read-only.');
    const p=position(v.position), sort=/^\d{5}\|\d{6}\|\d{5}$/.test(v.sortIndex||'')?v.sortIndex:String(p.pageIndex).padStart(5,'0')+'|000000|00000';
    const body={key:key(itemKey),version:0,itemType:'annotation',parentItem:key(parent),annotationType:type,annotationText:clean(v.text,100000),annotationComment:clean(v.comment,100000),annotationColor:/^#[a-f0-9]{6}$/i.test(v.color||'')?v.color:'#ffd400',annotationPageLabel:clean(v.pageLabel||'1',32),annotationSortIndex:sort,annotationPosition:canonical(p),tags:Array.isArray(v.tags)?v.tags:[]};
    if(type==='note') delete body.annotationText;
    return body;
  }
  function normalize(raw,kind) {
    const d=raw.data||raw, base={id:d.key,key:d.key,version:raw.version||d.version||0,tags:d.tags||[],dateModified:d.dateModified||'',parentItem:d.parentItem};
    if(kind==='note') return {...base,html:d.note||''};
    let p=null;try {p=JSON.parse(d.annotationPosition||'null');}catch{}
    const readOnly=!['highlight','underline','note'].includes(d.annotationType)||!!(d.isExternal||d.annotationIsExternal);
    return {...base,type:d.annotationType||'unknown',text:d.annotationText||'',comment:d.annotationComment||'',color:d.annotationColor||'',pageLabel:d.annotationPageLabel||'',sortIndex:d.annotationSortIndex||'',position:p,readOnly,raw:readOnly?d:null};
  }
  function owner(raw,kind,parent,attachment) {
    const d=raw.data||raw;
    if(d.deleted || d.itemType!==kind || d.parentItem!==(kind==='annotation'?attachment:parent)) fail('The Zotero item belongs to another paper.', 'wrong_parent',409);
    if(kind==='annotation' && (!['highlight','underline','note'].includes(d.annotationType)||d.isExternal||d.annotationIsExternal)) fail('This annotation is read-only.','read_only',409);
  }
  return {ORIGIN,workerOrigin,MAX_PDF,fail,key,clean,canonical,arxiv,remoteUrl,metadata,position,writeBody,normalize,owner};
})();
if(typeof module!=='undefined') module.exports=PaperLibraryCore;

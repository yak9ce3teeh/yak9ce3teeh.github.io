export const REPO='yak9ce3teeh/yak9ce3teeh.github.io';
export const ZOTERO='http://127.0.0.1:23119';
export const PREFIX='/paper-library';
export const CONNECTION_KEY='plr.connection';
export const MAX_PDF=50*1024*1024;
export function connection(storage=localStorage,now=Date.now()) {
  try {const r=JSON.parse(storage.getItem(CONNECTION_KEY)||'null');if(!r||r.disconnected||r.url!==ZOTERO||!/^[a-zA-Z0-9_-]{32,4096}$/.test(r.token||'')||!Number.isFinite(r.createdAt)||!Number.isFinite(r.expiresAt)||r.createdAt>now||r.expiresAt<=now||r.expiresAt<=r.createdAt||r.expiresAt-r.createdAt>8*3600000)return null;return r;}catch{return null;}
}
let connectionRenewal=null;
export async function renewConnection(expected=null,storage=localStorage){
  if(connectionRenewal)return connectionRenewal;
  const renew=async()=>{
    let prior;try{prior=JSON.parse(storage.getItem(CONNECTION_KEY)||'null');}catch{}
    if(!prior||prior.url!==ZOTERO||prior.transport!=='zotero-addon'||(prior.disconnected&&!prior.expired))return null;
    const current=connection(storage);
    if(expected&&current&&current.token!==expected.token)return current;
    const before=storage.getItem(CONNECTION_KEY);
    const record=await zotero('/connect',{authorizeZotero:false},null,true);
    if(record.url!==ZOTERO||record.transport!=='zotero-addon'||!/^[a-zA-Z0-9_-]{32,4096}$/.test(record.token||'')||!Number.isFinite(record.createdAt)||!Number.isFinite(record.expiresAt)||record.createdAt>Date.now()||record.expiresAt<=Date.now()||record.expiresAt<=record.createdAt||record.expiresAt-record.createdAt>8*3600000)throw new Error('Invalid Zotero connection response.');
    if(storage.getItem(CONNECTION_KEY)!==before)return connection(storage);
    storage.setItem(CONNECTION_KEY,JSON.stringify(record));return record;
  };
  connectionRenewal=(async()=>typeof navigator!=='undefined'&&navigator.locks?.request?navigator.locks.request('plr.connection.renew',renew):renew())();
  try{return await connectionRenewal;}finally{connectionRenewal=null;}
}
export async function zotero(path,body,record=connection(),retried=false) {
  if(!/^\/[a-zA-Z0-9_/-]+$/.test(path))throw new Error('Invalid Zotero operation.');
  if(!record && path!=='/status'&&path!=='/connect'){
    if(!retried)record=await renewConnection();
    if(!record)throw new Error('Connect Zotero in Settings first. Your form has been kept.');
  }
  const headers={};if(record)headers.Authorization='Bearer '+record.token;
  const options={method:body===undefined?'GET':'POST',headers,credentials:'omit',redirect:'error',cache:'no-store'};
  if(body!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  let response;
  try {response=await fetch(ZOTERO+PREFIX+path,{...options,signal:AbortSignal.timeout(20000)});}catch(e) {throw new Error(e.name==='TimeoutError'||e.name==='AbortError'?'Zotero timed out. Open Zotero, check its authorization prompt, and retry.':'Cannot reach local Zotero. Open Zotero with Paper Library Web 1.2.0 or later, and allow this site local network access in your browser.');}
  let value;try{value=await response.json();}catch{throw new Error('Unexpected Zotero response. Check that Paper Library Web 1.2.0 or later is installed.');}
  if(response.status===401&&record&&!retried){const renewed=await renewConnection(record);if(renewed)return zotero(path,body,renewed,true);}
  if(response.status===403)throw new Error(value.error?.message||'Zotero authorization was denied. Allow this website in Zotero and retry.');
  if(!response.ok)throw new Error(value.error?.message||'Zotero could not complete the request.');
  return value;
}

export const SESSION_KEY = 'paper-library.account-session.v1';
export const SESSION_EVENT = 'paper-library:session';
export const DEFAULT_API = 'https://paper-library-service.aper--ibrary--ervice.workers.dev';
let configuration;
export async function accountOrigin(){
  return configuration ??= fetch('/papers/service-config.json',{cache:'no-store',signal:AbortSignal.timeout(10000)})
    .then(async response => {
      if(!response.ok)throw Error();
      const {apiBase}=await response.json();
      const url=new URL(apiBase);
      const localPreview=globalThis.location?.origin==='http://127.0.0.1:8000'&&url.origin==='http://127.0.0.1:8787';
      if(url.origin!==DEFAULT_API&&!localPreview)throw Error();
      return url.origin;
    }).catch(()=>DEFAULT_API);
}
export function accountSession(){
  try{
    const value=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');
    return value?.user?.id && /^[a-f0-9]{64}$/.test(value.token) && value.expires>Date.now()?value:null;
  }catch{return null;}
}
export function saveSession(value){
  if(value){
    const {token,expires,user}=value;
    localStorage.setItem(SESSION_KEY,JSON.stringify({token,expires,user}));
  }else localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(SESSION_EVENT));
}
export async function accountFetch(path,options={},session=undefined){
  const base=await accountOrigin(),url=new URL(path,base);
  if(url.origin!==base||!url.pathname.startsWith('/api/'))throw Error('Unexpected library service URL.');
  const current=session===undefined?accountSession():session,headers=new Headers(options.headers);
  headers.delete('Authorization');
  if(current)headers.set('Authorization','Bearer '+current.token);
  try{
    return await fetch(url,{...options,headers,cache:'no-store',redirect:'error',credentials:'omit',
      signal:options.signal||AbortSignal.timeout(70000)});
  }catch{throw Error('The library service is unreachable. Try again.');}
}
export async function accountApi(path,options,session){
  const response=await accountFetch(path,options,session);
  let data;
  try{data=await response.json();}catch{throw Error('The library service returned an unexpected response.');}
  if(!response.ok){
    const error=Error(data.error||'Library request failed.');
    error.status=response.status;
    throw error;
  }
  return data;
}
export const jsonRequest=(value)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});

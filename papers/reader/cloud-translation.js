// Independent service connection, shared by all pages on the personal website.
export const KEY='papers.service.owner-key';
export function createCloudTranslation(changed=()=>{}){
 let issue='',configured=null,base='';
 async function endpoint(){if(!base){const r=await fetch('/papers/service-config.json',{cache:'no-store'});if(!r.ok)throw Error('Service configuration unavailable.');const c=await r.json(),u=new URL(c.apiBase);if(u.protocol!=='https:')throw Error('Cloud service must use HTTPS.');base=u.href.replace(/\/$/,'');}return base;}
 function session(){try{const token=localStorage.getItem(KEY);return /^[a-f0-9]{64}$/.test(token||'')?{token}:null;}catch{return null;}}
 async function call(path,options={}){const headers=new Headers(options.headers),s=session();if(s)headers.set('Authorization','Bearer '+s.token);let r;try{r=await fetch((await endpoint())+path,{...options,headers,credentials:'omit',signal:AbortSignal.timeout(path.includes('translate')?70000:12000)});}catch{throw Error('Cloud service unreachable or timed out. Try again.');}const v=await r.json();if(!r.ok)throw Error(v.error?.message||v.error||'Cloud request failed.');return v;}
 async function refresh(){try{configured=(await call('/api/translation/status')).configured;issue='';}catch(e){issue=e.message;}changed();}
 async function connect(key){if(!/^[a-f0-9]{64}$/.test(key||''))throw Error('Enter the owner access key for this library.');const previous=localStorage.getItem(KEY);localStorage.setItem(KEY,key);try{const v=await call('/api/session/status');if(!v.owner)throw Error('Owner access was not verified.');configured=(await call('/api/translation/status')).configured;issue='';changed();return v;}catch(e){if(previous)localStorage.setItem(KEY,previous);else localStorage.removeItem(KEY);issue=e.message;changed();throw e;}}
 async function disconnect(){localStorage.removeItem(KEY);issue='Service disconnected in this browser.';changed();}
 async function translate(text){if(!session())throw Error('Connect the library service once for all papers.');return call('/api/translation/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,targetLanguage:'zh-CN'})});}
 window.addEventListener('storage',e=>{if(e.key===KEY){issue='';changed();}});
 return {session,connect,disconnect,translate,refresh,get message(){return issue||(configured===false?'Cloud DeepSeek translation is not configured.':session()?'':'Connect the library service once for all papers. Zotero is optional.');},get configured(){return configured;}};
}

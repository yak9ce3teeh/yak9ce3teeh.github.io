import {accountApi,accountFetch,accountSession} from '../../../papers/reader/account-client.js';

let selected = '';
export function selectSpace(id:string){selected=id;}
export function serviceStamp(){return (accountSession()?.user.id||'')+'|'+selected;}
function scoped(path:string){
 const url=new URL(path,'https://library.invalid');
 if(url.origin!=='https://library.invalid'||!url.pathname.startsWith('/api/'))throw Error('Unexpected library service URL.');
 if(selected)url.searchParams.set('space',selected);
 return url.pathname+url.search;
}
export function api(path:string,options?:RequestInit){return accountApi(scoped(path),options);}
export function serviceFetch(path:string,options?:RequestInit){return accountFetch(scoped(path),options);}
export function readerUrl(id:number){
 if(!Number.isSafeInteger(id)||id<0)throw Error('Invalid paper ID.');
 return '/papers/reader/?id='+id;
}
export function nativeZoteroAvailable(){return selected==='personal'&&!!accountSession()?.user.admin;}
export async function openPdf(path:string){
 const response=await serviceFetch(path);
 if(!response.ok)throw Error('Cloud PDF unavailable.');
 const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
 link.href=url;link.download='paper.pdf';link.click();
 window.setTimeout(()=>URL.revokeObjectURL(url),60000);
}

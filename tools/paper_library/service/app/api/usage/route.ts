import {bindings,json} from '../../../lib/cloud';

import {bucketUsage} from '../../../lib/storage-usage';

async function databaseUsage(){
 const result=await bindings().DB.prepare('SELECT 1 AS sample').run();
 const bytes=result.meta?.size_after;
 return typeof bytes==='number'&&bytes>0?{bytes}:{unknown:'database size not reported'};
}
async function translationUsage(){
 const now=new Date(), minute=Math.floor(now.getTime()/60000);
 const row=await bindings().DB.prepare('SELECT minute,minute_used,day_used FROM translation_limits WHERE day=?').bind(now.toISOString().slice(0,10)).first<{minute:number;minute_used:number;day_used:number}>();
 return {minuteUsed:row?.minute===minute?row.minute_used:0,minuteLimit:20,dayUsed:row?.day_used??0,dayLimit:200,dayUTC:now.toISOString().slice(0,10)};
}
async function deepseekBalance(){
 const key=bindings().DEEPSEEK_API_KEY;
 if(!key)return {unknown:'DeepSeek is not configured'};
 const res=await fetch('https://api.deepseek.com/user/balance',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(5000),redirect:'manual'});
 if(!res.ok)return {unknown:'DeepSeek balance unavailable'};
 const data:any=await res.json();
 const balances=data.balance_infos?.filter((x:any)=>['CNY','USD'].includes(x.currency)&&Number.isFinite(Number(x.total_balance))).map((x:any)=>({currency:x.currency,total:Number(x.total_balance)}));
 return balances?.length?{available:data.is_available===true,balances}:{unknown:'No balance sample'};
}
async function observed<T>(fn:()=>Promise<T>){try{return await fn();}catch{return {unknown:'Measurement unavailable'};}}
async function sample(){
 const [r2,d1,translation,deepseek]=await Promise.all([observed(bucketUsage),observed(databaseUsage),observed(translationUsage),observed(deepseekBalance)]);
 return {sampledAt:new Date().toISOString(),scope:'Paper Library resources; DeepSeek account balance',r2,d1,translation,deepseek,providerAccountUsage:{unknown:'Cloudflare account analytics are unavailable to this Worker'}};
}
let cached:Promise<Awaited<ReturnType<typeof sample>>>|undefined;
let expires=0;
export async function GET(){
 if(!cached||Date.now()>=expires){cached=sample();expires=Date.now()+60000;}
 return json(await cached);
}

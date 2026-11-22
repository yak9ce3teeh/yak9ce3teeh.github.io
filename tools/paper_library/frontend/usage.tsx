import React,{useEffect,useState,useRef} from 'react';
import {api,serviceStamp} from './service';

const size=(bytes:number)=>bytes>=1e9?(bytes/1e9).toFixed(2)+' GB':bytes>=1e6?(bytes/1e6).toFixed(2)+' MB':bytes.toLocaleString()+' B';

export function useSpaceUsage(owner:boolean,spaceId:string){
 const generation=useRef(0),[sample,setSample]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function refresh(){
  if(!owner||!spaceId||document.hidden)return;
  const job=++generation.current,stamp=serviceStamp();
  setBusy(true);
  try{
   const value=await api('/api/usage');
   if(job!==generation.current||stamp!==serviceStamp())return;
   setSample({spaceId,value});setError('');
  }catch(e){
   if(job!==generation.current||stamp!==serviceStamp())return;
   if([401,403,404].includes((e as any).status))setSample(undefined);
   setError((e as Error).message);
  }finally{if(job===generation.current)setBusy(false);}
 }
 useEffect(()=>{
  generation.current++;setSample(undefined);setError('');setBusy(false);
  if(!owner||!spaceId)return;
  refresh();
  const timer=setInterval(refresh,30000);
  window.addEventListener('focus',refresh);window.addEventListener('papers-space-updated',refresh);
  return ()=>{generation.current++;clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('papers-space-updated',refresh);};
 },[owner,spaceId]);
 return {sample:sample?.spaceId===spaceId?sample.value:null,error,busy,refresh,selected:!!spaceId};
}
type UsageData=ReturnType<typeof useSpaceUsage>;

export function SpaceSummary({data}:{data:UsageData}){
 const {sample,error,busy,refresh}=data,r2=sample?.r2;
 const pct=r2?.complete?r2.bytes/1e10*100:null;
 return <div className="space-summary" aria-label="Connected space information">
  <dl><div><dt>Items</dt><dd>{r2?r2.objects.toLocaleString():busy?'…':'—'}</dd></div><div><dt>Storage used</dt><dd>{r2?.complete?size(r2.bytes):busy?'…':'Unavailable'}</dd></div></dl>
  {pct!==null&&<><div className="space-usage-label"><span>{pct.toFixed(3)}%</span><span>of 10 GB reference</span></div><progress aria-label="Storage reference usage" max={100} value={Math.min(pct,100)}/></>}
  <div className="space-sample-status"><span role="status">{error|| (sample?'Updated '+new Date(sample.sampledAt).toLocaleTimeString():busy?'Loading space information…':'Space information unavailable.')}</span><button type="button" className="text-button" disabled={busy} onClick={refresh} aria-label="Refresh space information">↻</button></div>
  <small>Usage covers papers saved in this space. Cloudflare applies its allowance across your R2 account.</small>
 </div>;
}
export default function Usage({data}:{data:UsageData}){
 return data.selected?<SpaceSummary data={data}/>:<p>Choose a space to view its storage usage.</p>;
}

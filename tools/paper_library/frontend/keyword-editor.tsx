'use client';
import {serviceFetch} from './service';
import {useState} from 'react';
import {suggestKeywords} from './public/keywords.mjs';
export default function KeywordEditor({paper,onSaved,vocabulary}:{paper:any;vocabulary:string[];onSaved:(paper:any)=>void}){
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),[expected,setExpected]=useState<string[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 function edit(){setExpected(paper.keywords||[]);setDraft((paper.keywords?.length?paper.keywords:suggestKeywords(paper,vocabulary)).join(', '));setNotice('');setOpen(true);}
 async function save(){setBusy(true);setNotice('Saving keywords…');try{
  const response=await serviceFetch('/api/papers/'+paper.fileId+'/keywords',{method:'PATCH',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({keywords:draft.split(',').map(x=>x.trim()).filter(Boolean),expectedKeywords:expected})});
  const result:any=await response.json();if(!response.ok)throw new Error(result.error||'Keywords could not be saved.');onSaved(result.paper);setOpen(false);setNotice('Keywords saved.');
 }catch(e){setNotice((e as Error).message);}finally{setBusy(false);}}
 return <div>{!open?<button type="button" onClick={edit}>Edit keywords</button>:<div><label>Keywords for {paper.method||paper.title}<input disabled={busy} value={draft} onChange={e=>setDraft(e.target.value)} placeholder="English keywords, separated by commas"/></label><div className="actions"><button type="button" disabled={busy} onClick={()=>setDraft(suggestKeywords(paper,vocabulary).join(', '))}>Suggest keywords</button><button type="button" disabled={busy} onClick={save}>Save keywords</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>Cancel</button></div></div>}<p role="status">{notice}</p></div>;
}

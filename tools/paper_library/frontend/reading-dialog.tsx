import {useEffect,useRef,useState,type FormEvent} from 'react';
import {api,readerUrl} from './service';
import {captureReading} from './reading-source';
import {materialTypes} from './material-types.mjs';
import CategoryPicker from './category-picker';

const MAX_FILE=25*1024*1024;
const uncategorized='Other readings/Uncategorized';
const empty={materialType:'',source:'',title:'',date:'',category:'',keywords:''};

async function inspectPdf(file:File){
 let task;
 try{
  const modulePath='/papers/add/pdfjs/legacy/pdf.mjs';
  const pdfjs=await import(modulePath);
  pdfjs.GlobalWorkerOptions.workerSrc='/papers/add/pdfjs/legacy/pdf.worker.mjs?v=20261104-pdf-compat-1';
  const assets=new URL('/papers/reader/assets/vendor/pdfjs/',location.href).href;
  task=pdfjs.getDocument({
   data:await file.arrayBuffer(),isEvalSupported:false,cMapUrl:assets+'cmaps/',cMapPacked:true,
   standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'
  });
  const document=await task.promise;
  let text='';
  for(let page=1;page<=Math.min(3,document.numPages)&&text.length<15000;page++){
   const content=await (await document.getPage(page)).getTextContent();
   for(const item of content.items)if('str' in item)text+=item.str+(item.hasEOL?'\n':' ');
   text+='\n';
  }
  const metadata=await document.getMetadata().catch(()=>null);
  const title=typeof metadata?.info?.Title==='string'?metadata.info.Title.trim():'';
  const firstLine=text.split('\n').map(line=>line.trim()).find(line=>line.length>=12&&line.length<=180);
  return {extractedTitle:(title||firstLine||file.name.replace(/\.pdf$/i,'')).slice(0,500),sample:text.slice(0,15000)};
 }catch{
  // A protected or image-only PDF can still be saved for viewing.
  return {extractedTitle:file.name.replace(/\.pdf$/i,'').slice(0,500),sample:''};
 }finally{await task?.destroy().catch(()=>{});}
}

export default function ReadingDialog({open,close,onBusy,onSaved,categories,spaceName}:{
 open:boolean;close:()=>void;onBusy:(value:boolean)=>void;onSaved:()=>Promise<void>;
 categories:string[];spaceName:string;
}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [form,setForm]=useState(empty);
 const [mode,setMode]=useState<'link'|'file'>('link'),[file,setFile]=useState<File>();
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [saved,setSaved]=useState<{fileId:number;title:string;category:string;keywords:string[]}>();
 const update=(key:keyof typeof empty,value:string)=>setForm(previous=>({...previous,[key]:value}));
 useEffect(()=>{
  const current=dialog.current;
  if(open&&!current?.open)current?.showModal();
  else if(!open&&current?.open)current.close();
 },[open]);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy)return;
  setBusy(true);onBusy(true);setNotice('');setSaved(undefined);
  try{
   const data=new FormData();
   const details={...form,source:'',extractedTitle:'',sample:'',keywords:form.keywords.split(',').map(tag=>tag.trim()).filter(Boolean)};
   let upload=file;
   if(mode==='link'){
    setNotice('Fetching the reading…');
    const response=await captureReading(form.source);
    if(response.headers.get('Content-Type')?.startsWith('application/pdf')){
     details.source=response.headers.get('X-Reading-Source')||form.source;
     const path=new URL(details.source).pathname;
     let filename=path.split('/').at(-1)||'Linked reading';
     try{filename=decodeURIComponent(filename);}catch{}
     upload=new File([await response.blob()],filename.replace(/\.pdf$/i,'')+'.pdf',{type:'application/pdf'});
    }else{
     const capture=await response.json();
     details.source=capture.source;
     details.extractedTitle=capture.title;
     data.set('content',JSON.stringify(capture.blocks));
     upload=undefined;
    }
   }else if(!upload){
    throw new Error('Choose a PDF or DOCX file.');
   }
   if(upload){
    if(upload.size>MAX_FILE)throw new Error('Files can be up to 25 MB.');
    if(/\.pdf$/i.test(upload.name)){
     setNotice('Reading PDF details…');
     Object.assign(details,await inspectPdf(upload));
    }
    data.set('file',upload);
   }
   data.set('metadata',JSON.stringify(details));
   setNotice('Saving to '+spaceName+'…');
   const result=await api('/api/readings',{method:'POST',body:data});
   setSaved(result.paper);
   setNotice(result.already?'This material is already in this space.':'Reading saved.');
   window.dispatchEvent(new Event('papers-space-updated'));
   await onSaved();
  }catch(error){setNotice((error as Error).message);}
  finally{setBusy(false);onBusy(false);}
 }
 function reset(){setSaved(undefined);setNotice('');setForm(empty);setFile(undefined);setMode('link');}
 return <dialog ref={dialog} className="settings-dialog add-paper-dialog" aria-labelledby="add-readings-title"
  onCancel={event=>{if(busy)event.preventDefault();else close();}} onClose={close}>
  <div className="dialog-heading"><div><h2 id="add-readings-title">Add readings</h2><p>{spaceName}</p></div>
   <button type="button" className="dialog-close" aria-label="Close add readings" disabled={busy} onClick={close}>×</button>
  </div>
  <div className="dialog-content">
   {saved?<div className="saved-result" aria-label="Saved reading">
    <h3>{saved.title}</h3><p>{saved.category.replace('/', ' / ')}</p>
    <div className="tags">{saved.keywords.map(keyword=><span className="tag" key={keyword}>{keyword}</span>)}</div>
    <div className="actions"><a className="primary" href={readerUrl(saved.fileId)}>Open reading →</a><button type="button" onClick={reset}>Add another</button></div>
   </div>:<form className="reading-add-form" onSubmit={submit}>
    <label>Material Category<select aria-label="Material Category" value={form.materialType} required disabled={busy} onChange={e=>update('materialType',e.target.value)}>
     <option value="">Choose a type</option>{materialTypes.slice(1).map(([value,label])=><option value={value} key={value}>{label}</option>)}
    </select></label>
    <div className="source-switch" role="group" aria-label="Reading source">
     <label className={mode==='link'?'selected':''}><input type="radio" name="reading-source" checked={mode==='link'} disabled={busy} onChange={()=>setMode('link')}/>From a link</label>
     <label className={mode==='file'?'selected':''}><input type="radio" name="reading-source" checked={mode==='file'} disabled={busy} onChange={()=>setMode('file')}/>Upload PDF or Word</label>
    </div>
    {mode==='link'?<label>Website URL<input type="url" value={form.source} placeholder="https://…" required disabled={busy} onChange={e=>update('source',e.target.value)}/></label>
     :<label className="upload-zone"><strong>Choose a PDF or DOCX</strong><span>Up to 25 MB</span>
      <input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy} onChange={e=>setFile(e.target.files?.[0])}/>
      {file&&<small className="selected-file">{file.name}</small>}
     </label>}
    <details className="source-details">
     <summary>Optional details</summary>
     <label>Title<input disabled={busy} value={form.title} onChange={e=>update('title',e.target.value)} maxLength={500} placeholder="Detect automatically"/></label>
     <label>Date<input disabled={busy} value={form.date} onChange={e=>update('date',e.target.value)} placeholder="YYYY, YYYY-MM or YYYY-MM-DD"/></label>
     <CategoryPicker categories={[...categories,uncategorized]} disabled={busy} required={false} value={form.category} onChange={value=>update('category',value)}/>
     {form.category&&<button type="button" disabled={busy} onClick={()=>update('category','')}>Detect category automatically</button>}
     <label>Keywords<input disabled={busy} value={form.keywords} onChange={e=>update('keywords',e.target.value)} placeholder="Detect automatically, or enter comma-separated keywords"/></label>
    </details>
    <div className="actions"><button className="primary" disabled={busy} type="submit">{busy?'Adding…':'Add reading'}</button></div>
   </form>}
   <p className="form-status" role="status">{notice}</p>
  </div>
 </dialog>;
}

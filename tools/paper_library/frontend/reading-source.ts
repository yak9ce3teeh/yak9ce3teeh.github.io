import {serviceFetch} from './service';
const MAX_PDF=25*1024*1024,MAX_HTML=3_000_000;

async function responseError(response:Response,message:string){
 const data=await response.json().catch(()=>null);
 return new Error(data?.error||message);
}
async function boundedBlob(response:Response,limit:number,mime:string){
 const reader=response.body?.getReader();
 if(!reader||Number(response.headers.get('content-length'))>limit){
  await reader?.cancel();
  throw Error('The linked document is too large.');
 }
 const chunks:Uint8Array<ArrayBuffer>[]=[];
 let size=0;
 try{
  for(;;){
   const part=await reader.read();
   if(part.done)break;
   size+=part.value.byteLength;
   if(size>limit)throw Error('The linked document is too large.');
   chunks.push(part.value);
  }
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 return new Blob(chunks,{type:mime});
}
async function captureInBrowser(address:string){
 const url=new URL(address);
 if(url.protocol!=='https:'||url.port||url.username||url.password||!url.hostname.includes('.')||
    /[[:\]]/.test(url.hostname)||/^\d+(?:\.\d+){3}$/.test(url.hostname)||
    /(?:^|\.)(localhost|local|internal|lan|home|onion|invalid|test|example|arpa)\.?$/i.test(url.hostname))
  throw Error('The browser can only capture public HTTPS pages.');
 url.hash='';
 const response=await fetch(url.href,{
  credentials:'omit',mode:'cors',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(18000)
 });
 if(!response.ok)throw Error('The page could not be read directly.');
 const mime=response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
 if(mime==='application/pdf'){
  return new Response(await boundedBlob(response,MAX_PDF,mime),{
   headers:{'Content-Type':'application/pdf','X-Reading-Source':url.href}
  });
 }
 if(!mime||!['text/html','text/plain','application/xhtml+xml'].includes(mime))
  throw Error('This link did not return a web page or PDF.');
 const post=new FormData();
 post.set('url',url.href);
 post.set('html',await boundedBlob(response,MAX_HTML,mime),'capture.html');
 const parsed=await serviceFetch('/api/readings/source',{method:'POST',body:post});
 if(!parsed.ok)throw await responseError(parsed,'Could not extract the page text.');
 return parsed;
}

export async function captureReading(address:string){
 const response=await serviceFetch('/api/readings/source',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:address})
 });
 if(response.ok)return response;
 const failure=await responseError(response,'Could not read the link.');
 if(response.status!==502&&response.status!==422)throw failure;
 try{return await captureInBrowser(address);}
 catch{throw failure;}
}

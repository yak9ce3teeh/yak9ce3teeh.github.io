import {selectedSpace} from '../../../lib/spaces';
import {AccountError,digest,limit} from '../../../lib/accounts';
import {MAX_PDF} from '../../../lib/papers.mjs';
import {bySource,saveMaterial} from '../../../lib/material-store';
import {extractDocx,isPdf,MAX_READING_JSON,readingUrl,validateBlocks} from '../../../lib/reading-extract';
import {readingMetadata} from '../../../lib/reading-metadata';
import {json,record} from '../../../lib/cloud';

export async function POST(request:Request){
 const space=await selectedSpace(request);
 await limit(request,'reading-upload',15,space.user_id);
 if(Number(request.headers.get('content-length'))>MAX_PDF+MAX_READING_JSON+50000)
  throw new AccountError('Reading upload is too large.',413);
 const form=await request.formData();
 let values:any;
 try{values=JSON.parse(String(form.get('metadata')||'{}'));}
 catch{throw new AccountError('Invalid reading details.',400);}
 if(!values||typeof values!=='object'||Array.isArray(values))throw new AccountError('Invalid reading details.',400);
 const source=values.source?readingUrl(values.source).href:'';
 const sourceId=source?'reading:'+await digest(source):null;
 if(sourceId){
  const existing=await bySource(space,sourceId);
  if(existing)return json({already:true,paper:record(existing)});
 }
 const input=form.get('file');
 let title=typeof values.extractedTitle==='string'?values.extractedTitle.slice(0,500):'';
 let sample=typeof values.sample==='string'?values.sample.slice(0,15000):'';
 let format:'pdf'|'text', data:Uint8Array<ArrayBuffer>, originalFormat:'web'|'pdf'|'docx';
 if(input instanceof File){
  if(input.size>MAX_PDF)throw new AccountError('Files can be up to 25 MB.',413);
  const bytes=new Uint8Array(await input.arrayBuffer());
  const fileTitle=input.name.replace(/\.(?:pdf|docx)$/i,'').trim().slice(0,500);
  if(isPdf(bytes)){
   title=title||fileTitle||'Uploaded PDF';
   data=bytes;format='pdf';originalFormat='pdf';
  }else if(/\.docx$/i.test(input.name)){
   const doc=extractDocx(bytes);
   title=doc.title||fileTitle||'Word document';
   sample=doc.blocks.map(block=>block.text).join('\n\n').slice(0,15000);
   data=new TextEncoder().encode(JSON.stringify(doc.blocks));format='text';originalFormat='docx';
  }else{
   throw new AccountError('Choose a readable PDF or a Word DOCX file.',422);
  }
 }else{
  if(!source)throw new AccountError('Enter a URL or upload a PDF or DOCX file.',400);
  const content=String(form.get('content')||'');
  if(content.length>MAX_READING_JSON)throw new AccountError('This reading exceeds the text limit.',413);
  let value:unknown;
  try{value=JSON.parse(content);}
  catch{throw new AccountError('Fetch the page again before saving it.',400);}
  const blocks=validateBlocks(value);
  title=title||new URL(source).hostname;
  sample=blocks.map(block=>block.text).join('\n\n').slice(0,15000);
  data=new TextEncoder().encode(JSON.stringify(blocks));format='text';originalFormat='web';
 }
 if(format==='text'&&data.byteLength>MAX_READING_JSON)throw new AccountError('This reading exceeds the text limit.',413);
 const meta={...await readingMetadata(values,{title,body:sample,spaceId:space.id}),source,format,originalFormat};
 return saveMaterial({space,sourceId,meta,data,format});
}

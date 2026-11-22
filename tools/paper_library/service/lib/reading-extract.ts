import {DOMParser,parseHTML} from 'linkedom';
import {Readability} from '@mozilla/readability';
import {unzipSync} from 'fflate';
import ipaddr from 'ipaddr.js';
import {resolve4,resolve6} from 'node:dns/promises';
import {AccountError} from './accounts';
import {limited,MAX_PDF} from './papers.mjs';

export type Block = {kind:'paragraph'|'heading'|'quote'|'code'|'list';text:string};
export const MAX_READING_JSON=2_800_000, MAX_HTML=3_000_000;
const MAX_BLOCKS=4000, MAX_TEXT=750_000;
const kinds=new Set(['paragraph','heading','quote','code','list']);
const decoder=new TextDecoder();

export function readingUrl(value:unknown){
 let url:URL;
 try{url=new URL(typeof value==='string'?value.trim():'');}
 catch{throw new AccountError('Enter a complete public web address.',400);}
 const host=url.hostname.toLowerCase();
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||
    !host.includes('.')||host.endsWith('.')||ipaddr.isValid(host.replace(/^\[|\]$/g,''))||
    /(?:^|\.)(localhost|local|internal|lan|home|onion|invalid|test|example|arpa)$/.test(host)||
    url.href.length>2048)
  throw new AccountError('Use a public HTTP or HTTPS address.',400);
 url.hash='';
 return url;
}

async function checkPublicDns(url:URL,signal:AbortSignal){
 signal.throwIfAborted();
 const sets=await Promise.all([resolve4,resolve6].map(async resolve=>{
  try{return await resolve(url.hostname);}
  catch(error){
   if(['ENODATA','ENOTFOUND'].includes((error as NodeJS.ErrnoException).code||''))return [];
   console.warn('Public DNS resolution failed', (error as NodeJS.ErrnoException).code||(error as Error).name);
   throw new AccountError('Could not resolve the website through public DNS.',502);
  }
 }));
 signal.throwIfAborted();
 const addresses=sets.flat();
 if(!addresses.length||addresses.some(address=>!ipaddr.isValid(address)||ipaddr.process(address).range()!=='unicast'))
  throw new AccountError('The link does not resolve to a public website.',400);
}

export function validateBlocks(value:unknown):Block[]{
 if(!Array.isArray(value)||!value.length||value.length>MAX_BLOCKS)
  throw new AccountError('No readable text was found, or the document is too long.',422);
 let total=0;
 return value.map(block=>{
  if(!block||!kinds.has(block.kind)||typeof block.text!=='string')
   throw new AccountError('Invalid reading text.',400);
  total+=block.text.length;
  if(total>MAX_TEXT)throw new AccountError('This reading exceeds the text limit.',413);
  return {kind:block.kind,text:block.text};
 });
}
export function isPdf(bytes:Uint8Array){return decoder.decode(bytes.slice(0,5))==='%PDF-';}
const flow=new Set(['article','aside','body','div','dl','dt','dd','figcaption','figure','main','section','table','tbody','td','th','tr','ul','ol']);
const heading=/^h[1-6]$/;
const squish=(value:string)=>value.replace(/\s+/g,' ').trim();

export function extractHtml(html:string){
 const {document}=parseHTML(html);
 const root=document.querySelector('body')||document;
 const metaTitle=document.querySelector('meta[property="og:title"]')?.getAttribute('content');
 const fallbackTitle=squish(metaTitle||document.title||root.querySelector('h1')?.textContent||'');
 let article;
 try{article=new Readability(document.cloneNode(true) as unknown as Document).parse();}
 catch{article=null;}
 const content=article?.content
  ?parseHTML('<html><body>'+article.content+'</body></html>').document.body
  :root.querySelector('article, main, [role=main]')||root;
 for(const remove of content.querySelectorAll('script,style,noscript,form,nav,footer,iframe,template,svg,dialog,[hidden],[aria-hidden=true]'))remove.remove();
 const blocks:Block[]=[];
 function add(kind:Block['kind'],value:string){
  const text=kind==='code'?value.trim():squish(value);
  if(text)blocks.push({kind,text});
  if(blocks.length>MAX_BLOCKS)throw new AccountError('This reading contains too many sections.',413);
 }
 function visit(node:any,depth=0){
  if(depth>100)return;
  const tag=node.localName||'';
  if(heading.test(tag)){add('heading',node.textContent||'');return;}
  if(tag==='pre'){add('code',node.textContent||'');return;}
  if(tag==='blockquote'||tag==='li'||tag==='p'){
   add(tag==='li'?'list':tag==='blockquote'?'quote':'paragraph',node.textContent||'');return;
  }
  if(![...node.children].some((child:any)=>flow.has(child.localName)||heading.test(child.localName)||['p','blockquote','pre','li'].includes(child.localName))){
   add('paragraph',node.textContent||'');return;
  }
  let inline='';
  const flush=()=>{add('paragraph',inline);inline='';};
  for(const child of node.childNodes){
   const name=child.localName||'';
   if(flow.has(name)||heading.test(name)||['p','blockquote','pre','li'].includes(name)){
    flush();visit(child,depth+1);
   }else inline+=(child.textContent||'')+(name==='br'?' ':'');
  }
  flush();
 }
 visit(content);
 if(blocks.map(block=>block.text).join('').length<35)
  throw new AccountError('This page has too little readable text. Try downloading it as a PDF or DOCX.',422);
 return {title:squish(article?.title||fallbackTitle).slice(0,500),blocks:validateBlocks(blocks)};
}

export function extractPage(text:string,mime:string){
 return mime==='text/plain'
  ?{title:'',blocks:validateBlocks(text.split(/\r?\n\s*\r?\n/).filter(Boolean).map(text=>({kind:'paragraph',text})))}
  :extractHtml(text);
}

export async function fetchReading(value:unknown,projection=false){
 let url=readingUrl(value);
 const signal=AbortSignal.timeout(22000);
 for(let i=0;i<4;i++){
  try{await checkPublicDns(url,signal);}
  catch(error){
   if(error instanceof AccountError)throw error;
   throw new AccountError('The public DNS lookup could not be completed.',502);
  }
  let response;
  try{response=await fetch(url.href,{redirect:'manual',signal,headers:{Accept:'text/html,application/pdf,text/plain;q=0.8'}});}
  catch{throw new AccountError('The website could not be reached from the library service.',502);}
  if([301,302,303,307,308].includes(response.status)){
   await response.body?.cancel();
   const target=response.headers.get('Location');
   if(!target)throw new AccountError('The website returned an invalid redirect.',422);
   url=readingUrl(new URL(target,url).href);
   continue;
  }
  if(!response.ok)throw new AccountError('The website returned HTTP '+response.status+'. Try uploading a PDF or DOCX instead.',422);
  const mime=response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()||'';
  const maybePdf=mime==='application/pdf'||(/\.pdf$/i.test(url.pathname)&&!mime.includes('html'))||mime==='application/octet-stream';
  if(!maybePdf&&!['text/html','application/xhtml+xml','text/plain',''].includes(mime)){
   await response.body?.cancel();
   throw new AccountError('This link did not return a web page or PDF.',422);
  }
  let bytes;
  try{bytes=await limited(response,maybePdf?MAX_PDF:MAX_HTML);}
  catch{throw new AccountError('The linked document is too large or could not be downloaded.',422);}
  if(isPdf(bytes)){
   if(projection)throw new AccountError('The original link now points to a PDF.',422);
   return {format:'pdf' as const,source:url.href,bytes};
  }
  if(maybePdf&&mime!=='application/octet-stream')throw new AccountError('The link did not return a valid PDF.',422);
  const charset=response.headers.get('Content-Type')?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  let text:string;
  try{text=new TextDecoder(charset||'utf-8').decode(bytes);}
  catch{text=decoder.decode(bytes);}
  if(projection){
   if(!['text/html','application/xhtml+xml'].includes(mime))
    throw new AccountError('The original link did not return a web page.',422);
   return {format:'web' as const,source:url.href,html:text};
  }
  let article;
  try{
   article=extractPage(text,mime);
  }catch(error){
   if(error instanceof AccountError)throw error;
   console.warn('Reading HTML parser failed:',error instanceof Error?error.name:'unknown');
   throw new AccountError('This site’s layout could not be converted into readable text.',422);
  }
  return {format:'text' as const,source:url.href,...article};
 }
 throw new AccountError('The reading link redirects too many times.',422);
}

function wordName(node:any){return (node.nodeName||'').split(':').at(-1);}
export function extractDocx(data:Uint8Array){
 let files;
 try{
  files=unzipSync(data,{filter:entry=>{
   if(!['word/document.xml','docProps/core.xml'].includes(entry.name))return false;
   if(entry.originalSize>5_000_000)throw Error('Word XML too large');
   return true;
  }});
 }catch{throw new AccountError('Could not unpack this DOCX file.',422);}
 if(!files['word/document.xml'])throw new AccountError('Choose a valid DOCX Word document.',422);
 const doc=new DOMParser().parseFromString(decoder.decode(files['word/document.xml']),'text/xml');
 const blocks:Block[]=[];
 for(const node of doc.querySelectorAll('*')){
  if(wordName(node)!=='p')continue;
  let text='',kind:Block['kind']='paragraph';
  for(const part of node.querySelectorAll('*')){
   if(wordName(part)==='t')text+=part.textContent||'';
   if(wordName(part)==='br')text+='\n';
   if(wordName(part)==='tab')text+='\t';
   if(wordName(part)==='pStyle'&&/^heading/i.test(part.getAttribute('w:val')||''))kind='heading';
  }
  if(text.trim())blocks.push({kind,text:text.trim()});
 }
 let title='';
 if(files['docProps/core.xml']){
  const properties=new DOMParser().parseFromString(decoder.decode(files['docProps/core.xml']),'text/xml');
  title=[...properties.querySelectorAll('*')].find(node=>wordName(node)==='title')?.textContent?.trim()||'';
 }
 return {title:title.slice(0,500),blocks:validateBlocks(blocks)};
}

import {suggestKeywords,normalizeKeywords} from '../public/keywords.mjs';
export const MAX_PDF=25*1024*1024;
export async function sourceFetch(url,timeout=20000){
 const signal=AbortSignal.timeout(timeout);
 for(let i=0;i<4;i++){
  const u=new URL(url);if(!['https://arxiv.org','https://export.arxiv.org'].includes(u.origin)||u.username||u.password||!/^\/(abs|pdf)\//.test(u.pathname))throw new Error('Invalid paper source redirect.');
  const response=await fetch(u.href,{redirect:'manual',signal,headers:{Accept:u.pathname.startsWith('/pdf/')?'application/pdf':'text/html'}});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('Location');if(!location)throw new Error('Invalid paper source redirect.');url=new URL(location,u).href;continue;}
  return response;
 }
 throw new Error('Too many paper source redirects.');
}
export function parseRange(header,size){
 if(!header)return null;const m=header.match(/^bytes=(\d*)-(\d*)$/);if(!m||(!m[1]&&!m[2]))throw new Error('Invalid range');
 let start,end;if(!m[1]){const length=Number(m[2]);if(!Number.isSafeInteger(length)||length<=0)throw new Error('Invalid range');start=Math.max(0,size-length);end=size-1;}else{start=Number(m[1]);end=m[2]?Number(m[2]):size-1;}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new Error('Invalid range');end=Math.min(end,size-1);return {offset:start,length:end-start+1};
}
export function arxiv(value){
 const s=String(value||'').trim().replace(/^arxiv\s*:\s*/i,'');
 const m=s.match(/^(?:https:\/\/(?:www\.|export\.)?arxiv.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?(?:[?#].*)?$/i);
 if(!m)throw new Error('Enter an arXiv ID such as 2610.23127 or its arxiv.org link.');
 if(+m[1].slice(2,4)<1||+m[1].slice(2,4)>12)throw new Error('arXiv IDs use YYMM, not a four-digit year: October 2026 starts with 2610, not 2026.');
 return {id:m[1],version:m[2]||'',source:'https://arxiv.org/abs/'+m[1]+(m[2]||'')};
}
export const decode=s=>String(s||'').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(parseInt(n[0].toLowerCase()==='x'?n.slice(1):n,n[0].toLowerCase()==='x'?16:10))).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function metadata(html,source){
 const values={};for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){const attrs={};for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g))attrs[m[1].toLowerCase()]=decode(m[3]);const key=attrs.name||attrs.property;if(key)(values[key]??=[]).push(attrs.content||'');}
 const title=values.citation_title?.[0];if(!title)throw new Error('arXiv did not return paper metadata. You can still enter the details manually.');
 const abstract=decode((html.match(/<blockquote[^>]*class=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i)?.[1]||'').replace(/<[^>]+>/g,' ')).replace(/^\s*Abstract:\s*/,'').replace(/\s+/g,' ').trim();
 const details={title:title.replace(/\s+/g,' ').trim(),date:(values.citation_date?.[0]||values.citation_publication_date?.[0]||'').replaceAll('/','-').slice(0,10),authors:values.citation_author||[],abstract,source:arxiv(source).source,method:title.match(/^([A-Za-z][\w-]{1,29}):/)?.[1]||''};
 return {...details,keywords:suggestKeywords(details)};
}
export function validate(meta,categories,existingKeywords=[]){
 if(!meta||typeof meta.title!=='string'||!meta.title.trim()||meta.title.length>500)throw new Error('A paper title is required (up to 500 characters).');
 if(!/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(meta.date||'')||Number.isNaN(Date.parse(meta.date.length===7?meta.date+'-01':meta.date))||new Date(meta.date.length===7?meta.date+'-01':meta.date).toISOString().slice(0,meta.date.length)!==meta.date)throw new Error('Enter a valid publication month or date.');
 if(!categories.includes(meta.category))throw new Error('Choose an existing category.');
 const source=meta.source?arxiv(meta.source).source:'';
 const keywords=normalizeKeywords(meta.keywords??[]);
 return {title:meta.title.trim(),date:meta.date,category:meta.category,source,method:String(meta.method||'').slice(0,100),abstract:String(meta.abstract||'').slice(0,15000),authors:(Array.isArray(meta.authors)?meta.authors:[]).slice(0,100).map(x=>String(x).slice(0,160)),keywords:keywords.length?keywords:suggestKeywords(meta,existingKeywords)};
}
export function suggest(meta,categories){
 const text=(meta.title+' '+meta.abstract).toLowerCase();const rules=[[/world model|jepa/,'World Models'],[/humanoid|whole.body|loco.manipulation/,'Whole-Body'],[/navigation/,'Navigation'],[/diffusion/,'Diffusion'],[/foundation model|large language/,'Foundation'],[/grasp|manipulation/,'Manipulation']];
 for(const [pattern,topic] of rules)if(pattern.test(text)){const category=categories.find(c=>c.includes(topic));if(category)return {category,method:'',keywords:[],basis:'Keyword suggestion'};}
 return {category:categories[0],method:'',keywords:[],basis:'Choose a category'};
}
export async function limited(response,limit){if(!response.ok)throw new Error('Paper source returned HTTP '+response.status+'.');const declared=Number(response.headers.get('content-length'));if(declared>limit)throw new Error('File exceeds the size limit.');const reader=response.body.getReader(),chunks=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw new Error('File exceeds the size limit.');chunks.push(value);}}catch(e){await reader.cancel();throw e;}const bytes=new Uint8Array(length);let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}return bytes;}

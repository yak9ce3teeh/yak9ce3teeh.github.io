import {bindings,json,paper,record} from '../../../../../lib/cloud';
import {storage,objectKey} from '../../../../../lib/spaces';
import {limited} from '../../../../../lib/papers.mjs';
import {MAX_READING_JSON,validateBlocks} from '../../../../../lib/reading-extract';
import {hex} from '../../../../../lib/accounts';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const {id}=await params, row=await paper(request,id);
 if(!row)return json({error:'Paper not found'},404);
 const r=record(row), url=new URL(request.url);
 let content;
 if(r.format==='text'){
  const object=await (await storage({...row,id:row.space_id})).get(objectKey(row),null);
  if(!object)return json({error:'The reading snapshot is unavailable.'},404);
  const data=await limited(new Response(object),MAX_READING_JSON);
  if(hex(await crypto.subtle.digest('SHA-256',data))!==r.sha256)
   return json({error:'The reading snapshot does not match its saved fingerprint.'},502);
  content=validateBlocks(JSON.parse(new TextDecoder().decode(data)));
 }
 let snapshot:any={};
 if(r.archived){
  const object=await bindings().BUCKET.get('archive/reader/'+r.fileId+'.json');
  if(!object)return json({error:'The archived reading snapshot is unavailable.'},502);
  snapshot=await object.json();
  if(snapshot.fileId!==r.fileId||snapshot.pdf?.sha256!==r.sha256)
   return json({error:'The archived reading snapshot does not match this PDF.'},502);
 }
 const linked=r.zoteroLinks[url.searchParams.get('serverId')||''];
 const zotero=linked||snapshot.zotero||null;
 return json({
  schemaVersion:1,spaceId:row.space_id,fileId:r.fileId,title:r.title,category:r.category,
  materialType:r.materialType,format:r.format,originalFormat:r.originalFormat,content,contentSha256:r.sha256,
  keywords:r.keywords,date:r.date,source:r.source,method:r.method,revision:snapshot.exportedAt||row.created,
  zotero,zoteroLinks:r.zoteroLinks,mapping:r.materialType!=='paper'?{status:'not_applicable'}:linked?{status:'matched'}:snapshot.mapping||{status:'unlinked'},
  pdf:r.pdfUrl?{url:url.origin+r.pdfUrl,sha256:r.sha256}:null,annotations:snapshot.annotations||[],notes:snapshot.notes||[]
 });
}

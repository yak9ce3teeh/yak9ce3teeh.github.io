import {paper,json} from '../../../../../lib/cloud';
import {storage,objectKey} from '../../../../../lib/spaces';
import {parseRange} from '../../../../../lib/papers.mjs';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 const row=await paper(request,id);
 if(!row||JSON.parse(row.metadata).format==='text')return json({error:'PDF not found.'},404);
 const store=await storage({...row,id:row.space_id}),key=objectKey(row);
 const size=row.byte_size??await store.size(key);
 if(size===null)return json({error:'PDF unavailable.'},404);
 const headers=new Headers({
  'Content-Type':'application/pdf','Content-Disposition':'inline; filename="paper.pdf"',
  'Access-Control-Expose-Headers':'Content-Length, Content-Range, Accept-Ranges',
  'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'
 });
 let range;
 try{range=parseRange(request.headers.get('Range'),size);}catch{
  headers.set('Content-Range','bytes */'+size);
  return new Response(null,{status:416,headers});
 }
 const stream=await store.get(key,range);
 if(!stream)return json({error:'PDF unavailable.'},404);
 headers.set('Content-Length',String(range?.length??size));
 if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${size}`);
 return new Response(stream,{status:range?206:200,headers});
}

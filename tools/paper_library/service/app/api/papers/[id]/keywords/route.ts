import {bindings,paper,json,record} from '../../../../../lib/cloud';
import {normalizeKeywords} from '../../../../../public/keywords.mjs';
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){try{
 if(Number(request.headers.get('content-length'))>10000)throw new Error('Keyword update is too large.');
 const {id}=await params,row=await paper(request,id);if(!row)return json({error:'Paper not found.'},404);
 const value:any=await request.json(),keywords=normalizeKeywords(value.keywords),expected=value.expectedKeywords;normalizeKeywords(expected);
 if(!keywords.length)throw new Error('Enter at least one keyword.');
 const meta=JSON.parse(row.metadata);if(JSON.stringify(meta.keywords||[])!==JSON.stringify(expected))return json({error:'Keywords changed in another window. Reload before editing.'},409);
 const result=await bindings().DB.prepare("UPDATE papers SET metadata=json_set(metadata,'$.keywords',json(?)) WHERE id=? AND metadata=?").bind(JSON.stringify(keywords),row.id,row.metadata).run();
 const changes=result.meta?.changes??(result as any).changes;if(changes!==1)return json({error:'Paper details changed. Reload before editing.'},409);
 return json({paper:record(await paper(request,id))});
 }catch(e){return json({error:(e as Error).message},400);}}

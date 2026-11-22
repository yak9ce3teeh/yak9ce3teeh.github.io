import {bindings,json,record} from './cloud';
import {AccountError,hex} from './accounts';
import {storage,type Space} from './spaces';

export function bySource(space:Space,sourceId:string){
 return bindings().DB.prepare('SELECT * FROM papers WHERE space_id=? AND source_id=? ORDER BY id LIMIT 1')
  .bind(space.id,sourceId).first();
}

export async function saveMaterial({
 space,sourceId,meta,data,format
}:{
 space:Space;sourceId:string|null;meta:object;data:Uint8Array<ArrayBuffer>;format:'pdf'|'text'
}){
 const {DB}=bindings();
 const sha=hex(await crypto.subtle.digest('SHA-256',data));
 const byHash=()=>DB.prepare('SELECT * FROM papers WHERE space_id=? AND sha256=? ORDER BY id LIMIT 1').bind(space.id,sha).first();
 const existing=await byHash();
 if(existing)return json({already:true,paper:record(existing)});
 const store=await storage(space);
 const key='paper-library/'+space.id+'/'+format+'/'+crypto.randomUUID()+(format==='pdf'?'.pdf':'.json');
 await store.put(key,data,format==='pdf'?'application/pdf':'application/json');
 let row;
 try{
  row=await DB.prepare(`INSERT INTO papers(source_id,sha256,metadata,created,space_id,object_key,byte_size)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`)
   .bind(sourceId,sha,JSON.stringify(meta),new Date().toISOString(),space.id,key,data.length).first();
 }catch(error){
  // A transport failure can follow a successful commit. Check before deleting the object.
  const committed=await DB.prepare('SELECT * FROM papers WHERE object_key=?').bind(key).first();
  if(committed)return json({already:false,paper:record(committed)},201);
  await store.remove(key);
  throw error;
 }
 if(row)return json({already:false,paper:record(row)},201);
 await store.remove(key);
 const duplicate=await byHash()||(sourceId?await bySource(space,sourceId):null);
 if(duplicate)return json({already:true,paper:record(duplicate)});
 throw new AccountError('Cloud save failed. Your form has been kept.',502);
}

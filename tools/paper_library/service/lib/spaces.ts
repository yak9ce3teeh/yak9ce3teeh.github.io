import {AwsClient} from 'aws4fetch';
import {bindings,json} from './cloud';
import {AccountError,limit,requireUser} from './accounts';
import {body} from './translation';

export type Space = {id:string; user_id:string; name:string; kind:'legacy'|'r2'; config:string|null};
type R2Config = {accountId:string;bucket:string;accessKeyId:string;secretAccessKey:string};
const encoder = new TextEncoder();
const bytes = (str:string) => Uint8Array.from(atob(str),c=>c.charCodeAt(0));
const base64 = (data:Uint8Array) => btoa(String.fromCharCode(...data));

async function encryptionKey() {
 const supplied = bindings().SPACE_ENCRYPTION_KEY;
 if(!supplied||!/^[a-f0-9]{64}$/.test(supplied))throw new AccountError('External R2 storage is unavailable.',503);
 const raw=Uint8Array.from(supplied.match(/../g)!,v=>parseInt(v,16));
 return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
async function encrypt(value:R2Config,id:string) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const data = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(id)},await encryptionKey(),encoder.encode(JSON.stringify(value)));
 return base64(iv)+'.'+base64(new Uint8Array(data));
}
async function decrypt(space:Space):Promise<R2Config> {
 const [iv,data] = space.config!.split('.');
 const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(space.id)},await encryptionKey(),bytes(data));
 return JSON.parse(new TextDecoder().decode(plain));
}
function settings(input:any):R2Config {
 const accountId=String(input?.accountId||'').trim(),bucket=String(input?.bucket||'').trim(),
  accessKeyId=String(input?.accessKeyId||'').trim(),secretAccessKey=String(input?.secretAccessKey||'').trim();
 if(!/^[a-f0-9]{32}$/.test(accountId)||! /^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bucket)
    || !/^[a-f0-9]{32}$/i.test(accessKeyId)||! /^[a-f0-9]{64}$/i.test(secretAccessKey))
  throw new AccountError('Enter your Cloudflare account ID, R2 bucket name, access key ID and secret access key.',400);
 return {accountId,bucket,accessKeyId,secretAccessKey};
}
function remoteClient(config:R2Config){
 const aws = new AwsClient({accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey,service:'s3',region:'auto',retries:0});
 return async (method:string,key:string,body?:Uint8Array<ArrayBuffer>,headers?:HeadersInit)=>{
  const path = key.split('/').map(encodeURIComponent).join('/');
  return aws.fetch(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${path}`,
   {method,body,headers,redirect:'error',signal:AbortSignal.timeout(25000)});
 };
}
export async function storage(space:Space) {
 if(space.kind==='legacy')return {
  async put(key:string,data:Uint8Array<ArrayBuffer>,contentType='application/pdf'){await bindings().BUCKET.put(key,data,{httpMetadata:{contentType}});},
  async remove(key:string){await bindings().BUCKET.delete(key);},
  async get(key:string,range:{offset:number;length:number}|null){return (await bindings().BUCKET.get(key,range?{range}:{}))?.body??null;},
  async size(key:string){return (await bindings().BUCKET.head(key))?.size??null;}
 };
 const call=remoteClient(await decrypt(space));
 async function checked(response:Response) {
  if(!response.ok){
   await response.body?.cancel();
   throw new AccountError('The R2 bucket could not be accessed. Check its credentials and permissions.',502);
  }
  return response;
 }
 return {
  async put(key:string,data:Uint8Array<ArrayBuffer>,contentType='application/pdf'){await checked(await call('PUT',key,data,{'Content-Type':contentType}));},
  async remove(key:string){await checked(await call('DELETE',key));},
  async get(key:string,range:{offset:number;length:number}|null){
   const response=await call('GET',key,undefined,range?{Range:`bytes=${range.offset}-${range.offset+range.length-1}`}:undefined);
   if(response.status===404){await response.body?.cancel();return null;}
   await checked(response);
   if(range&&response.status!==206){await response.body?.cancel();throw new AccountError('R2 did not return the expected PDF range.',502);}
   return response.body;
  },
  async size(key:string){
   const response=await call('HEAD',key);if(response.status===404)return null;
   await checked(response);
   const header=response.headers.get('Content-Length');return header===null?null:Number(header);
  }
 };
}
export const objectKey=(row:any)=>row.object_key||'pdf/'+row.sha256;
export async function selectedSpace(request:Request) {
 const user=await requireUser(request);
 const id=new URL(request.url).searchParams.get('space');
 const space=await bindings().DB.prepare('SELECT * FROM library_spaces WHERE id=? AND user_id=?')
  .bind(id||'',user.id).first<Space>();
 if(!space)throw new AccountError(id?'Space not found.':'Choose a cloud space first.',id?404:400);
 return space;
}
export async function spacesRoute(request:Request){
 const user=await requireUser(request), db=bindings().DB;
 if(request.method==='GET'){
  const rows=await db.prepare('SELECT id,name,kind FROM library_spaces WHERE user_id=? ORDER BY kind,name').bind(user.id).all();
  return json({spaces:rows.results});
 }
 if(request.method!=='POST')return json({error:'Method unavailable.'},405);
 await limit(request,'space-connect',8,user.id);
 const input=await body(request),name=typeof input?.name==='string'?input.name.trim():'';
 if(!name||name.length>60)throw new AccountError('Use a space name of up to 60 characters.',400);
 const config=settings(input),id=crypto.randomUUID();
 const encrypted=await encrypt(config,id),call=remoteClient(config),probe='paper-library/'+id+'/connection-check';
 let written=false;
 try{
  const put=await call('PUT',probe,encoder.encode('Paper Library connection check'));
  written=put.ok;await put.body?.cancel();
  if(!written)throw Error();
  const head=await call('HEAD',probe);
  if(!head.ok)throw Error();
 }catch{
  throw new AccountError('Could not verify R2 read and write access. Check the bucket and its Object Read & Write token.',400);
 }finally{
  if(written){
   const removed=await call('DELETE',probe).catch(()=>null);
   if(!removed?.ok){await removed?.body?.cancel();throw new AccountError('R2 credentials must also allow object deletion. Remove the connection-check object from this bucket.',400);}
  }
 }
 const saved=await db.prepare(`INSERT INTO library_spaces(id,user_id,name,kind,config)
  SELECT ?,?,?,'r2',? WHERE (SELECT COUNT(*) FROM library_spaces WHERE user_id=?)<12
  ON CONFLICT DO NOTHING RETURNING id,name,kind`).bind(id,user.id,name,encrypted,user.id).first();
 if(!saved)throw new AccountError('Use a different space name or check your space limit (12).',409);
 return json({space:saved},201);
}
export async function spaceUsage(request:Request) {
 const space=await selectedSpace(request);
 const db=bindings().DB;
 const old=await db.prepare('SELECT id,sha256,object_key FROM papers WHERE space_id=? AND byte_size IS NULL LIMIT 50').bind(space.id).all();
 if(old.results.length){
  const bucket=await storage(space);
  for(const row of old.results){
   const size=await bucket.size(objectKey(row));
   if(size!==null)await db.prepare('UPDATE papers SET byte_size=? WHERE id=? AND byte_size IS NULL').bind(size,row.id).run();
  }
 }
 const row=await db.prepare('SELECT COUNT(*) AS objects,SUM(byte_size) AS bytes,COUNT(byte_size) AS measured FROM papers WHERE space_id=?')
  .bind(space.id).first<{objects:number;bytes:number|null;measured:number}>();
 return json({name:space.name,r2:{bytes:row?.bytes??0,objects:row?.objects??0,complete:row?.objects===row?.measured},sampledAt:new Date().toISOString()});
}

import {env} from 'cloudflare:workers';
import {principal,requireUser} from './accounts';
export const bindings=()=>env as unknown as {DB:D1Database; BUCKET:R2Bucket; LIBRARY_ACCESS_KEY?:string; DEEPSEEK_API_KEY?:string; DEV_ORIGIN?:string; SPACE_ENCRYPTION_KEY?:string};
export const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export async function legacyAuthorized(request:Request){
 const configured=bindings().LIBRARY_ACCESS_KEY, supplied=request.headers.get('Authorization')?.match(/^Bearer ([^ ]{1,256})$/)?.[1];
 if(!configured || configured.length<32 || !supplied)return false;
 const hash=(s:string)=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
 const [a,b]=await Promise.all([hash(configured),hash(supplied)]);
 return crypto.subtle.timingSafeEqual(a,b);
}
export async function authorized(request:Request){return !!(await principal(request))?.admin;}
export async function paper(request:Request,id:string){
 if(!/^(0|[1-9]\d{0,8})$/.test(id))return null;
 const user=await requireUser(request);
 const space=new URL(request.url).searchParams.get('space');
 const column=Number(id)<1000000?'p.archive_file_id':'p.id';
 return bindings().DB.prepare(`SELECT p.*,s.user_id,s.name,s.kind,s.config FROM papers p
  JOIN library_spaces s ON s.id=p.space_id WHERE ${column}=? AND s.user_id=? AND (? IS NULL OR s.id=?)`)
  .bind(Number(id)<1000000?Number(id):Number(id)-1000000,user.id,space,space).first<any>();
}
export function record(row:any){const meta=JSON.parse(row.metadata);const fileId=row.archive_file_id??1000000+row.id;return {...meta,materialType:meta.materialType||'paper',format:meta.format||'pdf',fileId,sha256:row.sha256,archived:row.archive_file_id!=null,zoteroLinks:row.zotero?JSON.parse(row.zotero):{},created:row.created,pdfUrl:meta.format==='text'?null:'/api/papers/'+fileId+'/pdf',readerUrl:'https://yak9ce3teeh.github.io/papers/reader/?id='+fileId};}

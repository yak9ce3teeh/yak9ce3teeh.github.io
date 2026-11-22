import {bindings} from './cloud';
export async function bucketUsage(prefix?:string){
 let bytes=0,objects=0,cursor:string|undefined;
 for(let page=0;page<10;page++){
  const result=await bindings().BUCKET.list({limit:1000,cursor,...(prefix?{prefix}:{})});
  for(const object of result.objects){bytes+=object.size;objects++;}
  if(!result.truncated)return {bytes,objects,complete:true};
  cursor=result.cursor;
 }
 return {bytes,objects,complete:false};
}

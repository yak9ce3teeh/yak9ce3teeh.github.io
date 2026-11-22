import {bindings,authorized,json} from './cloud';
export const reply=(_request:Request,value:unknown,status=200)=>json(value,status);
export const session=authorized;
export const secret=()=>bindings().DEEPSEEK_API_KEY;
export const preflight=()=>new Response(null,{status:204});
export async function body(request:Request){if(Number(request.headers.get('content-length'))>20000)throw new Error('Request is too large.');const reader=request.body?.getReader();if(!reader)throw new Error('Request body required.');let size=0,text='';const decoder=new TextDecoder();for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>20000){await reader.cancel();throw new Error('Request is too large.');}text+=decoder.decode(chunk.value,{stream:true});}return JSON.parse(text+decoder.decode());}
export async function quota(){
 const now=new Date();
 const row=await bindings().DB.prepare(`
  INSERT INTO translation_limits(day,minute,minute_used,day_used) VALUES(?,?,1,1)
  ON CONFLICT(day) DO UPDATE SET
   minute=excluded.minute,
   minute_used=CASE WHEN minute=excluded.minute THEN minute_used+1 ELSE 1 END,
   day_used=day_used+1
  WHERE day_used<200 AND (minute!=excluded.minute OR minute_used<20)
  RETURNING day_used
 `).bind(now.toISOString().slice(0,10),Math.floor(now.getTime()/60000)).first();
 return !!row;
}

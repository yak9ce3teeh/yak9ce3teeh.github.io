import {selectedSpace} from '../../../../lib/spaces';
import {AccountError,limit} from '../../../../lib/accounts';
import {body} from '../../../../lib/translation';
import {extractPage,fetchReading,MAX_HTML,readingUrl} from '../../../../lib/reading-extract';
import {json} from '../../../../lib/cloud';

export async function POST(request:Request){
 const space=await selectedSpace(request);
 await limit(request,'reading-source-ip',40);
 await limit(request,'reading-source',15,space.user_id);
 if(request.headers.get('Content-Type')?.startsWith('multipart/form-data')){
  if(Number(request.headers.get('Content-Length'))>MAX_HTML+10000)
   throw new AccountError('The page is too large to capture.',413);
  let data;
  try{data=await request.formData();}catch{throw new AccountError('Invalid browser capture.',400);}
  const url=readingUrl(data.get('url')),file=data.get('html');
  if(!(file instanceof File)||file.size>MAX_HTML||!['text/html','text/plain','application/xhtml+xml'].includes(file.type))
   throw new AccountError('This reading could not be captured as web text.',422);
  try{return json({format:'text',source:url.href,...extractPage(await file.text(),file.type)});}
  catch(error){
   if(error instanceof AccountError)throw error;
   throw new AccountError('This site’s layout could not be converted into readable text.',422);
  }
 }
 let input;
 try{input=await body(request);}
 catch{throw new AccountError('Enter a valid reading URL.',400);}
 try{
  const result=await fetchReading(input?.url,input?.projection===true);
  if(result.format!=='pdf')return json(result);
  return new Response(result.bytes,{
   headers:{'Content-Type':'application/pdf','X-Reading-Source':result.source,'Access-Control-Expose-Headers':'X-Reading-Source'}
  });
 }catch(error){
  if(error instanceof AccountError)throw error;
  throw new AccountError('Could not read this website. Try a PDF or DOCX upload.',422);
 }
}

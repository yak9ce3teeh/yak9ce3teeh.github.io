import {bindings,json,record} from '../../../lib/cloud';
import {arxiv,validate,limited,MAX_PDF,sourceFetch} from '../../../lib/papers.mjs';
import categories from '../../../lib/categories.json';
import {keywordVocabulary} from '../../../lib/keywords';
import {AccountError,limit} from '../../../lib/accounts';
import {selectedSpace} from '../../../lib/spaces';
import {bySource,saveMaterial} from '../../../lib/material-store';

export async function GET(request:Request){
 const space=await selectedSpace(request);
 const rows=await bindings().DB.prepare('SELECT * FROM papers WHERE space_id=? ORDER BY id DESC LIMIT 2000').bind(space.id).all();
 return json({papers:rows.results.map(record),keywordVocabulary:await keywordVocabulary(space.id)});
}

export async function POST(request:Request){
 const space=await selectedSpace(request);
 try{
  if(Number(request.headers.get('content-length'))>MAX_PDF+50000)throw new AccountError('PDF limit: 25 MB.',413);
  await limit(request,'paper-upload',15,space.user_id);
  const form=await request.formData();
  const input=JSON.parse(String(form.get('metadata')||'{}'));
  const meta=validate(input,categories,input?.keywords?.length?[]:await keywordVocabulary(space.id));
  const sourceId=meta.source?arxiv(meta.source).id:null;
  if(sourceId){
   const existing=await bySource(space,sourceId);
   if(existing)return json({already:true,paper:record(existing)});
  }
  const file=form.get('pdf');
  let data:Uint8Array<ArrayBuffer>;
  if(file instanceof File){
   if(file.size>MAX_PDF)throw new AccountError('PDF limit: 25 MB.',413);
   data=new Uint8Array(await file.arrayBuffer());
  }else{
   if(!sourceId)throw new AccountError('Upload a PDF or enter an arXiv ID.',400);
   const source=arxiv(meta.source);
   data=await limited(await sourceFetch('https://arxiv.org/pdf/'+source.id+source.version,60000),MAX_PDF);
  }
  if(new TextDecoder().decode(data.slice(0,5))!=='%PDF-')throw new AccountError('The paper source did not return a valid PDF.',400);
  return await saveMaterial({space,sourceId,meta,data,format:'pdf'});
 }catch(error){
  if(error instanceof AccountError)throw error;
  if(error instanceof SyntaxError)return json({error:'Invalid paper details.'},400);
  const message=error instanceof Error?error.message:'';
  // Validation errors are user-readable. Storage/backend errors never expose identifiers or credentials.
  if(/^(A paper title|Enter a valid publication|Choose an existing category|Enter up to|Enter an arXiv|arXiv IDs|Paper source returned|File exceeds)/.test(message))
   return json({error:message},400);
  return json({error:'Could not save this paper. Your form has been kept.'},502);
 }
}

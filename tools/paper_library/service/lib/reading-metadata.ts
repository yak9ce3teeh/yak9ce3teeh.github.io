import {bindings} from './cloud';
import {AccountError} from './accounts';
import categories from './categories.json';
import {suggestKeywords,normalizeKeywords,mergeKeywordVocabulary,preferExistingKeywords} from '../public/keywords.mjs';

export const otherReadingCategory='Other readings/Uncategorized';
const types=new Set(['blog','technical-report','other']);
const validCategories=new Set([...categories,otherReadingCategory]);
const words=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/);
const generic=new Set(['readings','uncategorized','foundations','methods','surveys','models','other','advanced','using','research','general']);

function inferCategory(title:string,sample:string,records:any[]){
 const titleWords=new Set(words(title));
 const bodyWords=new Set(words(sample));
 const scores=new Map<string,number>();
 const evidence=(phrase:string)=>{
  const tokens=words(phrase).filter(word=>word.length>=3&&!generic.has(word));
  if(!tokens.length||!tokens.every(word=>bodyWords.has(word)||titleWords.has(word)))return 0;
  const headline=tokens.every(word=>titleWords.has(word));
  // Short single terms should count only if prominent in the title.
  return tokens.length>1?(headline?6:3):headline?2:0;
 };
 for(const category of categories){
  const parts=category.split(/\/| and | & |,/).map(part=>part.trim());
  scores.set(category,Math.max(0,...parts.map(evidence)));
 }
 const matched=new Map<string,Set<string>>();
 for(const record of records){
  if(!scores.has(record.category))continue;
  if(!matched.has(record.category))matched.set(record.category,new Set());
  const tags=matched.get(record.category)!;
  for(const value of (record.keywords||[])){
   if(evidence(value)>=3)tags.add(value.toLowerCase());
  }
 }
 for(const [category,tags] of matched)scores.set(category,scores.get(category)!+Math.min(tags.size,5)*2);
 const text=title+' '+sample;
 const humanoid=/\b(?:humanoids?|unitree\s+g1)\b/i.test(text);
 const wholeBody='Humanoid Robotics/Whole-Body Control and Loco-Manipulation';
 if(humanoid&&/\b(?:closed kinematic loops?|ankles?|whole[- ]body control|loco[- ]manipulation)\b/i.test(text))
  scores.set(wholeBody,(scores.get(wholeBody)||0)+12);
 else if(humanoid&&/\bcontrol(?:ler|lers)?\b/i.test(title))
  scores.set(wholeBody,(scores.get(wholeBody)||0)+5);
 const [best,score]=[...scores].sort((a,b)=>b[1]-a[1])[0];
 return score>=2?best:otherReadingCategory;
}

function optionalDate(value:unknown){
 if(value===undefined||value==='')return '';
 if(typeof value!=='string'||!/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(value))
  throw new AccountError('Enter a year, month or date in YYYY, YYYY-MM or YYYY-MM-DD format.',400);
 const date=new Date(value.length===4?value+'-01-01':value.length===7?value+'-01':value);
 if(Number.isNaN(date.getTime())||date.toISOString().slice(0,value.length)!==value)
  throw new AccountError('Enter a valid reading date.',400);
 return value;
}

export async function readingMetadata(value:any,{title,body,spaceId}:{title:string;body:string;spaceId:string}){
 if(!types.has(value?.materialType))throw new AccountError('Choose Blog, Technical report or Other materials.',400);
 if(value.category&&!validCategories.has(value.category))throw new AccountError('Choose an existing category.',400);
 const name=typeof value.title==='string'&&value.title.trim()?value.title.trim():title.trim();
 if(!name||name.length>500)throw new AccountError('Enter a reading title up to 500 characters.',400);
 const date=optionalDate(value.date);
 let supplied;
 try{supplied=normalizeKeywords(value.keywords??[]);}
 catch{throw new AccountError('Enter up to 30 keywords, each up to 100 characters.',400);}
 const rows=await bindings().DB.prepare('SELECT metadata FROM papers WHERE space_id=? ORDER BY id DESC LIMIT 2000').bind(spaceId).all();
 const documents=rows.results.map((row:any)=>JSON.parse(row.metadata));
 const vocabulary=mergeKeywordVocabulary(documents.flatMap(doc=>doc.keywords||[]));
 const abstract=body.slice(0,15000);
 const text=name+' '+abstract;
 const concepts=[
  ['MuJoCo',/\bmujoco\b/i],
  ['Closed-chain kinematics',/\bclosed (?:kinematic loops?|chains?)\b|\bclosed[- ]loop (?:mechanism|linkage|transmission)\b/i],
  ['Unitree G1',/\bunitree\s+g1\b/i]
 ].filter(([,pattern])=>(pattern as RegExp).test(text)).map(([label])=>label as string);
 return {
  title:name,date,materialType:value.materialType,
  category:value.category||inferCategory(name,abstract,documents),
  keywords:supplied.length?supplied:preferExistingKeywords([...concepts,...suggestKeywords({title:name,abstract},vocabulary)],vocabulary),
 };
}

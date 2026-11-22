import baseline from './keyword-vocabulary.json';
import {bindings} from './cloud';
import {mergeKeywordVocabulary} from '../public/keywords.mjs';

export async function keywordVocabulary(spaceId:string|null){
 if(!spaceId)return baseline;
 const rows=await bindings().DB.prepare('SELECT metadata FROM papers WHERE space_id=? ORDER BY id DESC LIMIT 2000').bind(spaceId).all();
 const cloud=rows.results.flatMap((row:any)=>JSON.parse(row.metadata).keywords||[]);
 // Existing published spellings win over variant cloud spellings.
 return mergeKeywordVocabulary(baseline,cloud);
}

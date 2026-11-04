import {keywordCandidates,mergeKeywordVocabulary,keywordKey,preferExistingKeywords} from './keywords.mjs?v=20261104-tags-1';
let extractorPromise;
export async function rankSuggestions(meta,categories,extractor,existing=[]){
 const grounded=keywordCandidates(meta,existing),vocabulary=mergeKeywordVocabulary(existing);
 const candidates=mergeKeywordVocabulary(vocabulary,grounded);
 const result=await extractor([meta.title+'. '+(meta.abstract||'').slice(0,6000),...categories.map(c=>'Research on '+c.replaceAll('/','; ')),...candidates],{pooling:'mean',normalize:true});
 const vectors=result.tolist(),score=i=>vectors[0].reduce((s,x,j)=>s+x*vectors[i][j],0);
 const scores=categories.map((category,i)=>({category,score:score(i+1)})).sort((a,b)=>b.score-a.score);
 const ranked=candidates.map((keyword,i)=>({keyword,score:score(1+categories.length+i)})).sort((a,b)=>b.score-a.score);
 const groundedKeys=new Set(grounded.map(keywordKey)),known=new Set(vocabulary.map(keywordKey));
 const best=ranked[0]?.score||0;
 const relevant=ranked.filter(x=>groundedKeys.has(keywordKey(x.keyword))||(known.has(keywordKey(x.keyword))&&x.score>=Math.max(0.45,best*0.85)));
 return {category:scores[0].category,keywords:preferExistingKeywords(relevant.map(x=>x.keyword),vocabulary),basis:'Free MiniLM suggestions: existing tags first; new proposals only for uncovered topics. Review before saving.',alternatives:scores.slice(0,3)};
}
export async function classify(meta,categories,progress=()=>{},existing=[]){
 progress('Loading the free MiniLM model. The first download is cached by your browser…');
 if(!extractorPromise)extractorPromise=(async()=>{const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2');env.allowLocalModels=false;return pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'q8',device:'wasm'});})();
 try{const extractor=await extractorPromise;progress('Matching existing tags before proposing new keywords…');return await rankSuggestions(meta,categories,extractor,existing);}catch(e){extractorPromise=null;throw new Error('Free AI could not load. Keep the extracted keywords and choose a category manually; cloud saving is still available.');}
}

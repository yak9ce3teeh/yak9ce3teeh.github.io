import {keywordCandidates,selectKeywords} from './keywords.mjs';
let extractorPromise;
export async function rankSuggestions(meta,categories,extractor){
 const candidates=keywordCandidates(meta);
 const result=await extractor([meta.title+'. '+(meta.abstract||'').slice(0,6000),...categories.map(c=>'Research on '+c.replaceAll('/','; ')),...candidates],{pooling:'mean',normalize:true});
 const vectors=result.tolist(),score=i=>vectors[0].reduce((s,x,j)=>s+x*vectors[i][j],0);
 const scores=categories.map((category,i)=>({category,score:score(i+1)})).sort((a,b)=>b.score-a.score);
 const ranked=candidates.map((keyword,i)=>({keyword,score:score(1+categories.length+i)})).sort((a,b)=>b.score-a.score);
 return {category:scores[0].category,keywords:selectKeywords(ranked.map(x=>x.keyword)),basis:'Free MiniLM category and keyword suggestions — review before saving',alternatives:scores.slice(0,3)};
}
export async function classify(meta,categories,progress=()=>{}){
 progress('Loading the free MiniLM model. The first download is cached by your browser…');
 if(!extractorPromise)extractorPromise=(async()=>{const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2');env.allowLocalModels=false;return pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'q8',device:'wasm'});})();
 try{const extractor=await extractorPromise;progress('Suggesting a category and English keywords…');return await rankSuggestions(meta,categories,extractor);}catch(e){extractorPromise=null;throw new Error('Free AI could not load. Keep the extracted keywords and choose a category manually; cloud saving is still available.');}
}

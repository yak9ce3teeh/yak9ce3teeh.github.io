// Shared, free keyword extraction for metadata, uploaded PDFs and MiniLM candidates.
// These are suggestions grounded in the supplied title/abstract, never invented tags.
const terms=[
 ['Humanoid robotics',/\bhumanoid\b/i],['World models',/\bworld[ -]models?\b/i],
 ['Unsupervised reinforcement learning',/\bunsupervised (?:reinforcement learning|RL)\b/i],
 ['Reinforcement learning',/\breinforcement learning\b|\bRL\b/],['Goal-conditioned learning',/\bgoal[ -]conditioned\b/i],
 ['Joint-embedding predictive architecture',/\bJEPA\b|joint[ -]embedding predictive/i],
 ['Motion tracking',/\bmotion[ -]tracking\b/i],['Whole-body control',/\bwhole[ -]body\b/i],
 ['Robot manipulation',/\bmanipulation\b/i],['Dexterous manipulation',/\bdexterous\b/i],
 ['Vision-language-action models',/\bvision[ -]language[ -]action\b|\bVLA\b/],
 ['Vision-language models',/\bvision[ -]language models?\b|\bVLMs?\b/],
 ['Large language models',/\blarge language models?\b|\bLLMs?\b/],
 ['Foundation models',/\bfoundation models?\b/i],['Diffusion models',/\bdiffusion\b/i],
 ['Imitation learning',/\bimitation learning\b/i],['Offline reinforcement learning',/\boffline (?:reinforcement learning|RL)\b/i],
 ['Model predictive control',/\bmodel[ -]predictive control\b|\bMPC\b/],
 ['Visual navigation',/\bvisual navigation\b/i],['Vision-language navigation',/\bvision[ -]language navigation\b|\bVLN\b/],
 ['Robot navigation',/\bnavigation\b/i],['Spatial reasoning',/\bspatial reasoning\b/i],
 ['3D scene graphs',/\b(?:3D )?scene graphs?\b/i],['Embodied memory',/\b(?:embodied|robot(?:ic)?|spatial) memory\b/i],
 ['Multi-agent systems',/\bmulti[ -]agent\b/i],['Task planning',/\btask planning\b/i],
 ['Chain-of-thought reasoning',/\bchain[ -]of[ -]thought\b/i],['Tactile sensing',/\btactile\b/i],
 ['Contact-rich manipulation',/\bcontact[ -]rich\b/i],['Zero-shot transfer',/\bzero[ -]shot\b/i],
 ['Sim-to-real transfer',/\bsim[ -]to[ -]real\b/i],['Human motion priors',/\bhuman motion\b/i],
 ['Robot locomotion',/\blocomo(?:tion|tor)\b/i],['Representation learning',/\brepresentation learning\b/i],
 ['Retrieval-augmented generation',/\bretrieval[ -]augmented\b|\bRAG\b/],
 ['Efficient inference',/\befficient inference\b/i],['Model compression',/\b(?:model compression|(?:model |weight )?quantization|knowledge distillation)\b/i],
 ['Robotic grasping',/\bgrasp(?:ing)?\b/i],['Robot learning',/\brobot learning\b/i]
];
const stop=new Set('a an the of for and or in on to via with from by at as into towards toward using through beyond based novel new approach method model models framework study learning paper research experiments results performance'.split(' '));
export function normalizeKeywords(value){
 if(!Array.isArray(value)||value.length>30||value.some(x=>typeof x!=='string'||x.length>100))throw new Error('Enter up to 30 keywords, each up to 100 characters.');
 const seen=new Set();return value.map(x=>x.trim().replace(/\s+/g,' ')).filter(x=>x&&!seen.has(x.toLowerCase())&&seen.add(x.toLowerCase()));
}
export function keywordCandidates(meta,existing=[]){
 const title=String(meta.title||'').slice(0,500),abstract=String(meta.abstract||'').slice(0,15000),text=title+' '+abstract;
 const matchedTerms=terms.filter(([,pattern])=>pattern.test(text));
 const matched=matchedTerms.map(([label])=>label);
 const method=title.match(/^([A-Za-z][\w-]{1,29}):/)?.[1];
 const chunks=title.split(/[^A-Za-z0-9-]+/).reduce((out,word)=>{if(!word||stop.has(word.toLowerCase()))out.push([]);else out[out.length-1].push(word);return out;},[[]]);
 const phrases=[];for(const chunk of chunks){for(let n=Math.min(3,chunk.length);n>=1;n--)for(let i=0;i<=chunk.length-n;i++){const phrase=chunk.slice(i,i+n).join(' ');if(phrase.length>=3&&/[A-Za-z]/.test(phrase)&&phrase!==method)phrases.push(phrase);}}
 const generated=normalizeKeywords([...new Set([...(method?[method]:[]),...matched,...phrases])].slice(0,30));
 if(!existing.length)return generated;
 const textKey=' '+plain(text)+' ';
 const relevant=mergeKeywordVocabulary(existing).filter(tag=>
  textKey.includes(' '+keywordKey(tag)+' ')||matched.some(label=>keywordKey(label)===keywordKey(tag)));
 // Title fragments and method names are fallback proposals, not extra tags to fill a quota.
 const uncovered=matchedTerms.filter(([label,pattern])=>{
  if(relevant.some(tag=>keywordKey(tag)===keywordKey(label)))return false;
  const phrases=[...text.matchAll(new RegExp(pattern.source,pattern.flags.replace('g','')+'g'))].map(match=>plain(match[0]));
  // A broad rule (e.g. "navigation") must not invent a new label when a
  // specific existing tag ("Zero-shot navigation") already covers its evidence.
  return phrases.some(phrase=>!relevant.some(tag=>(' '+plain(tag)+' ').includes(' '+phrase+' ')));
 }).map(([label])=>label);
 const fallback=chunks.filter(chunk=>chunk.length).map(chunk=>chunk.join(' ')).filter(phrase=>phrase.length>=3&&phrase.length<=100);
 return preferExistingKeywords([...relevant,...(matched.length?uncovered:relevant.length?[]:fallback)],existing,30);
}
export function selectKeywords(candidates,limit=6){
 const selected=[];for(const value of candidates){const words=value.toLowerCase().replace(/s\b/g,'');if(selected.some(v=>{const prior=v.toLowerCase().replace(/s\b/g,'');return prior.includes(words)||words.includes(prior);} ))continue;selected.push(value);if(selected.length===limit)break;}return selected;
}
const aliases=[
 ['Unsupervised RL','Unsupervised reinforcement learning'],['Offline RL','Offline reinforcement learning'],
 ['JEPA','Joint-embedding predictive architecture'],['VLA','Vision-language-action models'],
 ['VLM','Vision-language models'],['LLM','Large language models'],
 ['RAG','Retrieval-augmented generation'],['Sim-to-real','Sim-to-real transfer'],
 ['Chain of thought','Chain-of-thought reasoning'],['Manipulation','Robot manipulation'],
 ['Locomotion','Robot locomotion'],['MPC','Model predictive control']
];
const plain=value=>String(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
 .replace(/\brl\b/g,'reinforcement learning').replace(/\bjepa\b/g,'joint embedding predictive architecture')
 .replace(/\bvla\b/g,'vision language action model').replace(/\bvlm\b/g,'vision language model')
 .replace(/\bllm\b/g,'large language model').replace(/\brag\b/g,'retrieval augmented generation')
 .split(/\s+/).map(word=>word.length>4&&word.endsWith('ies')?word.slice(0,-3)+'y':word.length>3&&word.endsWith('s')?word.slice(0,-1):word).join(' ');
const equivalent=new Map(aliases.flatMap(group=>group.map(label=>[plain(label),plain(group[0])])));
export const keywordKey=value=>equivalent.get(plain(value))||plain(value);
export function mergeKeywordVocabulary(...lists){
 const seen=new Set();return lists.flat().filter(x=>typeof x==='string'&&x.trim()&&x.length<=100).map(x=>x.trim().replace(/\s+/g,' ')).filter(x=>!seen.has(keywordKey(x))&&seen.add(keywordKey(x)));
}
export function preferExistingKeywords(candidates,existing=[],limit=6){
 const vocabulary=mergeKeywordVocabulary(existing),known=new Map(vocabulary.map(x=>[keywordKey(x),x]));
 const canonical=candidates.map(x=>known.get(keywordKey(x))||x);
 const coverage=value=>' '+keywordKey(value).replace(/\brl\b/g,'reinforcement learning')+' ';
 const reused=canonical.filter(x=>known.has(keywordKey(x))).filter(value=>!canonical.some(other=>
  known.has(keywordKey(other))&&coverage(other)!==coverage(value)&&coverage(other).includes(coverage(value))));
 const rawProposals=canonical.filter(x=>!known.has(keywordKey(x))).filter(value=>!reused.some(prior=>
  coverage(prior).includes(coverage(value))||(keywordKey(value)==='humanoid robotic'&&keywordKey(prior).startsWith('humanoid '))));
 const proposed=rawProposals.filter(value=>!rawProposals.some(other=>coverage(other)!==coverage(value)&&coverage(other).includes(coverage(value))));
 return [...reused,...proposed].filter((value,index,all)=>{
  const key=keywordKey(value);return !all.slice(0,index).some(prior=>keywordKey(prior)===key);
 }).slice(0,limit);
}
export function suggestKeywords(meta,existing=[]){return preferExistingKeywords(keywordCandidates(meta,existing),existing);}

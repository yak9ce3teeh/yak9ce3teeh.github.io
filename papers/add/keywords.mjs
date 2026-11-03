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
export function keywordCandidates(meta){
 const title=String(meta.title||'').slice(0,500),abstract=String(meta.abstract||'').slice(0,15000),text=title+' '+abstract;
 const matched=terms.filter(([,pattern])=>pattern.test(text)).map(([label])=>label);
 const method=title.match(/^([A-Za-z][\w-]{1,29}):/)?.[1];
 const chunks=title.split(/[^A-Za-z0-9-]+/).reduce((out,word)=>{if(!word||stop.has(word.toLowerCase()))out.push([]);else out[out.length-1].push(word);return out;},[[]]);
 const phrases=[];for(const chunk of chunks){for(let n=Math.min(3,chunk.length);n>=1;n--)for(let i=0;i<=chunk.length-n;i++){const phrase=chunk.slice(i,i+n).join(' ');if(phrase.length>=3&&/[A-Za-z]/.test(phrase)&&phrase!==method)phrases.push(phrase);}}
 return normalizeKeywords([...new Set([...(method?[method]:[]),...matched,...phrases])].slice(0,30));
}
export function selectKeywords(candidates,limit=6){
 const selected=[];for(const value of candidates){const words=value.toLowerCase().replace(/s\b/g,'');if(selected.some(v=>{const prior=v.toLowerCase().replace(/s\b/g,'');return prior.includes(words)||words.includes(prior);} ))continue;selected.push(value);if(selected.length===limit)break;}return selected;
}
export function suggestKeywords(meta){return selectKeywords(keywordCandidates(meta));}

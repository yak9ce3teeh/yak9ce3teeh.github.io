import {useState,type ReactNode} from 'react';
import {keywordKey,mergeKeywordVocabulary} from './public/keywords.mjs';
import {splitCategory} from './category-model.mjs';
import {readerUrl} from './service';
import {materialType,materialTypes,materialLabel} from './material-types.mjs';

const codeLabels:Record<string,string>={
 open:'Open source', public:'Public code', restricted:'Restricted code', resources:'Resources only',
 not_released:'Not released', not_found:'Code not found', not_applicable:'Not applicable', unverified:'Unverified'
};
const codeStatus=(paper:any)=>Object.hasOwn(codeLabels,paper.codeStatus)?paper.codeStatus:'unverified';
const hasNotes=(paper:any)=>(paper.notesCount||0)+(paper.annotationCount||0)>0;
const sorted=(values:string[])=>[...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'en'));

export default function Catalogue({papers,state,retry,actions}:{papers:any[];state:string;retry:()=>void;actions:(paper:any)=>ReactNode}){
 const [search,setSearch]=useState(''),[area,setArea]=useState(''),[category,setCategory]=useState('');
 const [keyword,setKeyword]=useState(''),[year,setYear]=useState(''),[code,setCode]=useState(''),[notes,setNotes]=useState('');
 const [material,setMaterial]=useState('');
 const [sort,setSort]=useState('date');
 const topics=sorted(papers.map(p=>p.category||''));
 const areas=sorted(topics.map(topic=>splitCategory(topic).area));
 const keywords=sorted(mergeKeywordVocabulary(papers.flatMap(paper=>paper.keywords||[])));
 const years=sorted(papers.map(p=>(p.date||'').slice(0,4))).reverse();
 const query=search.trim().toLowerCase();
 const visible=papers.filter(paper=>{
  const topic=paper.category||'';
  return (!area||splitCategory(topic).area===area)
   &&(!material||materialType(paper)===material)
   &&(!category||topic===category)
   &&(!keyword||paper.keywords?.some((tag:string)=>keywordKey(tag)===keyword))
   &&(!year||(year==='unknown'?!paper.date:paper.date?.startsWith(year)))
   &&(!code||materialType(paper)==='paper'&&codeStatus(paper)===code)
   &&(!notes||hasNotes(paper)===(notes==='with'))
   &&(!query||[paper.title,paper.method,topic,...(paper.keywords||[])].some(value=>String(value||'').toLowerCase().includes(query)));
 });
 const byDate=(a:any,b:any)=>(b.date||'').localeCompare(a.date||'')||a.title.localeCompare(b.title);
 visible.sort((a,b)=>{
  if(sort==='title')return a.title.localeCompare(b.title);
  if(sort==='stars'||sort==='citations')return (b[sort]??-1)-(a[sort]??-1)||byDate(a,b);
  return byDate(a,b);
 });
 function clear(){setSearch('');setArea('');setCategory('');setKeyword('');setYear('');setCode('');setNotes('');setMaterial('');}
 return <section className="cloud-catalog" aria-labelledby="catalogue-title">
  <div className="catalog-heading"><h2 id="catalogue-title">Library materials</h2>
   {state==='ready'&&<span className="catalogue-count" role="status">{visible.length} of {papers.length}</span>}
  </div>
  {!!papers.length&&<div className="catalogue-filters">
   <label>Search library<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
   <label>Sort by<select aria-label="Sort by" value={sort} onChange={e=>setSort(e.target.value)}>
    <option value="date">Newest first</option><option value="title">Title</option><option value="stars">GitHub stars</option><option value="citations">Citations</option>
   </select></label>
   <label>Material Category<select aria-label="Material Category" value={material} onChange={e=>{setMaterial(e.target.value);if(e.target.value&&e.target.value!=='paper')setCode('');}}>
    <option value="">All materials</option>{materialTypes.map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select></label>
   <label>Research area<select aria-label="Research area" value={area} onChange={e=>{setArea(e.target.value);setCategory('');}}>
    <option value="">All areas</option>{areas.map(value=><option key={value}>{value}</option>)}
   </select></label>
   <label>Category<select aria-label="Category" value={category} onChange={e=>setCategory(e.target.value)}>
    <option value="">All categories</option>{topics.filter(value=>!area||splitCategory(value).area===area).map(value=><option key={value} value={value}>{area?splitCategory(value).topic:value.replace('/', ' / ')}</option>)}
   </select></label>
   <label>Keyword<select aria-label="Keyword" value={keyword} onChange={e=>setKeyword(e.target.value)}>
    <option value="">All keywords</option>{keywords.map(value=><option key={keywordKey(value)} value={keywordKey(value)}>{value}</option>)}
   </select></label>
   <label>Year<select aria-label="Year" value={year} onChange={e=>setYear(e.target.value)}>
    <option value="">All years</option>{years.map(value=><option key={value}>{value}</option>)}{papers.some(p=>!p.date)&&<option value="unknown">Unknown</option>}
   </select></label>
   <label>Code<select aria-label="Code" value={code} disabled={!!material&&material!=='paper'} onChange={e=>setCode(e.target.value)}>
    <option value="">Any status</option>{sorted(papers.filter(paper=>materialType(paper)==='paper').map(codeStatus)).map(value=><option key={value} value={value}>{codeLabels[value]}</option>)}
   </select></label>
   <label>Reading notes<select aria-label="Reading notes" value={notes} onChange={e=>setNotes(e.target.value)}>
    <option value="">Any</option><option value="with">With notes or annotations</option><option value="without">Without notes</option>
   </select></label>
   <button className="text-button" type="button" disabled={!(search||area||category||keyword||year||code||notes||material)} onClick={clear}>Clear filters</button>
  </div>}
  {state==='loading'&&<p role="status">Loading materials…</p>}
  {state==='error'&&<div role="status">Could not load this space. <button type="button" onClick={retry}>Retry</button></div>}
  {state==='ready'&&(papers.length===0?<div className="empty-state"><h3>No materials yet</h3><p>Add a paper or a reading to start your library.</p></div>
   :visible.length===0?<p role="status">No materials match your filters.</p>
   :visible.map(paper=><article className="paper-row" key={paper.fileId}>
    <div className="paper-row-main">
     <p className="paper-meta">{[materialLabel(paper),paper.date,paper.category?.replace('/', ' / ')].filter(Boolean).join(' · ')}</p>
     <h3><a href={readerUrl(paper.fileId)}>{paper.title}</a></h3>
     <div className="tags">
      {materialType(paper)==='paper'&&<span className="tag">Code: {codeLabels[codeStatus(paper)]}</span>}
      {paper.stars!=null&&<span className="tag">{paper.stars} stars</span>}
      {paper.citations!=null&&<span className="tag">{paper.citations} citations</span>}
      {hasNotes(paper)&&<span className="tag">Reading notes</span>}
      {mergeKeywordVocabulary(paper.keywords||[]).map(tag=>{
       const key=keywordKey(tag);
       return <button type="button" className="tag keyword-filter" key={key} aria-pressed={keyword===key} onClick={()=>setKeyword(keyword===key?'':key)}>{tag}</button>;
      })}
     </div>
    </div>
    {actions(paper)}
   </article>))}
 </section>;
}

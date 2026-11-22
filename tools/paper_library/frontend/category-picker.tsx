import {useState} from 'react';
import {categoryGroups,selectionFor,changeArea} from './category-model.mjs';
export default function CategoryPicker({categories,value,onChange,disabled,required=true}:{categories:string[];value:string;onChange:(value:string)=>void;disabled:boolean;required?:boolean}){
 const [manualArea,setManualArea]=useState('');const groups=categoryGroups(categories);const selected=selectionFor(value,manualArea);const topics=groups.get(selected.area)||[];
 return <div className="fields"><label>Area<select required={required} disabled={disabled} value={selected.area} onChange={e=>{const next=changeArea(e.target.value);setManualArea(next.area);onChange(next.value);}}><option value="">Choose an area</option>{Array.from(groups.keys()).map((area:string)=><option key={area} value={area}>{area}</option>)}</select></label><label>Topic<select required={required} disabled={disabled||!selected.area} value={value} onChange={e=>onChange(e.target.value)}><option value="">Choose a topic</option>{topics.map((topic:{value:string;label:string})=><option key={topic.value} value={topic.value}>{topic.label}</option>)}</select></label></div>;
}

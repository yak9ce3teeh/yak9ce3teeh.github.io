export function splitCategory(category){const i=category.indexOf('/');return i<0?{area:category,topic:category}:{area:category.slice(0,i).trim(),topic:category.slice(i+1).trim()};}
export function categoryGroups(categories){const groups=new Map();for(const value of categories){const {area,topic}=splitCategory(value);if(!groups.has(area))groups.set(area,[]);groups.get(area).push({value,label:topic});}return groups;}
export function selectionFor(value,manualArea=''){return value?splitCategory(value):{area:manualArea,topic:''};}
export function changeArea(area){return {area,value:''};}

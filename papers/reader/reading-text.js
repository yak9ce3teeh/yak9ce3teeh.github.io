const tags={paragraph:'p',heading:'h2',quote:'blockquote',code:'pre',list:'p'};

export function renderReadingText(blocks){
 const element=document.createElement('article');
 element.className='reading-text';
 for(const block of blocks){
  const tag=Object.hasOwn(tags,block.kind)?tags[block.kind]:'p';
  const child=document.createElement(tag);
  child.className='reading-block reading-block-'+(Object.hasOwn(tags,block.kind)?block.kind:'paragraph');
  child.textContent=block.text;
  // Explicit separators make character offsets independent of fonts and wrapping.
  if(element.childNodes.length)element.append(document.createTextNode('\n'));
  element.append(child);
 }
 return element;
}

export function readingSelection(root,range){
 if(range.collapsed||!range.intersectsNode(root))return null;
 const clipped=range.cloneRange();
 if(!root.contains(range.startContainer))clipped.setStart(root,0);
 if(!root.contains(range.endContainer))clipped.setEnd(root,root.childNodes.length);
 const prefix=document.createRange();
 prefix.selectNodeContents(root);
 prefix.setEnd(clipped.startContainer,clipped.startOffset);
 const start=prefix.toString().length,raw=clipped.toString();
 if(!raw.trim())return null;
 return {text:raw.trim(),position:{start,end:start+raw.length},clientRect:clipped.getBoundingClientRect()};
}

export function rangeForReading(root,position){
 const {start,end}=position||{};
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start)return null;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 const range=document.createRange();
 let offset=0,opened=false;
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const next=offset+node.length;
  if(!opened&&start<next){range.setStart(node,start-offset);opened=true;}
  if(opened&&end<=next){range.setEnd(node,end-offset);return range;}
  offset=next;
 }
 return null;
}

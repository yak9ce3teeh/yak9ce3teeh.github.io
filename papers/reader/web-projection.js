import DOMPurify from './assets/vendor/dompurify/purify.es.mjs';

const MAX_HTML=3_000_000;

export function publicPageUrl(value){
  try{
    const url=new URL(value);
    if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.hostname.includes('.')&&
       !/^[\d.]+$/.test(url.hostname)&&!/(?:^|\.)(localhost|local|internal|lan|home|onion|invalid|test|example|arpa)\.?$/i.test(url.hostname))return url;
  }catch{}
  return null;
}

export async function fetchProjection(source,fetchFromLibrary){
  const url=publicPageUrl(source);
  if(url){
    try{
      const response=await fetch(url,{mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(6000)});
      if(!response.ok||!/^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i.test(response.headers.get('Content-Type')||''))throw Error();
      const stream=response.body.getReader();
      if(Number(response.headers.get('Content-Length'))>MAX_HTML){await stream.cancel();throw Error();}
      const charset=response.headers.get('Content-Type')?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
      let decoder;
      try{decoder=new TextDecoder(charset);}catch{decoder=new TextDecoder();}
      let size=0,html='';
      try{
        for(;;){
          const {value,done}=await stream.read();
          if(done)break;
          size+=value.byteLength;
          if(size>MAX_HTML)throw Error();
          html+=decoder.decode(value,{stream:true});
        }
        return {source:url.href,html:html+decoder.decode()};
      }catch(error){await stream.cancel().catch(()=>{});throw error;}
    }catch{/* Sites without CORS can be captured by the library service. */}
  }
  const response=await fetchFromLibrary(source);
  const result=await response.json().catch(()=>null);
  if(!response.ok||result?.format!=='web'||typeof result.html!=='string')
    throw Error(result?.error||'Could not display this web page.');
  return result;
}

// Runs in an opaque-origin frame. The CSP permits only these script bytes.
function selectionBridge(channel,host){
  let dragging=false;
  function publish(show){
    const selection=window.getSelection();
    const text=selection?.toString().trim().slice(0,4000);
    const rect=text&&selection.getRangeAt(0).getBoundingClientRect();
    const visible=rect&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth;
    parent.postMessage({channel,text:text||'',rect:visible?{left:Math.max(0,rect.left),top:Math.max(0,rect.top),
      width:Math.min(innerWidth,rect.right)-Math.max(0,rect.left),bottom:Math.min(innerHeight,rect.bottom)}:null,show},host);
  }
  document.addEventListener('pointerdown',()=>{dragging=true;publish(false);});
  window.addEventListener('pointerup',()=>{dragging=false;publish(true);});
  window.addEventListener('pointercancel',()=>{dragging=false;publish(false);});
  document.addEventListener('selectionchange',()=>publish(!dragging));
  window.addEventListener('scroll',()=>publish(false),true);
  window.addEventListener('resize',()=>publish(false));
  document.addEventListener('click',event=>{
    const id=event.target.closest('a[data-projection-fragment]')?.getAttribute('data-projection-fragment');
    if(id===undefined)return;
    event.preventDefault();
    if(!id)window.scrollTo(0,0);
    else (document.getElementById(id)||document.getElementsByName(id)[0])?.scrollIntoView();
  });
  parent.postMessage({channel,ready:true},host);
}

export async function mountProjection(container,{source,html},onSelection){
  const base=publicPageUrl(source);
  if(!base)throw Error('Open the original page to read this link.');
  const channel=crypto.randomUUID();
  const root=DOMPurify.sanitize(html,{
    WHOLE_DOCUMENT:true,RETURN_DOM:true,ADD_TAGS:['link'],ADD_ATTR:['target','rel'],
    FORBID_TAGS:['script','base','meta','iframe','frame','object','embed','form','template','portal','fencedframe'],
    FORBID_ATTR:['nonce','ping','srcdoc','autofocus','contenteditable','autoplay','download','data-projection-fragment']
  });
  const head=root.querySelector('head'),body=root.querySelector('body');
  if(!head||!body||!body.children.length&&!body.textContent.trim())throw Error('This page did not return displayable content.');
  const element=(name)=>root.ownerDocument.createElement(name);
  for(const link of root.querySelectorAll('link')){
    if(link.getAttribute('rel')?.toLowerCase()!=='stylesheet')link.remove();
    else {link.removeAttribute('integrity');link.referrerPolicy='no-referrer';}
  }
  for(const link of root.querySelectorAll('a')){
    const href=link.getAttribute('href')||link.getAttribute('xlink:href');
    link.removeAttribute('href');link.removeAttribute('xlink:href');
    if(!href)continue;
    try{
      const target=new URL(href,base);
      if(!['http:','https:'].includes(target.protocol)||target.username||target.password)continue;
      if(target.origin===base.origin&&target.pathname===base.pathname&&target.search===base.search&&href.includes('#')){
        link.setAttribute('data-projection-fragment',decodeURIComponent(target.hash.slice(1)));
        link.setAttribute('href','#');link.removeAttribute('target');
      }else{
        link.setAttribute('href',target.href);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');
      }
    }catch{/* An invalid link remains plain text. */}
  }
  for(const input of body.querySelectorAll('button,input,select,textarea'))input.setAttribute('disabled','');
  const styles=element('style');
  styles.textContent='body,body *{-webkit-user-select:text!important;user-select:text!important}';
  head.append(styles);
  const baseElement=element('base');baseElement.href=base.href;
  const referrer=element('meta');referrer.name='referrer';referrer.content='no-referrer';
  const bridge=element('script');
  // A file-based parent has an opaque origin, so the receiver checks frame and channel instead.
  const host=location.origin==='null'?'*':location.origin;
  bridge.textContent=`(${selectionBridge.toString()})(${JSON.stringify(channel)},${JSON.stringify(host)})`.replace(/\r\n?/g,'\n');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bridge.textContent));
  const hash=btoa(String.fromCharCode(...new Uint8Array(digest)));
  const policy=element('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content=`default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:; media-src https:; form-action 'none'; base-uri https:`;
  head.prepend(policy,referrer,baseElement);
  body.append(bridge);
  const frame=document.createElement('iframe');
  frame.className='web-projection';frame.title='Original web page view';
  frame.setAttribute('sandbox','allow-scripts allow-popups allow-popups-to-escape-sandbox');
  frame.referrerPolicy='no-referrer';
  frame.srcdoc='<!doctype html>'+root.outerHTML;
  let timer;
  return new Promise((resolve,reject)=>{
    const receive=(event)=>{
      const data=event.data;
      if(event.source!==frame.contentWindow||event.origin!=='null'||data?.channel!==channel)return;
      if(data.ready){clearTimeout(timer);resolve();return;}
      const {left,top}=frame.getBoundingClientRect();
      const rect=data.rect&&{left:left+data.rect.left,top:top+data.rect.top,width:data.rect.width,bottom:top+data.rect.bottom};
      onSelection(data.text,rect,data.show);
    };
    window.addEventListener('message',receive);
    timer=setTimeout(()=>{
      window.removeEventListener('message',receive);
      frame.remove();
      reject(Error('The web view did not finish loading.'));
    },15000);
    container.replaceChildren(frame);
  });
}

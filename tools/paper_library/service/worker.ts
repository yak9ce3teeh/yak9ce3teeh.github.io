import categories from './lib/categories.json';
import * as r0 from './app/api/classify/route';
import * as r1 from './app/api/metadata/route';
import * as r2 from './app/api/papers/route';
import * as r3 from './app/api/papers/[id]/keywords/route';
import * as r4 from './app/api/papers/[id]/link/route';
import * as r5 from './app/api/papers/[id]/pdf/route';
import * as r6 from './app/api/papers/[id]/reader/route';
import * as r7 from './app/api/translation/status/route';
import * as r8 from './app/api/translation/translate/route';
import * as readings from './app/api/readings/route';
import * as readingSource from './app/api/readings/source/route';
import {authorized,bindings,json} from './lib/cloud';
import {AccountError,accountRoute,requireUser} from './lib/accounts';
import {spaceUsage,spacesRoute} from './lib/spaces';
const routes:Record<string,any>={
  'categories':{GET:()=>json({categories})},
  'classify':r0,
  'metadata':r1,
  'papers':r2,
  'readings':readings,
  'readings/source':readingSource,
  'papers/[id]/keywords':r3,
  'papers/[id]/link':r4,
  'papers/[id]/pdf':r5,
  'papers/[id]/reader':r6,
  'translation/status':r7,
  'translation/translate':r8,
};
export default {async fetch(request:Request){
 const origin=request.headers.get('Origin'),dev=bindings().DEV_ORIGIN;
 if(origin && origin!=='https://yak9ce3teeh.github.io' && !(dev===origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)))return json({error:'Origin denied'},403);
 const path=new URL(request.url).pathname.replace(/^\/api\//,'').replace(/^\//,'');
 const match=path.match(/^papers\/(\d+)\/(pdf|reader|keywords|link)$/);
 const route=routes[match?'papers/[id]/'+match[2]:path==='translate'?'translation/translate':path];
 let response:Response;
 try{
 if(request.method==='OPTIONS')response=new Response(null,{status:204});
 else if(/^account\/(signup|login|password|session|logout)$/.test(path))response=await accountRoute(request,path);
 else if(path==='spaces')response=await spacesRoute(request);
 else if(['space','usage'].includes(path)&&request.method==='GET')response=await spaceUsage(request);
 else if(!route || !Object.hasOwn(route,request.method))response=json({error:'Route unavailable'},404);
 else if((path==='translate'||path.startsWith('translation/'))&&!await authorized(request))response=json({error:'Translation is available to the site owner.'},403);
 else{
  if(!['categories','classify'].includes(path))await requireUser(request);
  response=await route[request.method](request,{params:Promise.resolve({id:match?.[1]})});
 }
 }catch(error){response=error instanceof AccountError?json({error:error.message},error.status):json({error:'Service unavailable'},500);}
 const out=new Response(response.body,response);out.headers.delete('Access-Control-Allow-Origin');
 if(origin)out.headers.set('Access-Control-Allow-Origin',origin);
 out.headers.set('Cache-Control','private, no-store');out.headers.set('Vary','Origin, Authorization');out.headers.set('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');out.headers.set('Access-Control-Allow-Headers','Authorization,Content-Type,Range');return out;
}};

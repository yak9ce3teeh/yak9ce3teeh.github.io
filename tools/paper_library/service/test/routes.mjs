// Isolated tests of real handlers: no network, platform credentials, or persisted DB.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {strToU8,zipSync} from 'fflate';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://yak9ce3teeh.github.io';
const categories=JSON.parse(await readFile(path.join(root,'lib/categories.json'),'utf8'));
const sql=new DatabaseSync(':memory:');
sql.exec(await readFile(path.join(root,'migrations/0001.sql'),'utf8'));
sql.prepare('INSERT INTO papers(source_id,sha256,metadata,created,zotero) VALUES(?,?,?,?,?)')
 .run('2610.23127','1'.repeat(64),JSON.stringify({title:'Private Legacy',keywords:['Legacy private term'],date:'2026-10',category:categories[0]}),'2026-10-27','{}');
sql.exec(await readFile(path.join(root,'migrations/0002_accounts.sql'),'utf8'));
let writes=0,puts=0,network=0,checks=0;
const objects=new Map();
const DB={prepare(query){const prepared=sql.prepare(query);let args=[];return {
 bind(...values){args=values;return this;},async first(){return prepared.get(...args)||null;},
 async all(){return {results:prepared.all(...args)};},async run(){writes++;return {meta:{changes:prepared.run(...args).changes}};}
};},async batch(statements){sql.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.run());sql.exec('COMMIT');return rows;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const BUCKET={async put(key,bytes){puts++;objects.set(key,new Uint8Array(bytes));},
 async delete(key){objects.delete(key);},
 async head(key){const b=objects.get(key);return b?{size:b.length,httpEtag:'"fixture"'}:null;},
 async get(key,{range}={}){const b=objects.get(key);if(!b)return null;return {size:b.length,httpEtag:'"fixture"',body:range?b.slice(range.offset,range.offset+range.length):b.slice(),json:async()=>JSON.parse(new TextDecoder().decode(b))};}
};

const key='a'.repeat(64);
objects.set('pdf/'+'1'.repeat(64),new TextEncoder().encode('%PDF-legacy'));
globalThis.testEnv={DB,BUCKET,LIBRARY_ACCESS_KEY:key,DEEPSEEK_API_KEY:'fixture',SPACE_ENCRYPTION_KEY:'b'.repeat(64)};
const {timingSafeEqual}=await import('node:crypto');crypto.subtle.timingSafeEqual=(a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b));
const bundle=await build({entryPoints:[path.join(root,'worker.ts')],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'bindings',setup(b){
 b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'fixture'}));
 b.onResolve({filter:/^node:dns\/promises$/},()=>({path:'dns',namespace:'fixture'}));
 b.onLoad({filter:/^env$/,namespace:'fixture'},()=>({contents:'export const env=globalThis.testEnv'}));
 b.onLoad({filter:/^dns$/,namespace:'fixture'},()=>({contents:`
   export const resolve4=async host=>[host==='denied.fixture.net'?'10.1.2.3':'8.8.8.8'];
   export const resolve6=async host=>host==='denied-v6.fixture.net'?['fc00::1']:[];
 `}));
}}]});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
const api=(path,method='GET',body,token=key,site=origin)=>worker.fetch(new Request('https://service.example/api/'+path,{method,body,headers:{Origin:site,Authorization:'Bearer '+token}}));

const password='long test password alpha',nextPassword='different test password omega';

const request=(route,payload,token='')=>api(route,'POST',JSON.stringify(payload),token);
for(const route of ['spaces','space?space=personal','usage?space=personal','papers?space=personal','papers/1000001/pdf','papers/1000001/reader']){
 assert.equal((await api(route,'GET',undefined,'')).status,401,route);
 assert.equal((await api(route)).status,401,'Legacy key may not read '+route);
}
assert.equal((await request('account/signup',{username:'yak9ce3teeh',password,confirmation:password})).status,409);
assert.equal((await request('account/signup',{username:'Reader',password,confirmation:'mismatch'})).status,400);
assert.equal((await request('account/reset',{})).status,404);
assert.equal((await request('account/bootstrap',{},key)).status,404);
const adminSeed=await request('account/signup',{username:'OwnerFixture',password,confirmation:password});
assert.equal(adminSeed.status,201);
sql.prepare("UPDATE library_users SET username=?,admin=1,must_change=1,recovery_hash='old' WHERE username='OwnerFixture'").run('Yak9ce3teeh');
sql.prepare("UPDATE library_spaces SET user_id=(SELECT id FROM library_users WHERE admin=1) WHERE id='personal'").run();
sql.exec(await readFile(path.join(root,'migrations/0003_private_archive.sql'),'utf8'));
sql.exec(await readFile(path.join(root,'migrations/0004_archive_duplicates.sql'),'utf8'));
const loginOwner=await request('account/login',{username:'yak9ce3teeh',password});
assert.equal(loginOwner.status,200);
const admin=await loginOwner.json();
assert.equal(admin.user.admin,true);
const userData={username:'Reader',password,confirmation:password};
const signedUp=await request('account/signup',userData);
assert.equal(signedUp.status,201);
const user=await signedUp.json();
assert.equal('recovery' in user,false);
assert.equal((await request('account/signup',{...userData,username:'READER'})).status,409);
assert.deepEqual((await (await api('spaces','GET',undefined,admin.token)).json()).spaces.map(p=>p.id),['personal']);
assert.deepEqual((await (await api('spaces','GET',undefined,user.token)).json()).spaces,[]);
for(const route of ['space?space=personal','usage?space=personal','papers?space=personal','papers/1000001/pdf','papers/1000001/reader']){
 assert.equal((await api(route,'GET',undefined,user.token)).status,404,route);
}
assert.equal((await request('papers/1000001/link',{},user.token)).status,404);
assert.equal((await api('papers/1000001/keywords','PATCH','{}',user.token)).status,404);
assert.equal((await api('papers/1000001/reader?space=wrong','GET',undefined,admin.token)).status,404);
const archiveHash='1'.repeat(64);
const archivedMetadata=JSON.stringify({title:'Privately archived',keywords:['Archive-only term'],date:'2025-01',category:categories[0]});
sql.prepare("INSERT INTO papers(source_id,sha256,metadata,created,space_id,object_key,byte_size,archive_file_id) VALUES(?,?,?,'2026-11-18','personal',?,11,0)")
 .run('2610.23127',archiveHash,archivedMetadata,'pdf/'+archiveHash);
objects.set('archive/reader/0.json',new TextEncoder().encode(JSON.stringify({fileId:0,pdf:{sha256:archiveHash},notes:[{displayHtml:'<img src="data:image/png;base64,AA==">'}],annotations:[]})));
assert.equal((await api('papers/0/reader','GET',undefined,'')).status,401);
assert.equal((await api('papers/0/reader','GET',undefined,user.token)).status,404);
const archived=await (await api('papers/0/reader','GET',undefined,admin.token)).json();
assert.equal(archived.fileId,0);
assert.equal(archived.pdf.url,'https://service.example/api/papers/0/pdf');
assert.match(archived.notes[0].displayHtml,/data:image/);
assert.equal((await api('papers/0/pdf','GET',undefined,admin.token)).status,200);

const legacy=await (await api('papers?space=personal','GET',undefined,admin.token)).json();
assert.equal(legacy.papers.some(p=>p.fileId===1000001),true);
assert.ok(legacy.keywordVocabulary.includes('Legacy private term'));
const legacyUsage=await (await api('usage?space=personal','GET',undefined,admin.token)).json();
assert.equal(legacyUsage.r2.bytes,22);
const remote=new Map();
const keyId='b'.repeat(32),r2Secret='c'.repeat(64);
globalThis.fetch=async(url,options)=>{
 const r=url instanceof Request?url:new Request(url,options);
 const target=new URL(r.url);
 if(target.hostname==='api.deepseek.com'){
  network++;
  return Response.json({choices:[{message:{content:'Translated'}}]});
 }
 if(target.hostname==='arxiv.org'){
  return new Response('<meta name="citation_title" content="JEPA World Models"><meta name="citation_date" content="2026/10/20">');
 }
 assert.equal(target.hostname,'d'.repeat(32)+'.r2.cloudflarestorage.com');
 assert.match(r.headers.get('Authorization'),new RegExp('Credential='+keyId+'/'));
 assert.equal(r.redirect,'error');
 const object=target.pathname;
 if(r.method==='PUT'){remote.set(object,new Uint8Array(await r.arrayBuffer()));return new Response(null);}
 if(r.method==='DELETE'){remote.delete(object);return new Response(null,{status:204});}
 const value=remote.get(object);
 if(!value)return new Response(null,{status:404});
 if(r.method==='HEAD')return new Response(null,{headers:{'Content-Length':String(value.length)}});
 const range=r.headers.get('Range')?.match(/^bytes=(\d+)-(\d+)$/);
 return range?new Response(value.slice(+range[1],+range[2]+1),{status:206}):new Response(value);
};
const config={name:'My private R2',accountId:'d'.repeat(32),bucket:'my-bucket',accessKeyId:keyId,secretAccessKey:r2Secret};
const added=await request('spaces',config,user.token);
assert.equal(added.status,201);
const {space}=await added.json();
assert.deepEqual(Object.keys(space).sort(),['id','kind','name']);
assert.equal(remote.size,0,'The connection probe is cleaned up');
const ciphertext=sql.prepare('SELECT config FROM library_spaces WHERE id=?').get(space.id).config;
assert.ok(!ciphertext.includes(r2Secret)&&!ciphertext.includes(keyId));
const form=()=>{const f=new FormData();f.set('metadata',JSON.stringify({title:'JEPA: World Models',date:'2026-10',category:categories[0],source:'2610.23127',keywords:[]}));f.set('pdf',new File(['%PDF-1.4 sample'],'fixture.pdf'));return f;};
const created=await api('papers?space='+space.id,'POST',form(),user.token);
assert.equal(created.status,201,'Another account may save the same arXiv ID');
const newPaper=(await created.json()).paper;
assert.equal(newPaper.fileId,1000003);
assert.equal((await api('papers?space='+space.id,'POST',form(),user.token)).status,200);
assert.equal(remote.size,1);
const otherList=await (await api('papers?space='+space.id,'GET',undefined,user.token)).json();
assert.ok(!otherList.keywordVocabulary.includes('Legacy private term'));
assert.equal((await api('papers/'+newPaper.fileId+'/reader','GET',undefined,admin.token)).status,404);
const pdf=await worker.fetch(new Request('https://service.example/api/papers/'+newPaper.fileId+'/pdf',{headers:{Origin:origin,Range:'bytes=0-4',Authorization:'Bearer '+user.token}}));
assert.equal(pdf.status,206);assert.equal(await pdf.text(),'%PDF-');assert.match(pdf.headers.get('Cache-Control'),/no-store/);
const metadata=await (await api('metadata?space='+space.id+'&source=2610.23127','GET',undefined,user.token)).json();
assert.ok(metadata.keywords.some(tag=>/world models/i.test(tag)));
assert.ok(!metadata.keywordVocabulary.includes('Archive-only term'));
for(let i=0;i<20;i++)assert.equal((await request('translate',{text:'Translate me.'},admin.token)).status,200);
assert.equal((await request('translate',{text:'Translate me.'},admin.token)).status,429);
assert.equal((await request('translate',{text:'Translate me.'},user.token)).status,403);
assert.equal(network,20);
const login=await (await request('account/login',{username:'reader',password})).json();
const passwordChange={currentPassword:password,password:nextPassword,confirmation:nextPassword};
assert.equal((await request('account/password',passwordChange)).status,401);
assert.equal((await request('account/password',{...passwordChange,currentPassword:'wrong'},user.token)).status,400);
const changes=await Promise.all([request('account/password',passwordChange,user.token),request('account/password',passwordChange,user.token)]);
assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
const changed=await changes.find(r=>r.ok).json();
for(const token of [login.token,user.token])assert.equal((await api('account/session','GET',undefined,token)).status,401);
assert.equal((await request('account/logout',{},changed.token)).status,200);
assert.equal((await api('spaces','GET',undefined,changed.token)).status,401);
assert.equal((await request('account/login',{username:'Reader',password:nextPassword})).status,200);
assert.equal((await api('spaces','GET',undefined,admin.token,'https://evil.example')).status,403);
console.log('PASS migration of populated D1, reserved owner, signup/login/logout/password change, private archive, cross-account denial, scoped keywords/storage, R2 credentials, upload/range and translation quota');

const currentReader=await (await request('account/login',{username:'Reader',password:nextPassword})).json();
const articleFixture=`<!doctype html><html><head><title>Reinforcement learning and humanoid control</title></head>
<body><nav>Not article text</nav><main><article><h1>Reinforcement learning and humanoid control</h1>
<p>Humanoid control and motion tracking help robots maintain stable motion in different environments.
强化学习可以用于人形机器人控制。 This technical writeup compares several controllers on simulation tasks.</p>
<blockquote>A separate quote in the article.</blockquote><pre>if controller.ready:
    controller.step()</pre><script>DO_NOT_RENDER_ME</script></article></main></body></html>`;
const inheritedFetch=globalThis.fetch;
let fetchedSites=0;
globalThis.fetch=async(url,options)=>{
 const destination=url instanceof URL?url:new URL(url instanceof Request?url.url:String(url));
 if(destination.hostname==='article.fixture.net'){
  fetchedSites++;
  if(destination.pathname==='/redirect')return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/admin'}});
  if(destination.pathname==='/report.pdf')return new Response('%PDF-1.7 linked report',{headers:{'Content-Type':'application/pdf'}});
  return new Response(articleFixture,{headers:{'Content-Type':'text/html; charset=utf-8'}});
 }
 return inheritedFetch(url,options);
};
const capture=(url,token=admin.token,spaceId='personal')=>request('readings/source?space='+spaceId,{url},token);
assert.equal((await capture('https://article.fixture.net/blog','')).status,401);
assert.equal((await capture('https://article.fixture.net/blog',currentReader.token)).status,404);
assert.equal((await capture('https://127.0.0.1/')).status,400);
assert.equal((await capture('https://denied.fixture.net/blog')).status,400);
assert.equal((await capture('https://denied-v6.fixture.net/blog')).status,400);
assert.equal(fetchedSites,0);
assert.equal((await capture('https://article.fixture.net/redirect')).status,400);
const pageResponse=await capture('https://article.fixture.net/blog#section');
assert.equal(pageResponse.status,200);
const page=await pageResponse.json();
assert.equal(page.source,'https://article.fixture.net/blog');
assert.match(page.title,/humanoid control/i);
assert.ok(page.blocks.some(block=>block.text.includes('强化学习')));
assert.ok(page.blocks.some(block=>block.kind==='code'&&block.text.includes('controller.step')));
assert.ok(!JSON.stringify(page.blocks).includes('DO_NOT_RENDER_ME'));
const project={url:page.source,projection:true};
assert.equal((await request('readings/source?space=personal',project,currentReader.token)).status,404);
const projection=await request('readings/source?space=personal',project,admin.token);
assert.equal(projection.status,200);
assert.match(projection.headers.get('Content-Type'),/^application\/json/);
assert.deepEqual(await projection.json(),{format:'web',source:page.source,html:articleFixture});
assert.equal((await request('readings/source?space=personal',{...project,url:'https://article.fixture.net/report.pdf'},admin.token)).status,422);
const browserCapture=new FormData();
browserCapture.set('url','https://article.fixture.net/blog');
browserCapture.set('html',new File([articleFixture],'snapshot.html',{type:'text/html'}));
const browserParsed=await (await api('readings/source?space=personal','POST',browserCapture,admin.token)).json();
assert.deepEqual(browserParsed.blocks,page.blocks);
assert.equal((await capture('https://article.fixture.net/report.pdf')).headers.get('Content-Type'),'application/pdf');
function reading(values,content,file){
 const data=new FormData();
 data.set('metadata',JSON.stringify(values));
 if(content)data.set('content',JSON.stringify(content));
 if(file)data.set('file',file);
 return data;
}
const webpage=()=>reading({materialType:'blog',source:page.source,extractedTitle:page.title},page.blocks);
const savedPage=await api('readings?space=personal','POST',webpage(),admin.token);
assert.equal(savedPage.status,201);
const blog=(await savedPage.json()).paper;
assert.equal(blog.materialType,'blog');
assert.equal(blog.date,'');
assert.equal(blog.pdfUrl,null);
assert.ok(blog.keywords.length);
assert.notEqual(blog.category,'Other readings/Uncategorized');
assert.equal((await (await api('readings?space=personal','POST',webpage(),admin.token)).json()).paper.fileId,blog.fileId);
const blogPath='papers/'+blog.fileId;
const renderedBlog=await (await api(blogPath+'/reader','GET',undefined,admin.token)).json();
assert.deepEqual(renderedBlog.content,page.blocks);
assert.equal(renderedBlog.pdf,null);
assert.equal(renderedBlog.mapping.status,'not_applicable');
assert.equal((await api(blogPath+'/reader','GET',undefined,currentReader.token)).status,404);
assert.equal((await api(blogPath+'/pdf','GET',undefined,admin.token)).status,404);
assert.equal((await request(blogPath+'/link',{},admin.token)).status,404);
const docx=zipSync({
 'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Control architecture</w:t></w:r></w:p><w:p><w:r><w:t>正文与 segmentation.</w:t></w:r></w:p></w:body></w:document>'),
 'docProps/core.xml':strToU8('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Motion tracking field notes</dc:title></cp:coreProperties>'),
});
const doc=await api('readings?space='+space.id,'POST',reading({materialType:'other',date:'2024'},null,new File([docx],'fixture.docx')),currentReader.token);
assert.equal(doc.status,201);
const document=(await doc.json()).paper;
assert.equal(document.date,'2024');
assert.equal(document.title,'Motion tracking field notes');
assert.equal(document.originalFormat,'docx');
const renderedDoc=await (await api('papers/'+document.fileId+'/reader','GET',undefined,currentReader.token)).json();
assert.deepEqual(renderedDoc.content,[{kind:'heading',text:'Control architecture'},{kind:'paragraph',text:'正文与 segmentation.'}]);
const pdfReading=(values={})=>reading({materialType:'technical-report',sample:'Humanoid motion tracking and whole-body control.',...values},null,new File(['%PDF-1.7 reading fixture'],'Humanoid motion tracking.pdf'));
assert.equal((await api('readings?space=personal','POST',pdfReading({date:'2026-02-31'}),admin.token)).status,400);
const pdfSaved=await api('readings?space=personal','POST',pdfReading(),admin.token);
assert.equal(pdfSaved.status,201);
const report=(await pdfSaved.json()).paper;
assert.equal(report.materialType,'technical-report');
assert.equal(report.format,'pdf');
assert.equal((await api('papers/'+report.fileId+'/pdf','GET',undefined,admin.token)).status,200);
assert.equal((await (await api('papers/1000001/reader','GET',undefined,admin.token)).json()).materialType,'paper');
console.log('PASS web and linked PDF capture, redirect/IP guard, optional dates, Word text in external R2, material types, deduplication, private reads and sync exclusion.');

import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Library from './library';
import Usage,{SpaceSummary,useSpaceUsage} from './usage';
import {api,selectSpace} from './service';
import {accountApi,accountSession,saveSession,jsonRequest,SESSION_KEY,SESSION_EVENT} from '../../../papers/reader/account-client.js';
import './style.css';

type Space = {id:string;name:string;kind:'legacy'|'r2'};
type Mode = 'login'|'signup';
const nextPaper = new URLSearchParams(location.search).get('next');
const returnPath = nextPaper && /^(0|[1-9]\d{0,8})$/.test(nextPaper)
 ? '/papers/reader/?id='+encodeURIComponent(nextPaper)
 : '';

function AccountForm({onSignedIn}:{onSignedIn:(session:any)=>void}){
 const [mode,setMode]=useState<Mode>('login');
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 async function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();
  const fields=Object.fromEntries(new FormData(event.currentTarget));
  setBusy(true);setNotice('');
  try{onSignedIn(await accountApi('/api/account/'+mode,jsonRequest(fields),null));}
  catch(error){setNotice((error as Error).message);}
  finally{setBusy(false);}
 }
 const signingUp=mode==='signup', title=signingUp?'Create an account':'Log in';
 return <main className="cloud-shell account-shell">
  <header className="site-header"><a href="/">← Home</a><span>WE VIBE THE VIBES</span></header>
  <section className="form-section account-card">
   <h1>{title}</h1>
   <p>{returnPath?'Log in to open the requested paper.':'Log in to open your Paper Library.'}</p>
   <form onSubmit={submit} key={mode}>
    <label>Username<input name="username" autoComplete="username" autoCapitalize="none" required minLength={3} maxLength={32} disabled={busy}/></label>
    <label>Password<input name="password" type="password" autoComplete={signingUp?'new-password':'current-password'} required minLength={signingUp?12:undefined} maxLength={128} disabled={busy}/></label>
    {signingUp&&<><label>Confirm password<input name="confirmation" type="password" autoComplete="new-password" aria-describedby="password-length" minLength={12} maxLength={128} required disabled={busy}/></label><small id="password-length">Use at least 12 characters.</small></>}
    <button type="submit" className="primary" disabled={busy}>{busy?'Please wait…':title}</button>
    <p className="form-status" role="status">{notice}</p>
   </form>
   <button type="button" disabled={busy} onClick={()=>{setMode(signingUp?'login':'signup');setNotice('');}}>{signingUp?'Back to login':'Sign up'}</button>
  </section>
 </main>;
}

function PasswordChange(){
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 async function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();
  const form=event.currentTarget;
  const fields=Object.fromEntries(new FormData(form));
  setBusy(true);setNotice('');
  try{
   const session=accountSession();
   const result=await accountApi('/api/account/password',jsonRequest(fields),session);
   if(accountSession()?.token===session?.token)saveSession(result);
   form.reset();setNotice('Password changed. Other sessions were signed out.');
  }catch(error){setNotice((error as Error).message);}
  finally{setBusy(false);}
 }
 return <details className="settings-section"><summary>Change password</summary>
  <form onSubmit={submit} className="key-editor">
   <label>Current password<input type="password" name="currentPassword" autoComplete="current-password" maxLength={128} required disabled={busy}/></label>
   <label>New password<input type="password" name="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy}/></label>
   <label>Confirm new password<input type="password" name="confirmation" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy}/></label>
   <button type="submit" disabled={busy}>{busy?'Changing password…':'Save new password'}</button>
   <p role="status">{notice}</p>
  </form>
 </details>;
}

function Workspace({user,onLogout}:{user:{id:string;username:string;admin:boolean};onLogout:()=>Promise<void>}){
 const [githubConnection,setGithubConnection]=useState<any>(null);
 const [spaces,setSpaces]=useState<Space[]>([]),[selected,setSelected]=useState(''),[categories,setCategories]=useState<string[]>([]);
 const [settings,setSettings]=useState(location.hash==='#connections'),[view,setView]=useState('access');
 const [adding,setAdding]=useState(false),[locked,setLocked]=useState(false),[busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true),[notice,setNotice]=useState('');
 const selectedKey='paper-library.selected.'+user.id;
 const current=spaces.find(space=>space.id===selected);
 const usage=useSpaceUsage(true,selected);
 function choose(id:string){
  selectSpace(id);
  setSelected(id);
  if(id)localStorage.setItem(selectedKey,id);
 }
 async function initialize(){
  setNotice('');setLoading(true);
  try{
   const [response,options]=await Promise.all([accountApi('/api/spaces'),api('/api/categories')]);
   if(accountSession()?.user.id!==user.id)return;
   setSpaces(response.spaces);
   setCategories(options.categories);
   const preferred=localStorage.getItem(selectedKey);
   choose(response.spaces.find((space:Space)=>space.id===preferred)?.id||response.spaces[0]?.id||'');
  }catch(error){setNotice((error as Error).message);}
  finally{setLoading(false);}
 }
 useEffect(()=>{initialize();},[user.id]);
 function openSettings(tab='access'){
  setView(tab);setSettings(true);
 }
 function addSpace(){setNotice('');setAdding(true);openSettings();}
 async function connect(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();
  const fields=Object.fromEntries(new FormData(event.currentTarget));
  setBusy(true);setNotice('');
  try{
   const {space}=await accountApi('/api/spaces',jsonRequest(fields));
   if(accountSession()?.user.id!==user.id)return;
   setSpaces(prev=>[...prev,space]);choose(space.id);setAdding(false);setNotice('R2 space connected.');
  }catch(error){setNotice((error as Error).message);}
  finally{setBusy(false);}
 }
 async function logout(){
  setBusy(true);setNotice('');
  try{await onLogout();}
  catch(error){setNotice((error as Error).message);}
  finally{setBusy(false);}
 }
 const picker=<section className="space-card">
  <div className="section-head"><span className="eyebrow">YOUR ACCOUNT</span><h2>{user.username}</h2></div>
  <label>Destination space<select value={selected} aria-label="Destination space" disabled={loading||busy||locked} onChange={event=>{
    if(event.target.value==='__add__')addSpace();else choose(event.target.value);
  }}>
   <option value="" disabled>{loading?'Loading spaces…':'Choose a space'}</option>
   {spaces.map(space=><option key={space.id} value={space.id}>{space.name}</option>)}
   <option value="__add__">＋ Add Cloudflare R2 space…</option>
  </select></label>
  {!loading&&!selected&&<button type="button" disabled={busy||locked} onClick={addSpace}>Add Cloudflare R2 space</button>}
  {loading===false&&notice&&!settings&&<p className="inline-notice" role="status">{notice}</p>}
  {!loading&&!selected&&notice&&<button type="button" onClick={initialize}>Retry loading spaces</button>}
 </section>;
 const management=<><section className="settings-section">
  <h3>Your cloud spaces</h3>
  {current&&<><strong>{current.name}</strong><SpaceSummary data={usage}/></>}
  {!adding?<button type="button" disabled={busy||locked} onClick={addSpace}>Add Cloudflare R2 space</button>:<form onSubmit={connect} className="key-editor">
   <p className="helper">Create a private bucket in Cloudflare R2. Generate S3 credentials with Object Read &amp; Write access limited to that bucket.</p>
   <a href="https://developers.cloudflare.com/r2/api/tokens/" target="_blank" rel="noopener noreferrer">Cloudflare R2 setup ↗</a>
   <label>Space name<input name="name" required maxLength={60} disabled={busy}/></label>
   <label>Cloudflare account ID<input name="accountId" required autoComplete="off" disabled={busy}/></label>
   <label>R2 bucket name<input name="bucket" required autoComplete="off" disabled={busy}/></label>
   <label>R2 access key ID<input name="accessKeyId" required autoComplete="off" disabled={busy}/></label>
   <label>R2 secret access key<input name="secretAccessKey" type="password" required autoComplete="off" disabled={busy}/></label>
   <div className="actions"><button type="submit" disabled={busy}>{busy?'Verifying access…':'Connect space'}</button><button type="button" disabled={busy} onClick={()=>{setAdding(false);setNotice('');}}>Cancel</button></div>
  </form>}
  {notice&&<p role="status" className="inline-notice">{notice}</p>}
 </section><PasswordChange/></>;
 return <Library key={user.id+':'+selected} accountId={user.id} admin={user.admin} destinationId={selected}
  owner={!!selected} githubConnection={githubConnection} setGithubConnection={setGithubConnection} categories={categories} destination={picker} destinationName={current?.name||'your cloud space'}
  accountControls={<button type="button" className="text-button" disabled={busy||locked} onClick={logout}>{busy?'Please wait…':'Log out'}</button>}
  onConnect={openSettings} onBusy={setLocked} settingsOpen={settings}
  onSettingsChange={open=>{if(!open&&busy)return;setSettings(open);if(!open){setAdding(false);setNotice('');}}}
  settingsView={view} onSettingsViewChange={setView} connectionSettings={management}
  usage={<Usage data={usage}/>}/>;
}

function App(){
 const [user,setUser]=useState<any>(null),[checking,setChecking]=useState(!!accountSession()),[notice,setNotice]=useState('');
 useEffect(()=>{
  let version=0;
  async function verify(){
   const run=++version,session=accountSession();
   if(!session){setUser(null);setChecking(false);return;}
   try{
    const result=await accountApi('/api/account/session',{},session);
    if(run!==version||accountSession()?.token!==session.token)return;
    setUser(result.user);setNotice('');
    if(returnPath)location.replace(returnPath);
   }catch(error){
    if(run!==version||accountSession()?.token!==session.token)return;
    setUser(null);
    if((error as any).status===401)saveSession(null);
    else setNotice((error as Error).message);
   }finally{if(run===version)setChecking(false);}
  }
  function changed(){
   const session=accountSession();
   if(!session)setUser(null);
   else setUser((previous:any)=>previous?.id===session.user.id?previous:null);
   verify();
  }
  function storage(event:StorageEvent){if(event.key===SESSION_KEY||event.key===null)changed();}
  verify();
  const verification=window.setInterval(verify,60000);
  const timer=window.setInterval(()=>{if(!accountSession())setUser(null);},1000);
  window.addEventListener('focus',verify);window.addEventListener(SESSION_EVENT,changed);window.addEventListener('storage',storage);
  return ()=>{version++;clearInterval(timer);clearInterval(verification);window.removeEventListener('focus',verify);window.removeEventListener(SESSION_EVENT,changed);window.removeEventListener('storage',storage);};
 },[]);
 function signedIn(session:any){
  saveSession(session);
  if(returnPath)location.replace(returnPath);
  else{
   history.replaceState(null,'','/papers/#library');
   setNotice('');setUser(session.user);setChecking(false);
  }
 }
 async function logout(){
  const session=accountSession();
  if(accountSession()?.token===session?.token)saveSession(null);
  if(session)try{await accountApi('/api/account/logout',{method:'POST'},session);}
  catch{setNotice('Signed out on this device. The service could not confirm session revocation.');}
  history.replaceState(null,'','/papers/');
 }
 if(checking)return <main className="cloud-shell account-shell"><p role="status">Checking your session…</p></main>;
 return user?<Workspace key={user.id} user={user} onLogout={logout}/>:<>
  <AccountForm onSignedIn={signedIn}/>{notice&&<p className="cloud-shell inline-notice" role="status">{notice}</p>}
 </>;
}

createRoot(document.getElementById('root')!).render(<App/>);

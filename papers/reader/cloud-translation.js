import {accountApi,accountSession,jsonRequest,SESSION_KEY,SESSION_EVENT} from './account-client.js?v=20261118-accounts';
export function createCloudTranslation(changed=()=>{}){
 let issue='',configured=null,epoch=0;
 function session(){const current=accountSession();return current?.user?.admin?current:null;}
 async function refresh(){
  const job=++epoch;configured=null;issue='';
  if(session()){
   try{const info=await accountApi('/api/translation/status');if(job===epoch)configured=info.configured;}
   catch(error){if(job===epoch)issue=error.message;}
  }
  if(job===epoch)changed();
 }
 async function translate(text){
  if(!session())throw Error('Log in to the site owner account to use cloud translation.');
  return accountApi('/api/translation/translate',jsonRequest({text,targetLanguage:'zh-CN'}));
 }
 window.addEventListener(SESSION_EVENT,refresh);
 window.addEventListener('storage',event=>{if(event.key===SESSION_KEY||event.key===null)refresh();});
 return {session,translate,refresh,get message(){
  return issue||(configured===false?'Cloud DeepSeek translation is not configured.':session()?'':'Log in to the site owner account for DeepSeek translation.');
 },get configured(){return configured;}};
}

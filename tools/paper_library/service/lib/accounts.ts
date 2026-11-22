import {bindings, json} from './cloud';
import {body} from './translation';

const ownerName = 'Yak9ce3teeh';
const encoder = new TextEncoder();
const sessionHours = 12;
type User = {id:string; username:string; admin:number; password_hash:string; salt:string};

export class AccountError extends Error {
 constructor(message:string, public status:number) { super(message); }
}
export const hex = (buffer:ArrayBuffer | Uint8Array) =>
 Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2,'0')).join('');
export const randomCode = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value:string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const bearer = (request:Request) => request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
export const equal = (a:string,b:string) =>
 crypto.subtle.timingSafeEqual(encoder.encode(a),encoder.encode(b));

async function passwordHash(password:string,salt:string) {
 const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 let result = encoder.encode(salt) as Uint8Array<ArrayBuffer>;
 // Workers limits PBKDF2 to 100,000 iterations per deriveBits call.
 for (let round=0;round<6;round++) {
  result = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:result,iterations:100000},key,256));
 }
 return hex(result);
}
function username(value:unknown) {
 if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{3,32}$/.test(value))
  throw new AccountError('Use 3–32 letters, numbers, underscores or hyphens for your username.',400);
 return value;
}
function password(value:unknown, confirmation:unknown) {
 if(typeof value!=='string'||value.length<12||value.length>128||new Set(value).size<5||/^(?:0123456789|1234567890)+$/.test(value))
  throw new AccountError('Choose a password of 12–128 characters that is hard to guess.',400);
 if(value!==confirmation)throw new AccountError('The passwords do not match.',400);
 return value;
}
const profile = (user:User) => ({id:user.id,username:user.username,admin:!!user.admin});
const findUser = (name:string) => bindings().DB.prepare('SELECT * FROM library_users WHERE username=? COLLATE NOCASE').bind(name).first<User>();

export async function principal(request:Request) {
 const token = bearer(request);
 if(!token)return null;
 return bindings().DB.prepare(`SELECT u.* FROM library_sessions s JOIN library_users u ON u.id=s.user_id
  WHERE s.token_hash=? AND s.expires>?`).bind(await digest(token),Date.now()).first<User>();
}
export async function requireUser(request:Request) {
 const user = await principal(request);
 if(!user)throw new AccountError('Log in to access your library.',401);
 return user;
}
export async function limit(request:Request, action:string, max:number, identity='') {
 const window = Math.floor(Date.now()/900000);
 const ip = request.headers.get('CF-Connecting-IP') || 'local';
 const key = await digest(action+':'+(identity||ip));
 const row = await bindings().DB.prepare(`INSERT INTO account_limits(scope,window,count) VALUES(?,?,1)
  ON CONFLICT(scope) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END
  WHERE window!=excluded.window OR count<? RETURNING count`).bind(key,window,max).first();
 if(!row)throw new AccountError('Too many attempts. Try again in a few minutes.',429);
}
async function newSession(user:User) {
 const token = randomCode(), expires = Date.now()+sessionHours*3600000;
 const db = bindings().DB;
 const [, , inserted] = await db.batch([
  db.prepare('DELETE FROM library_sessions WHERE expires<=?').bind(Date.now()),
  db.prepare('DELETE FROM account_limits WHERE window<?').bind(Math.floor(Date.now()/900000)-96),
  db.prepare(`INSERT INTO library_sessions(token_hash,user_id,expires)
   SELECT ?,id,? FROM library_users WHERE id=? AND password_hash=?`).bind(await digest(token),expires,user.id,user.password_hash)
 ]);
 if(inserted.meta.changes!==1)throw new AccountError('Account changed. Log in again.',409);
 return {user:profile(user),token,expires};
}
async function createUser(name:string, value:string) {
 const salt=randomCode(), id=crypto.randomUUID();
 const hash=await passwordHash(value,salt);
 const user=await bindings().DB.prepare(`INSERT INTO library_users
  (id,username,password_hash,salt,recovery_hash) VALUES(?,?,?,?,'')
  ON CONFLICT DO NOTHING RETURNING *`).bind(id,name,hash,salt).first<User>();
 if(!user)throw new AccountError('This username is already in use.',409);
 return user;
}

async function changePassword(user:User, value:string) {
 const salt=randomCode(), hash=await passwordHash(value,salt), db=bindings().DB;
 const [updated] = await db.batch([
  db.prepare('UPDATE library_users SET password_hash=?,salt=? WHERE id=? AND password_hash=?')
   .bind(hash,salt,user.id,user.password_hash),
  db.prepare(`DELETE FROM library_sessions WHERE user_id=? AND EXISTS
   (SELECT 1 FROM library_users WHERE id=? AND salt=?)`).bind(user.id,user.id,salt)
 ]);
 if(updated.meta.changes!==1)throw new AccountError('Account changed. Log in again.',409);
 return newSession({...user,password_hash:hash,salt});
}

export async function accountRoute(request:Request, path:string) {
 if(path==='account/session'&&request.method==='GET'){
  const user=await principal(request);
  return user?json({user:profile(user)}):json({error:'Log in to access your library.'},401);
 }
 if(request.method!=='POST')return json({error:'Method unavailable.'},405);
 if(path==='account/logout'){
  const token=bearer(request);
  if(token)await bindings().DB.prepare('DELETE FROM library_sessions WHERE token_hash=?').bind(await digest(token)).run();
  return json({ok:true});
 }
 await limit(request,path,path==='account/signup'?5:12);
 let input:any;
 try{input=await body(request);}catch{throw new AccountError('Invalid account request.',400);}
 if(!input||typeof input!=='object'||Array.isArray(input))throw new AccountError('Invalid account request.',400);
 if(path==='account/password'){
  const user=await requireUser(request);
  await limit(request,path,5,user.id);
  const current=input.currentPassword;
  if(typeof current!=='string'||current.length>128||!equal(await passwordHash(current,user.salt),user.password_hash))
   throw new AccountError('Incorrect current password.',400);
  const value=password(input.password,input.confirmation);
  if(value===current)throw new AccountError('Choose a different password.',400);
  return json(await changePassword(user,value));
 }
 const name=username(input?.username);
 if(path==='account/signup'){
  const value=password(input.password,input.confirmation);
  if(name.toLowerCase()===ownerName.toLowerCase())throw new AccountError('This username is already in use.',409);
  return json(await newSession(await createUser(name,value)),201);
 }
 await limit(request,path,8,name.toLowerCase());
 const user=await findUser(name);
 if(path==='account/login'){
  if(typeof input.password!=='string'||input.password.length>128)throw new AccountError('Incorrect username or password.',401);
  const hash=await passwordHash(input.password,user?.salt||'0'.repeat(64));
  if(!user||!equal(hash,user.password_hash))throw new AccountError('Incorrect username or password.',401);
  return json(await newSession(user));
 }
 return json({error:'Route unavailable.'},404);
}

import assert from 'node:assert/strict';
import {getOwnerKey,rememberOwner,remembersLibrary,setRememberLibrary,forgetOwner,ownerVersion,KEY} from '../../../papers/reader/owner-session.js';
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}};
globalThis.localStorage=store();globalThis.sessionStorage=store();globalThis.window=new EventTarget();
const key='a'.repeat(64);rememberOwner(key,true);assert.equal(getOwnerKey(),key);
// A fresh tab has a fresh session store and must still recover a remembered account.
globalThis.sessionStorage=store();assert.equal(getOwnerKey(),key);assert.equal(remembersLibrary(),true);
setRememberLibrary(false);assert.equal(getOwnerKey(),key);assert.equal(localStorage.getItem(KEY),null);assert.equal(remembersLibrary(),false);
// Closing a temporary tab must not persist its access in a later session.
globalThis.sessionStorage=store();assert.equal(getOwnerKey(),'');
rememberOwner(key,false);setRememberLibrary(true);globalThis.sessionStorage=store();assert.equal(getOwnerKey(),key);
assert.throws(()=>rememberOwner('invalid',true));assert.equal(getOwnerKey(),key);
const beforeForget=ownerVersion();forgetOwner();assert.notEqual(ownerVersion(),beforeForget);assert.equal(getOwnerKey(),'');assert.equal(localStorage.getItem(KEY),null);
console.log('PASS remembered account reload, new tabs, temporary session, remember toggling, invalid key and explicit forgetting');

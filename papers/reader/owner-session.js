// One browser profile for the personal library, shared by adding and reading.
export const KEY='papers.service.owner-key';
export const REMEMBER_KEY='papers.service.remember';
export const VERSION='papers.service.owner-version';
export function ownerVersion(){return localStorage.getItem(VERSION)||'';}
export const CHANGE='papers-service-connection-change';
export function getOwnerKey(){try{return sessionStorage.getItem(KEY)||localStorage.getItem(KEY)||'';}catch{return '';}}
export function remembersLibrary(){try{return localStorage.getItem(REMEMBER_KEY)!=='false';}catch{return false;}}
export function rememberOwner(key,remember=remembersLibrary()){
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw Error('Enter the library owner access key.');
 // Write the selected store before removing the old copy; storage errors keep access.
 if(remember){localStorage.setItem(KEY,key);sessionStorage.removeItem(KEY);}else{sessionStorage.setItem(KEY,key);localStorage.removeItem(KEY);}
 localStorage.setItem(REMEMBER_KEY,String(remember));localStorage.setItem(VERSION,crypto.randomUUID());window.dispatchEvent(new Event(CHANGE));
}
export function setRememberLibrary(remember){const key=getOwnerKey();if(key)rememberOwner(key,remember);else localStorage.setItem(REMEMBER_KEY,String(remember));}
export function forgetOwner(){sessionStorage.removeItem(KEY);localStorage.removeItem(KEY);localStorage.setItem(VERSION,crypto.randomUUID());window.dispatchEvent(new Event(CHANGE));}

const encoder = new TextEncoder();
export const bytes = value => encoder.encode(value);
export const b64 = data => { let s=''; for(const n of new Uint8Array(data))s+=String.fromCharCode(n);return btoa(s); };
export const unb64 = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
export const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export async function hash(value) { return b64(await crypto.subtle.digest('SHA-256', bytes(value))); }
async function hmacKey(secret){return crypto.subtle.importKey('raw',bytes(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function equal(provided,expected,secret){
 const key=await hmacKey(secret);
 const signature=await crypto.subtle.sign('HMAC',key,bytes(expected));
 return crypto.subtle.verify('HMAC',key,signature,bytes(provided));
}
async function aesKey(secret){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',bytes('mawayid-labels:'+secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function seal(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await aesKey(secret),bytes(JSON.stringify(value)));return b64(iv)+'.'+b64(data);}
export async function unseal(value,secret){const [iv,data]=value.split('.');const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await aesKey(secret),unb64(data));return JSON.parse(new TextDecoder().decode(plain));}

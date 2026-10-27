export type GmailConfig={GMAIL_RELAY_URL?:string;GMAIL_RELAY_SECRET?:string};
export class GmailError extends Error{constructor(public status:number,message:string){super(message)}}
export function gmailReady(e:GmailConfig){return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(e.GMAIL_RELAY_URL||'')&&(e.GMAIL_RELAY_SECRET||'').length>=32}
export async function sendGmailCode(e:GmailConfig,to:string,code:string){
 if(!gmailReady(e))throw new GmailError(503,'The temporary email connection is not ready yet.');
 const payload=JSON.stringify({type:'verification',to,code,id:crypto.randomUUID(),at:Date.now()});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(e.GMAIL_RELAY_SECRET!),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(payload)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 let response:Response;
 try{response=await fetch(e.GMAIL_RELAY_URL!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,signature}),signal:AbortSignal.timeout(20000)})}catch{throw new GmailError(503,'We could not confirm that your code was sent. Please try again in a minute.')}
 let data:any;try{data=await response.json()}catch{throw new GmailError(503,'Email connection needs attention. Please contact the organiser.')}
 if(data?.error==='quota')throw new GmailError(429,'The temporary email service has reached its sending limit. Please try again later. Existing signed-in residents can continue using the app.');
 if(!response.ok||data?.ok!==true)throw new GmailError(503,'We could not send your code. Please try again later or contact the organiser.');
}

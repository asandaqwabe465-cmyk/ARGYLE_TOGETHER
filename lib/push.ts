import webpush from 'web-push';
// Encrypted notifications contain event type and ID, never resident details.
export type PushBindings={DB:D1Database;VAPID_PUBLIC_KEY?:string;VAPID_PRIVATE_KEY?:string;VAPID_SUBJECT?:string};
export const pushReady=(e:PushBindings)=>!!(e.VAPID_PUBLIC_KEY&&e.VAPID_PRIVATE_KEY&&e.VAPID_SUBJECT);
export function validEndpoint(value:unknown):value is string{
 if(typeof value!=='string'||value.length>2048)return false;
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.pathname.length>1&&(u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com'||u.hostname==='web.push.apple.com'||u.hostname.endsWith('.push.apple.com'))}catch{return false}
}
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
export async function subscriptionId(endpoint:string){return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(endpoint))))}
export type Subscription={endpoint:string;p256dh:string;auth:string};
export type PushMessage={kind:'distress'|'trip'|'test';id?:string;expires:number};
export async function sendPush(e:PushBindings,sub:Subscription,message:PushMessage):Promise<'accepted'|'gone'|'retry'|'failed'|'configuration'>{
 if(!pushReady(e)||!validEndpoint(sub.endpoint))return 'failed';
 let stage='prepare';
 try{
  const request=webpush.generateRequestDetails({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},JSON.stringify(message),{vapidDetails:{subject:e.VAPID_SUBJECT!,publicKey:e.VAPID_PUBLIC_KEY!,privateKey:JSON.parse(e.VAPID_PRIVATE_KEY!).d},TTL:60,urgency:message.kind==='distress'?'high':'normal',contentEncoding:'aes128gcm'});
  stage='send';
  const headers=new Headers();for(const [key,value] of Object.entries(request.headers)){if(key.toLowerCase()!=='content-length')headers.set(key,String(value))}
  const response=await fetch(sub.endpoint,{method:'POST',headers,body:new Uint8Array(request.body!),redirect:'manual',signal:AbortSignal.timeout(message.kind==='test'?10000:4000)});
  if(!response.ok)console.error('Push service rejection',JSON.stringify({provider:new URL(sub.endpoint).hostname,status:response.status}));
  // Cleanup failure must not turn an accepted notification into a failed send.
  try{await response.body?.cancel()}catch{}
  return response.ok?'accepted':[404,410].includes(response.status)?'gone':[401,403].includes(response.status)?'configuration':response.status===429||response.status>=500?'retry':'failed';
 }catch(error){
  // Never log endpoint tokens, encryption keys, authorization headers or payloads.
  const name=error instanceof Error?error.name:'unknown';
  const reason=error instanceof Error&&/not implemented|not supported|is not a function/i.test(error.message)?'runtime-unsupported':error instanceof Error&&/key|VAPID|JSON/i.test(error.message)?'key-configuration':'other';
  const detail=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[url]').replace(/[A-Za-z0-9_+/=-]{32,}/g,'[redacted]').slice(0,240):'Unknown error';
  console.error('Push operation failed',JSON.stringify({stage,name,reason,detail}));
  return stage==='prepare'?'configuration':'retry';
 }
}
export async function enqueuePush(e:PushBindings){
 if(!pushReady(e))return;
 // This also recovers an interrupted enqueue on the next alert poll. Only
 // subscriptions that existed when the alert was posted receive it.
 await e.DB.prepare("INSERT INTO push_deliveries (id,alert_id,subscription_id,created) SELECT a.id||':'||s.id,a.id,s.id,? FROM alerts a CROSS JOIN push_subscriptions s JOIN users u ON u.id=s.user_id WHERE a.status='active' AND a.created>? AND s.created<=a.created AND s.distress=1 AND u.complete=1 ON CONFLICT(id) DO NOTHING").bind(Date.now(),Date.now()-600000).run();
 await e.DB.prepare("INSERT INTO push_deliveries (id,trip_id,subscription_id,created) SELECT t.id||':'||s.id,t.id,s.id,? FROM trips t CROSS JOIN push_subscriptions s JOIN users u ON u.id=s.user_id WHERE t.status='open' AND t.departure>? AND t.created>? AND s.created<=t.created AND s.trips=1 AND s.user_id!=t.owner_id AND u.complete=1 ON CONFLICT(id) DO NOTHING").bind(Date.now(),Date.now(),Date.now()-600000).run();
}
export async function drainPush(e:PushBindings){
 if(!pushReady(e))return;
 const end=Date.now()+20000;
 // Leases prevent concurrent resident polls from sending the same queue entry.
 // Unfinished work is retried by subsequent authenticated alert polls.
 for(let batch=0;batch<10&&Date.now()<end;batch++){
  const now=Date.now();
  const rows=(await e.DB.prepare("UPDATE push_deliveries SET locked_until=?,attempts=attempts+1 WHERE id IN (SELECT d.id FROM push_deliveries d LEFT JOIN alerts a ON a.id=d.alert_id LEFT JOIN trips t ON t.id=d.trip_id JOIN push_subscriptions s ON s.id=d.subscription_id WHERE d.status='pending' AND d.next_attempt<=? AND d.locked_until<=? AND d.attempts<3 AND ((a.status='active' AND a.created>? AND s.distress=1 AND s.created<=a.created) OR (t.status='open' AND t.created>? AND t.departure>? AND s.trips=1 AND s.created<=t.created)) ORDER BY (d.alert_id IS NOT NULL) DESC,d.created LIMIT 10) RETURNING *").bind(now+30000,now,now,now-600000,now-600000,now).all<any>()).results;
  if(!rows.length)break;
  await Promise.all(rows.map(async row=>{
   const sub=await e.DB.prepare('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE id=?').bind(row.subscription_id).first<Subscription>();
   const outcome=sub?await sendPush(e,sub,{kind:row.alert_id?'distress':'trip',id:row.alert_id||row.trip_id,expires:Date.now()+60000}):'gone';
   await e.DB.prepare('UPDATE push_deliveries SET status=?,locked_until=0,next_attempt=? WHERE id=?').bind(outcome==='retry'&&row.attempts<3?'pending':outcome==='accepted'?'accepted':'failed',Date.now()+30000,row.id).run();
   if(outcome==='gone')await e.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(row.subscription_id).run();
  }));
 }
 await e.DB.prepare("UPDATE push_deliveries SET status='expired' WHERE status='pending' AND ((attempts>=3 AND locked_until<=?) OR alert_id IN (SELECT id FROM alerts WHERE status!='active' OR created<=?) OR trip_id IN (SELECT id FROM trips WHERE status!='open' OR created<=? OR departure<=?))").bind(Date.now(),Date.now()-600000,Date.now()-600000,Date.now()).run();
 await e.DB.prepare('DELETE FROM push_deliveries WHERE created<?').bind(Date.now()-86400000).run();
}

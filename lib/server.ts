import {gmailReady,sendGmailCode,GmailError} from './gmail';
import {env,waitUntil} from 'cloudflare:workers';
import {pushReady,validEndpoint,subscriptionId,sendPush,enqueuePush,drainPush,type PushBindings} from './push';
import {PRIVACY_VERSION,ESCORT_WAIT,canRequestEscort,validLocation,LOCATION_TTL,cleanEmail} from './policy';
import {panicCoordinates} from './panic';
type Bindings=PushBindings&{DB:D1Database;BUCKET:R2Bucket;RESEND_API_KEY?:string;EMAIL_FROM?:string;RESIDENCE_INVITE_CODE?:string;AUTH_SECRET?:string;ESCORT_EMAILS?:string;ADMIN_EMAIL?:string;APP_ORIGIN?:string;EMAIL_PROVIDER?:string;GMAIL_RELAY_URL?:string;GMAIL_RELAY_SECRET?:string};
type User={id:string;email:string;name:string;phone:string;photo:string;complete:number;escort?:boolean;admin?:boolean;volunteerStatus?:string};
class HttpError extends Error{constructor(public status:number,message:string){super(message)}}
function need(condition:unknown,message:string,status=400):asserts condition{if(!condition)throw new HttpError(status,message)}
const E=()=>env as unknown as Bindings;
const db=()=>{need(E().DB,'The service is being prepared. Please try again later.',503);return E().DB};
const stmt=(sql:string,...args:any[])=>db().prepare(sql).bind(...args);
const one=async<T=any>(sql:string,...args:any[])=>stmt(sql,...args).first<T>();
const all=async(sql:string,...args:any[])=>(await stmt(sql,...args).all()).results;
const run=async(sql:string,...args:any[])=>stmt(sql,...args).run();
const token=()=>crypto.randomUUID()+crypto.randomUUID();
async function hash(s:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(E().AUTH_SECRET||'unconfigured'),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('')}
function text(v:unknown,min:number,max:number){need(typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max,`Please enter between ${min} and ${max} characters.`);return (v as string).trim()}
function security(email:string){return (E().ESCORT_EMAILS||'').split(',').map(cleanEmail).filter(Boolean).includes(email)}
function result(data:any,status=200,headers:Record<string,string>={}){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers}})}
async function user(req:Request,complete=true){const session=req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('argyle_session='))?.slice(15);if(!session)return null;const u=await one<User>('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.digest=? AND s.expires>?',await hash(session),Date.now());if(u){await decorate(u);if(complete)need(u.complete,'Complete your profile first.',403)}return u}
async function rate(key:string,max:number,window:number){const n=Date.now(),bucket=Math.floor(n/window);const row=await one<{count:number}>('INSERT INTO limits (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key+':'+bucket,n+window*2);need(row&&row.count<=max,'Too many attempts. Please wait before trying again.',429)}
async function sendMail(to:string,subject:string,body:string){const e=E();need(e.RESEND_API_KEY&&e.EMAIL_FROM,'Email verification is not connected yet. The app organiser needs to finish email setup.',503);const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+e.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:e.EMAIL_FROM,to:[to],subject,text:body}),signal:AbortSignal.timeout(15000)});need(r.ok,'We could not send your email. Please try again in a minute.',503)}

const temporaryEmail=()=>E().EMAIL_PROVIDER==='gmail';
const adminEmail=()=>cleanEmail(E().ADMIN_EMAIL||'asandaqwabe465@gmail.com');
async function decorate(u:User){const v=await one('SELECT status FROM volunteers WHERE user_id=?',u.id);u.volunteerStatus=v?.status||'none';u.admin=u.email===adminEmail();u.escort=security(u.email)||v?.status==='approved';return u}
async function applyVolunteer(u:User,reason:unknown){
 const note=text(reason||'',0,600);await run('INSERT INTO volunteers (user_id,reason,created) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING',u.id,note,Date.now());
 return notifyVolunteer(u);
}
async function notifyVolunteer(u:User){
 if(temporaryEmail())return {emailAccepted:false,emailStatus:'disabled',message:'Your application is saved for review in the organiser dashboard. Approval emails are paused during the temporary setup.'};
 const v=await one('SELECT * FROM volunteers WHERE user_id=?',u.id);if(!v||v.status!=='pending'||v.notified)return {emailAccepted:!!v?.notified};
 await rate('volunteer-email:'+u.id,3,3600000);
 try{await sendMail(adminEmail(),'Volunteer approval requested — Argyle House',u.name+' ('+u.email+') would like to volunteer as an escort.\nPhone: '+u.phone+'\nApplication: '+v.reason+'\n\nSign in as '+adminEmail()+' to review and approve or decline this request: '+(E().APP_ORIGIN||'https://argyle-walk-together.sweet-cream-7564.chatgpt.site')+'/?view=volunteers\n\nOpening this link does not approve the applicant.');await run('UPDATE volunteers SET notified=? WHERE user_id=?',Date.now(),u.id);return {emailAccepted:true}}catch{return {emailAccepted:false,warning:'Your volunteer request is saved, but the approval email could not be sent. You can retry from My profile. The organiser can still review it in the app.'}}
}

async function member(tripId:string,id:string){const t=await one('SELECT * FROM trips WHERE id=?',tripId);if(!t)return false;if(t.owner_id===id)return true;return !!(await one("SELECT id FROM replies WHERE trip_id=? AND user_id=? AND status='accepted'",tripId,id)||await one("SELECT trip_id FROM escorts WHERE trip_id=? AND escort_id=? AND status='accepted'",tripId,id))}

const tripEnded=(t:any,n:number)=>!['open','active'].includes(t.status)||t.departure<=n-(t.status==='active'?14400000:3600000);
async function chatAccess(t:any,id:string){return t.owner_id===id||!!await one("SELECT id FROM replies WHERE trip_id=? AND user_id=? AND status IN ('pending','accepted')",t.id,id)||!!await one("SELECT trip_id FROM escorts WHERE trip_id=? AND escort_id=? AND status IN ('accepted','closed')",t.id,id)}
async function companions(t:any,id:string){
 const people=await all("SELECT u.id,u.name,'Trip owner' AS role FROM users u WHERE u.id=? UNION ALL SELECT u.id,u.name,'Walking partner' AS role FROM users u JOIN replies r ON r.user_id=u.id WHERE r.trip_id=? AND r.status='accepted' UNION ALL SELECT u.id,u.name,'Escort' AS role FROM users u JOIN escorts e ON e.escort_id=u.id WHERE e.trip_id=? AND e.escort_id IS NOT NULL AND e.status IN ('accepted','closed')",t.owner_id,t.id,t.id);
 return Array.from(new Map(people.filter(p=>p.id!==id).map(p=>[p.id,p])).values());
}

async function cleanup(){const n=Date.now();await db().batch([stmt('DELETE FROM locations WHERE updated<? OR trip_id IN (SELECT id FROM trips WHERE departure<? OR status NOT IN (\'open\',\'active\'))',n-LOCATION_TTL,n-14400000),stmt('DELETE FROM sessions WHERE expires<?',n),stmt('DELETE FROM challenges WHERE expires<?',n),stmt('DELETE FROM limits WHERE expires<?',n)])}
export async function handle(req:Request){try{return await dispatch(req)}catch(e){if(e instanceof HttpError||e instanceof GmailError)return result({error:e.message},e.status);console.error('Argyle request failed',e instanceof Error?e.message:'unknown');return result({error:'This service is temporarily unavailable. Please try again.'},503)}}
async function dispatch(req:Request):Promise<Response>{
 const url=new URL(req.url),path=url.pathname.replace(/^\/api\//,'').split('/'),method=req.method,n=Date.now();
 if(method==='POST'){const origin=req.headers.get('origin');need(origin===url.origin,'This request must come from the app.',403);need(Number(req.headers.get('content-length')||0)<=(path[0]==='photo'?5*1024*1024+64*1024:1200000),'Upload is too large.',413)}
 if(path[0]==='session')return result({user:await user(req,false),authReady:!!(E().AUTH_SECRET&&E().AUTH_SECRET!.length>=32&&(temporaryEmail()?gmailReady(E()):E().RESEND_API_KEY&&E().EMAIL_FROM)&&E().RESIDENCE_INVITE_CODE),temporaryEmail:temporaryEmail()});
 let b:any={};if(method==='POST'&&path[0]!=='photo'){need(req.headers.get('content-type')?.includes('application/json'),'Expected JSON.',415);const raw=await req.text();need(raw.length<12000,'Request is too large.',413);try{b=JSON.parse(raw)}catch{throw new HttpError(400,'Invalid request.')}}
 if(path[0]==='auth'&&method==='POST'){
  if(path[1]==='logout'){const u=await user(req,false);if(u)await db().batch([stmt('DELETE FROM sessions WHERE user_id=?',u.id),stmt('DELETE FROM locations WHERE user_id=?',u.id),stmt('DELETE FROM push_subscriptions WHERE user_id=?',u.id)]);return result({ok:true},200,{'Set-Cookie':'argyle_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'})}
  need(E().AUTH_SECRET&&E().AUTH_SECRET!.length>=32,'Account setup is not finished yet. You can explore the sample trips.',503);
  const email=cleanEmail(b.email);need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254,'Enter a valid email address.');
  await rate('auth-ip:'+await hash(req.headers.get('cf-connecting-ip')||'local'),30,3600000);
  if(path[1]==='send'){
   await rate('send:'+await hash(email),5,3600000);
   const existing=await one('SELECT id FROM users WHERE email=?',email);
   if(!existing&&email!==adminEmail())need(E().RESIDENCE_INVITE_CODE&&typeof b.invite==='string'&&await hash(b.invite)===await hash(E().RESIDENCE_INVITE_CODE!),'Enter the invitation code from your app organiser.',403);
   const prev=await one('SELECT sent FROM challenges WHERE email=?',email);need(!prev||n-prev.sent>=60000,'Please wait one minute before requesting another code.',429);
   let random=crypto.getRandomValues(new Uint32Array(1))[0];while(random>=4294000000)random=crypto.getRandomValues(new Uint32Array(1))[0];const code=String(random%1000000).padStart(6,'0'),salt=token(),digest=await hash(email+':'+salt+':'+code);
   const inserted=await run('INSERT INTO challenges (email,digest,salt,expires,sent,attempts) VALUES (?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET digest=excluded.digest,salt=excluded.salt,expires=excluded.expires,sent=excluded.sent,attempts=0 WHERE challenges.sent<=?',email,digest,salt,n+600000,n,n-60000);need(inserted.meta.changes,'Please wait one minute before requesting another code.',429);
   try{if(temporaryEmail())await sendGmailCode(E(),email,code);else await sendMail(email,'Your Argyle Together verification code',`Your verification code is ${code}. It expires in 10 minutes. Do not share this code.\n\nIf you did not request this, ignore this email.`)}catch(e){await run('DELETE FROM challenges WHERE email=? AND salt=?',email,salt);throw e}
   return result({ok:true});
  }
  if(path[1]==='verify'){
   need(typeof b.code==='string'&&/^\d{6}$/.test(b.code),'Enter the six-digit code.');await rate('verify:'+await hash(email),15,600000);
   const ch=await one('UPDATE challenges SET attempts=attempts+1 WHERE email=? AND expires>? AND attempts<5 RETURNING *',email,n);need(ch,'Code expired or too many attempts. Request a new code.',401);
   need(await hash(email+':'+ch.salt+':'+b.code)===ch.digest,'Incorrect code. Please try again.',401);
   const removed=await run('DELETE FROM challenges WHERE email=? AND digest=? AND salt=?',email,ch.digest,ch.salt);need(removed.meta.changes,'This code has already been used.',401);
   await run('INSERT INTO users (id,email,created) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING',crypto.randomUUID(),email,n);
   const u=await one<User>('SELECT * FROM users WHERE email=?',email);need(u,'Could not create your account.',503);const raw=token();await run('INSERT INTO sessions (digest,user_id,expires) VALUES (?,?,?)',await hash(raw),u!.id,n+604800000);await decorate(u!);return result({user:u},200,{'Set-Cookie':`argyle_session=${raw}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`});
  }
 }
 const u=await user(req,false);need(u,'Please sign in to continue.',401);
 if(path[0]==='privacy-requests'){
  if(method==='GET')return result({requests:u!.admin?await all('SELECT p.*,u.name,u.email FROM privacy_requests p JOIN users u ON u.id=p.user_id ORDER BY p.created DESC LIMIT 200'):await all('SELECT id,kind,details,status,created,reviewed FROM privacy_requests WHERE user_id=? ORDER BY created DESC LIMIT 100',u!.id),admin:!!u!.admin});
  if(method==='POST'&&!path[1]){need(['access','correction','deletion','privacy concern'].includes(b.kind),'Choose a request type.');const details=text(b.details||'',0,1000);await rate('privacy-request:'+u!.id,3,86400000);const id=crypto.randomUUID();const saved=await run("INSERT INTO privacy_requests (id,user_id,kind,details,created) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=? AND kind=? AND status='open')",id,u!.id,b.kind,details,n,u!.id,b.kind);need(saved.meta.changes,'You already have an open request of this type. Contact the organiser to add details.',409);return result({id,message:'Request saved for the organiser. This does not delete your account or change your data.'},201)}
  if(method==='POST'&&path[2]==='review'){need(u!.admin,'Only the app organiser can review privacy requests.',403);const saved=await run("UPDATE privacy_requests SET status='reviewed',reviewed=? WHERE id=? AND status='open'",n,path[1]);need(saved.meta.changes,'This request has already changed.',409);return result({ok:true})}
  throw new HttpError(404,'Not found.');
 }
 if(path[0]==='profile'&&method==='POST'){
  need(b.privacyAccepted===true&&b.privacyVersion===PRIVACY_VERSION,'Read and acknowledge the current privacy notice before saving your profile.');
  const name=text(b.name,2,70),phone=text(b.phone,9,22).replace(/[ ()-]/g,'');need(/^\+?[0-9]{9,15}$/.test(phone),'Enter a valid cell phone number.');need(b.locationEnabled===true,'Location permission is required.');const current=await one('SELECT photo FROM users WHERE id=?',u!.id);need(current.photo&&b.photo===current.photo,'Upload a profile picture first.');await run('UPDATE users SET name=?,phone=?,complete=1,privacy_version=?,privacy_accepted=? WHERE id=?',name,phone,PRIVACY_VERSION,n,u!.id);const updated=await user(req,false);const application=b.volunteer===true?await applyVolunteer(updated!,b.volunteerReason):{};return result({user:await user(req,false),...application});
 }
 if(path[0]==='photo'){
  need(E().BUCKET,'Photo storage is unavailable.',503);
  if(method==='POST'){
   await rate('photo:'+u!.id,10,3600000);const form=await req.formData();const file=form.get('photo');need(file instanceof File&&file.size>0&&file.size<=5*1024*1024,'Choose a JPG, PNG or WebP image up to 5 MB.');const f=file as File;const bytes=new Uint8Array(await f.arrayBuffer());const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';need(png||jpg||webp,'This file is not a supported image.');const key='profiles/'+u!.id;await E().BUCKET.put(key,bytes,{httpMetadata:{contentType:png?'image/png':jpg?'image/jpeg':'image/webp'}});await run('UPDATE users SET photo=? WHERE id=?',key,u!.id);return result({photo:key});
  }
  if(method==='GET'&&path[1]){need(u!.complete||path[1]===u!.id,'Complete your profile first.',403);const photo=await one('SELECT photo FROM users WHERE id=?',path[1]);need(photo?.photo,'Photo not found.',404);const obj=await E().BUCKET.get(photo.photo);need(obj,'Photo not found.',404);return new Response(obj!.body as any,{headers:{'Content-Type':obj!.httpMetadata?.contentType||'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})}
 }
 need(u!.complete,'Complete your profile first.',403);


 if(path[0]==='push'){
  if(method==='GET'&&path[1]==='config')return result({ready:pushReady(E()),publicKey:E().VAPID_PUBLIC_KEY||''});
  need(method==='POST','Not found.',404);need(validEndpoint(b.endpoint),'Unsupported notification service. Use Chrome, Firefox or Safari.');
  const id=await subscriptionId(b.endpoint);
  if(path[1]==='status'){const sub=await one('SELECT distress,trips FROM push_subscriptions WHERE id=? AND user_id=?',id,u!.id);return result({enabled:!!sub,distress:!!sub?.distress,trips:!!sub?.trips})}
  if(path[1]==='unsubscribe'){await run('DELETE FROM push_subscriptions WHERE id=? AND user_id=?',id,u!.id);return result({ok:true})}
  need(pushReady(E()),'Notifications are not connected yet.',503);
  if(path[1]==='subscribe'){
   await rate('push-subscribe:'+u!.id,15,3600000);need(typeof b.keys?.p256dh==='string'&&/^[A-Za-z0-9_-]{87}$/.test(b.keys.p256dh)&&typeof b.keys?.auth==='string'&&/^[A-Za-z0-9_-]{22}$/.test(b.keys.auth),'Invalid notification subscription.');need(typeof b.distress==='boolean'&&typeof b.trips==='boolean'&&(b.distress||b.trips),'Choose at least one notification type.');
   // Reassigning this browser to a new signed-in resident requires a fresh
   // explicit Enable tap; no endpoint is exposed through any read route.
   const saved=await run('INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,distress,trips,created) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?)<5 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE id=? AND user_id=?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,distress=excluded.distress,trips=excluded.trips,created=excluded.created',id,u!.id,b.endpoint,b.keys.p256dh,b.keys.auth,b.distress?1:0,b.trips?1:0,n,u!.id,id,u!.id);
   need(saved.meta.changes,'Five devices are already enabled for this account. Turn notifications off on an old device first.',409);return result({ok:true});
  }
  if(path[1]==='test'){
   const sub=await one('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE id=? AND user_id=?',id,u!.id);need(sub,'Enable notifications on this device first.',403);
   const reserved=await run('INSERT INTO limits (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET expires=excluded.expires WHERE limits.expires<=?', 'push-test-cooldown:'+u!.id,n+30000,n);
   if(!reserved.meta.changes){const limit=await one('SELECT expires FROM limits WHERE key=?','push-test-cooldown:'+u!.id);const seconds=Math.max(1,Math.ceil((limit.expires-n)/1000));return result({error:`Please wait ${seconds} seconds before sending another test.`,retryAfterSeconds:seconds},429,{'Retry-After':String(seconds)})}
   const outcome=await sendPush(E(),sub,{kind:'test',expires:n+60000});if(outcome==='gone')await run('DELETE FROM push_subscriptions WHERE id=?',id);
   if(outcome!=='accepted')return result({error:outcome==='configuration'?'The notification sender needs attention. Your phone permissions do not need changing. Please tell the organiser.':outcome==='gone'?'This device subscription has expired. Turn notifications off and on again.':outcome==='retry'?'The notification service could not be reached. Please wait 30 seconds and try again.':'The push service rejected the test. Please tell the organiser.',code:'push-'+outcome,retryAfterSeconds:30},503);
   return result({accepted:true,retryAfterSeconds:30});
  }
  throw new HttpError(404,'Not found.');
 }


 if(path[0]==='history'&&method==='GET'){
  const offset=Number(url.searchParams.get('offset')||0);need(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,'Invalid history page.');
  const rows=await all("SELECT t.*,u.name,(t.owner_id=?) AS mine,(SELECT status FROM replies WHERE trip_id=t.id AND user_id=?) AS myReply,EXISTS(SELECT 1 FROM escorts WHERE trip_id=t.id AND escort_id=?) AS myEscort FROM trips t JOIN users u ON u.id=t.owner_id WHERE (t.owner_id=? OR EXISTS(SELECT 1 FROM replies WHERE trip_id=t.id AND user_id=?) OR EXISTS(SELECT 1 FROM escorts WHERE trip_id=t.id AND escort_id=?)) AND (t.status NOT IN ('open','active') OR (t.status='open' AND t.departure<=?) OR (t.status='active' AND t.departure<=?)) ORDER BY t.departure DESC,t.id DESC LIMIT 21 OFFSET ?",u!.id,u!.id,u!.id,u!.id,u!.id,u!.id,n-3600000,n-14400000,offset);
  return result({trips:await Promise.all(rows.slice(0,20).map(async t=>({...t,companions:t.mine||t.myReply==='accepted'||t.myEscort?await companions(t,u!.id):[]}))),nextOffset:rows.length>20?offset+20:null});
 }

 if(path[0]==='incidents'){
  if(method==='GET'&&!path[1]){
   // Published reports do not expose the reporter's account, email or phone.
   const reports=await all("SELECT id,category,place,occurred,description,vehicle,status,created,updated FROM incidents WHERE status='published' ORDER BY occurred DESC LIMIT 100");
   const mine=await all('SELECT id,category,place,occurred,description,vehicle,status,created,updated FROM incidents WHERE reporter_id=? ORDER BY created DESC LIMIT 100',u!.id);
   const review=u!.admin?await all("SELECT i.*,u.name AS reporter_name,(SELECT COUNT(*) FROM incident_flags f WHERE f.incident_id=i.id AND f.status='open') AS flag_count FROM incidents i JOIN users u ON u.id=i.reporter_id WHERE i.status IN ('pending','published') OR EXISTS(SELECT 1 FROM incident_flags f WHERE f.incident_id=i.id AND f.status='open') ORDER BY flag_count DESC,i.created DESC LIMIT 200"):[];
   const flags=u!.admin?await all("SELECT incident_id,reason,details,snapshot,created FROM incident_flags WHERE status='open' ORDER BY created DESC"):[];
   return result({reports,mine,review,flags});
  }
  if(method==='POST'&&(!path[1]||path[2]==='edit')){
   need(['Suspicious behaviour','Harassment','Theft or attempted theft','Unsafe route','Other incident'].includes(b.category),'Choose an incident type.');
   const place=text(b.place,3,160),description=text(b.description,20,1500),vehicle=text(b.vehicle||'',0,160);
   need(Number.isInteger(b.occurred)&&b.occurred<=n+60000&&b.occurred>=n-2592000000,'Choose a time within the past 30 days.');need(b.factual===true,'Confirm that your report describes what you personally observed.');
   if(path[2]==='edit'){
    await rate('incident-edit:'+u!.id,20,86400000);
    const changed=await run("UPDATE incidents SET category=?,place=?,occurred=?,description=?,vehicle=?,updated=? WHERE id=? AND reporter_id=? AND status IN ('pending','published')",b.category,place,b.occurred,description,vehicle,n,path[1],u!.id);
    need(changed.meta.changes,'Only the author can edit an open report. Removed reports cannot be republished.',403);return result({ok:true});
   }
   await rate('incident:'+u!.id,5,86400000);const id=crypto.randomUUID();
   await run("INSERT INTO incidents (id,reporter_id,category,place,occurred,description,vehicle,created,status) VALUES (?,?,?,?,?,?,?,?,'published')",id,u!.id,b.category,place,b.occurred,description,vehicle,n);
   return result({id,status:'published'},201);
  }
  if(method==='POST'&&path[1]&&path[2]==='flag'){
   need(['Misleading or inaccurate','Abusive or discriminatory','Personal information','Other'].includes(b.reason),'Choose a reason.');const details=text(b.details||'',0,500);
   await rate('incident-flag:'+u!.id,10,86400000);
   const report=await one("SELECT * FROM incidents WHERE id=? AND status='published'",path[1]);need(report&&report.reporter_id!==u!.id,'Only other residents can flag a published report. You can withdraw your own report.',403);
   const snapshot=JSON.stringify({category:report.category,place:report.place,occurred:report.occurred,description:report.description,vehicle:report.vehicle});
   const changed=await run("INSERT INTO incident_flags (id,incident_id,user_id,reason,details,snapshot,created) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM incidents WHERE id=? AND status='published') ON CONFLICT(incident_id,user_id) DO NOTHING",crypto.randomUUID(),report.id,u!.id,b.reason,details,snapshot,n,report.id);
   need(changed.meta.changes,'You have already flagged this report, or it is no longer published.',409);return result({ok:true});
  }
  if(method==='POST'&&path[1]&&path[2]==='clear-flags'){
   need(u!.admin,'Only the app organiser can review flags.',403);await run("UPDATE incident_flags SET status='reviewed' WHERE incident_id=? AND status='open'",path[1]);return result({ok:true});
  }
  if(method==='POST'&&path[1]&&path[2]==='withdraw'){
   const changed=await run("UPDATE incidents SET status='withdrawn' WHERE id=? AND reporter_id=? AND status IN ('pending','published')",path[1],u!.id);need(changed.meta.changes,'Only the reporter can withdraw an open report.',403);return result({ok:true});
  }
  if(method==='POST'&&path[1]&&path[2]==='review'){
   need(u!.admin,'Only the app organiser can review reports.',403);need(['published','dismissed','resolved'].includes(b.status),'Choose publish, dismiss or resolve.');
   const changed=await run("UPDATE incidents SET status=?,reviewed=?,reviewer=? WHERE id=? AND ((status='pending' AND ? IN ('published','dismissed')) OR (status='published' AND ? IN ('dismissed','resolved')))",b.status,n,u!.id,path[1],b.status,b.status);need(changed.meta.changes,'This report has already changed. Refresh the list.',409);return result({ok:true});
  }
 }

 if(path[0]==='volunteers'){
  if(method==='POST'&&path[1]==='apply'){const notification=await applyVolunteer(u!,b.reason);return result({user:await user(req,false),...notification})}
  if(method==='POST'&&path[1]==='retry'){need(await one("SELECT user_id FROM volunteers WHERE user_id=? AND status='pending'",u!.id),'No pending application.',409);return result(await notifyVolunteer(u!))}
  need(u!.admin,'Only the app organiser can review volunteers.',403);
  if(method==='GET'&&!path[1])return result({emailNotifications:!temporaryEmail(),applications:await all('SELECT v.*,u.name,u.email,u.phone FROM volunteers v JOIN users u ON u.id=v.user_id ORDER BY v.created DESC'),inviteCode:E().RESIDENCE_INVITE_CODE||''});
  if(method==='POST'&&path[1]&&path[2]==='review'){
   need(['approved','declined','revoked'].includes(b.status),'Choose approve, decline or revoke.');
   const changed=await run("UPDATE volunteers SET status=?,reviewed=?,reviewer=? WHERE user_id=? AND ((status='pending' AND ? IN ('approved','declined')) OR (status='approved' AND ?='revoked'))",b.status,n,u!.id,path[1],b.status,b.status);
   need(changed.meta.changes,'This application has already changed. Refresh the list.',409);return result({ok:true});
  }
 }

 if(path[0]==='alerts'){
  if(method==='GET'){waitUntil(enqueuePush(E()).then(()=>drainPush(E())).catch(()=>console.error('Push queue processing failed')));await run("UPDATE alerts SET status='expired',lat=NULL,lng=NULL,accuracy=NULL,location_at=NULL WHERE status='active' AND created<=?",n-86400000);const alerts=await all("SELECT a.*,u.name,u.phone FROM alerts a JOIN users u ON u.id=a.user_id WHERE a.status='active' AND a.created>? ORDER BY a.created DESC",n-86400000);return result({alerts,emailNotifications:!temporaryEmail()})}
  if(method==='POST'&&!path[1]){
   const current=await one("SELECT * FROM alerts WHERE user_id=? AND status='active' AND created>?",u!.id,n-86400000);if(current)return result({alert:current,existing:true,emailStatus:temporaryEmail()?'disabled':undefined});
   await rate('panic:'+u!.id,3,600000);
   const fallback=await one('SELECT lat,lng,accuracy,updated AS at FROM locations WHERE user_id=? AND updated>?',u!.id,n-86400000);
   const point=panicCoordinates(b.location,n)||panicCoordinates(fallback,n),id=crypto.randomUUID();
   // One atomic statement prevents simultaneous button presses creating duplicate alerts.
   const alertId=id;
   const inserted=await run("INSERT INTO alerts (id,user_id,created,lat,lng,accuracy,location_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM alerts WHERE user_id=? AND status='active' AND created>?)",alertId,u!.id,n,point?.lat??null,point?.lng??null,point?.accuracy??null,point?.at??null,u!.id,n-86400000);
   if(!inserted.meta.changes)return result({alert:await one("SELECT * FROM alerts WHERE user_id=? AND status='active' AND created>?",u!.id,n-86400000),existing:true});
   let pushStatus='disabled';if(pushReady(E())){try{await enqueuePush(E());pushStatus='queued';waitUntil(drainPush(E()).catch(()=>console.error('Push queue processing failed')))}catch{pushStatus='delayed'}}
   if(temporaryEmail())return result({pushStatus,alert:await one('SELECT * FROM alerts WHERE id=?',alertId),emailStatus:'disabled'},201);
   const recipients=await all('SELECT email FROM users WHERE complete=1');let sent=0;
   const locationText=point?`Location recorded at ${new Date(point.at).toISOString()} (accuracy approximately ${Math.round(point.accuracy)} m): https://www.google.com/maps?q=${point.lat},${point.lng}`:'Location is unavailable. Contact the resident directly.';
   const body=`DISTRESS ALERT — ARGYLE HOUSE\n\n${u!.name} has requested urgent help.\nPhone: ${u!.phone}\n${locationText}\n\nOpen the app for updates and the resident’s profile picture: ${url.origin}\n\nThis is an automated resident alert, not a confirmation that emergency services or security have been dispatched. Do not put yourself in danger. Contact emergency services or residence security as appropriate.`;
   if(E().RESEND_API_KEY&&E().EMAIL_FROM){for(let offset=0;offset<recipients.length;offset+=100){const batch=recipients.slice(offset,offset+100);try{const delivered=await fetch('https://api.resend.com/emails/batch',{method:'POST',headers:{Authorization:'Bearer '+E().RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'panic-'+alertId+'-'+offset},body:JSON.stringify(batch.map(r=>({from:E().EMAIL_FROM,to:[r.email],subject:'DISTRESS ALERT: '+u!.name+' needs help at Argyle House',text:body}))),signal:AbortSignal.timeout(15000)});if(delivered.ok)sent+=batch.length}catch{console.error('Panic email batch failed')}}}
   await run('UPDATE alerts SET email_sent=?,email_total=? WHERE id=?',sent,recipients.length,alertId);
   return result({pushStatus,alert:await one('SELECT * FROM alerts WHERE id=?',alertId),emailStatus:sent===recipients.length?'accepted':'incomplete'},201);
  }
  if(method==='POST'&&path[1]){
   const alert=await one('SELECT * FROM alerts WHERE id=?',decodeURIComponent(path[1]));need(alert&&alert.user_id===u!.id,'Only the resident who sent this alert can change it.',403);
   if(path[2]==='resolve'){await run("UPDATE alerts SET status='resolved',lat=NULL,lng=NULL,accuracy=NULL,location_at=NULL WHERE id=?",alert.id);return result({ok:true})}
   if(path[2]==='location'){need(alert.status==='active'&&alert.created>n-86400000,'This alert is closed.',409);need(validLocation(b,n),'A fresh location is required.');await run("UPDATE alerts SET lat=?,lng=?,accuracy=?,location_at=? WHERE id=? AND status='active'",b.lat,b.lng,b.accuracy,b.at,alert.id);return result({ok:true})}
  }
 }
 if(path[0]==='location'&&method==='POST'){
  if(path[1]==='stop'){await run('DELETE FROM locations WHERE user_id=?',u!.id);return result({ok:true})}
  need(validLocation(b,n),'A fresh, valid location reading is required.');const trip=await one("SELECT * FROM trips WHERE id=? AND status='active' AND departure>?",b.tripId,n-14400000);need(trip&&await member(trip.id,u!.id),'Start an accepted trip before sharing your location.',403);await run('INSERT INTO locations (user_id,trip_id,lat,lng,accuracy,updated) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET trip_id=excluded.trip_id,lat=excluded.lat,lng=excluded.lng,accuracy=excluded.accuracy,updated=excluded.updated',u!.id,trip.id,b.lat,b.lng,b.accuracy,n);return result({ok:true});
 }
 if(path[0]==='trips'){
  if(!path[1]){
   if(method==='GET'){await cleanup();const trips=await all("SELECT t.*,u.name,(SELECT COUNT(*) FROM replies r WHERE r.trip_id=t.id) AS responses,(t.owner_id=?) AS mine,(EXISTS(SELECT 1 FROM replies r WHERE r.trip_id=t.id AND r.user_id=?) OR e.escort_id=?) AS joined,e.status AS escort_status FROM trips t JOIN users u ON u.id=t.owner_id LEFT JOIN escorts e ON e.trip_id=t.id WHERE (t.status='open' AND t.departure>?) OR (t.status='active' AND t.departure>?) ORDER BY t.departure LIMIT 100",u!.id,u!.id,u!.id,n-3600000,n-14400000);return result({trips})}
   if(method==='POST'){await rate('post:'+u!.id,12,3600000);const destination=text(b.destination,2,100),origin=text(b.origin,2,140),note=text(b.note||'',0,400);need(Number.isInteger(b.departure)&&b.departure>n&&b.departure<n+2592000000,'Choose a departure in the next 30 days.');const id=crypto.randomUUID();await run('INSERT INTO trips (id,owner_id,destination,origin,departure,note,created) VALUES (?,?,?,?,?,?,?)',id,u!.id,destination,origin,b.departure,note,n);waitUntil(enqueuePush(E()).then(()=>drainPush(E())).catch(()=>console.error('Trip notification processing failed')));return result({id},201)}
  }
  const trip=await one('SELECT t.*,u.name FROM trips t JOIN users u ON u.id=t.owner_id WHERE t.id=?',path[1]);need(trip,'Trip not found.',404);const owner=trip.owner_id===u!.id;
  const ended=tripEnded(trip,n),canChat=await chatAccess(trip,u!.id);
  if(ended)need(owner||await one('SELECT id FROM replies WHERE trip_id=? AND user_id=?',trip.id,u!.id)||await one('SELECT trip_id FROM escorts WHERE trip_id=? AND escort_id=?',trip.id,u!.id),'Only participants can view a previous trip.',403);
  if(path[2]==='messages'){
   need(canChat,'Only the trip owner, current applicants, accepted partners and assigned escort can read this conversation.',403);
   if(method==='GET'){
    const after=Number(url.searchParams.get('after')||0),before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);
    need(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(before)&&before>0&&!(url.searchParams.has('after')&&url.searchParams.has('before')),'Invalid message page.');
    const limit=after?100:50,rows=await all('SELECT m.*,u.name FROM trip_messages m JOIN users u ON u.id=m.user_id WHERE m.trip_id=? AND m.seq'+(after?'>? ORDER BY m.seq ASC':'<? ORDER BY m.seq DESC')+' LIMIT ?',trip.id,after||before,limit+1);
    const page=rows.slice(0,limit);return result({messages:after?page:page.reverse(),hasMore:rows.length>limit,readOnly:ended});
   }
   if(method==='POST'){
    need(!ended,'This trip has ended. Its conversation is read-only.',409);const body=text(b.body,1,1500);need(typeof b.id==='string'&&/^[a-f0-9-]{36}$/i.test(b.id),'Invalid message identifier.');
    const existing=await one('SELECT m.*,u.name FROM trip_messages m JOIN users u ON u.id=m.user_id WHERE m.id=?',b.id);
    if(existing){need(existing.user_id===u!.id&&existing.trip_id===trip.id&&existing.body===body,'This message identifier has already been used.',409);return result({message:existing})}
    await rate('chat:'+u!.id,30,60000);
    const saved=await run("INSERT INTO trip_messages (id,trip_id,user_id,body,created) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM trips t WHERE t.id=? AND ((t.status='open' AND t.departure>?) OR (t.status='active' AND t.departure>?)) AND (t.owner_id=? OR EXISTS(SELECT 1 FROM replies r WHERE r.trip_id=t.id AND r.user_id=? AND r.status IN ('pending','accepted')) OR EXISTS(SELECT 1 FROM escorts e WHERE e.trip_id=t.id AND e.escort_id=? AND e.status='accepted'))) ON CONFLICT(id) DO NOTHING",b.id,trip.id,u!.id,body,n,trip.id,n-3600000,n-14400000,u!.id,u!.id,u!.id);
    const message=await one('SELECT m.*,u.name FROM trip_messages m JOIN users u ON u.id=m.user_id WHERE m.id=?',b.id);
    need(message&&message.user_id===u!.id&&message.trip_id===trip.id&&message.body===body,'The trip or your access changed. Refresh and try again.',409);return result({message},saved.meta.changes?201:200);
   }
  }

  if(method==='GET'){
   const accepted=await member(trip.id,u!.id),canShare=accepted&&trip.status==='active'&&trip.departure>n-14400000;
   const replies=await all('SELECT r.*,u.name FROM replies r JOIN users u ON u.id=r.user_id WHERE r.trip_id=? AND (?=1 OR r.user_id=?) ORDER BY r.created',trip.id,owner||accepted?1:0,u!.id);
   const escort=await one('SELECT e.*,u.name,CASE WHEN ?=1 THEN u.phone ELSE NULL END AS phone FROM escorts e LEFT JOIN users u ON u.id=e.escort_id WHERE e.trip_id=?',owner?1:0,trip.id);
   const locations=canShare?await all('SELECT l.*,u.name FROM locations l JOIN users u ON u.id=l.user_id WHERE l.trip_id=? AND l.updated>?',trip.id,n-LOCATION_TTL):[];return result({trip,replies,escort,locations,canShare,canChat,isParticipant:!!accepted,chatReadOnly:ended});
  }
  if(method==='POST'){
   const action=path[2];
   if(action==='finish'){need(owner,'Only the trip owner can close this trip.',403);await db().batch([stmt("UPDATE trips SET status=CASE WHEN status='active' THEN 'complete' ELSE 'cancelled' END WHERE id=? AND status IN ('open','active')",trip.id),stmt('DELETE FROM locations WHERE trip_id=?',trip.id),stmt("UPDATE escorts SET status='closed' WHERE trip_id=?",trip.id)]);return result({ok:true})}
   need(trip.status==='open'&&(trip.departure>n||(action==='start'&&trip.departure>n-3600000)),'This trip is no longer open.',409);
   if(action==='reply'){need(!owner,'You cannot join your own trip.');need(!await member(trip.id,u!.id),'You have already joined this walk.',409);const meeting=text(b.meeting,3,200);await rate('reply:'+u!.id,30,3600000);const r=await run("INSERT INTO replies (id,trip_id,user_id,meeting,created) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM trips WHERE id=? AND status='open' AND departure>?) ON CONFLICT(trip_id,user_id) DO NOTHING",crypto.randomUUID(),trip.id,u!.id,meeting,n,trip.id,n);need(r.meta.changes,'You have already replied, or the trip has closed.',409);return result({ok:true})}
   if(action==='reply-action'){need(owner,'Only the trip owner can approve partners.',403);need(['accept','decline'].includes(b.action),'Invalid action.');const r=await run("UPDATE replies SET status=? WHERE id=? AND trip_id=? AND status='pending' AND EXISTS(SELECT 1 FROM trips WHERE id=? AND status='open')",b.action==='accept'?'accepted':'declined',b.replyId,trip.id,trip.id);need(r.meta.changes,'This reply is no longer pending.',409);return result({ok:true})}
   if(action==='escort'){
    need(owner,'Only the trip owner can request an escort.',403);need((E().ESCORT_EMAILS||'').trim()||await one("SELECT user_id FROM volunteers WHERE status='approved' LIMIT 1"),'Escorts are not connected yet. Contact your app organiser directly.',503);const count=await one('SELECT COUNT(*) AS n FROM replies WHERE trip_id=?',trip.id);need(canRequestEscort(trip,count.n,n),'An escort is available after 20 minutes with no replies.',409);
    const inserted=await run("INSERT INTO escorts (trip_id,created) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM replies WHERE trip_id=?) AND EXISTS(SELECT 1 FROM trips WHERE id=? AND status='open' AND created<=? AND departure>?) ON CONFLICT(trip_id) DO NOTHING",trip.id,n,trip.id,trip.id,n-ESCORT_WAIT,n);need(inserted.meta.changes,'An escort is already requested, a reply arrived, or the trip closed.',409);return result({ok:true,message:'Request added to the approved escort dashboard. No escort has accepted yet.'});
   }
   if(action==='escort-accept'){need(u!.escort&&!owner,'Only an approved escort can accept this request.',403);const r=await run("UPDATE escorts SET escort_id=?,status='accepted' WHERE trip_id=? AND status='pending' AND EXISTS(SELECT 1 FROM trips WHERE id=? AND status='open' AND departure>?)",u!.id,trip.id,trip.id,n);need(r.meta.changes,'This request is no longer available.',409);return result({ok:true})}
   if(action==='start'){need(owner,'Only the trip owner can start this walk.',403);const r=await run("UPDATE trips SET status='active' WHERE id=? AND status='open' AND (EXISTS(SELECT 1 FROM replies WHERE trip_id=? AND status='accepted') OR EXISTS(SELECT 1 FROM escorts WHERE trip_id=? AND status='accepted'))",trip.id,trip.id,trip.id);need(r.meta.changes,'Accept a walking partner or wait for an escort before starting.',409);return result({ok:true})}
  }
 }
 throw new HttpError(404,'Not found.');
}

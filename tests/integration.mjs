import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {createHmac,generateKeyPairSync,verify,createECDH,randomBytes,hkdfSync,createDecipheriv} from 'node:crypto';

// Exercise the real HTTP handlers and SQL with an isolated database and email sink.
const sql=new DatabaseSync(':memory:');
for(const name of readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+name,'utf8'));
const DB={
 prepare(query){
  return {bind(...values){return {
   async first(){return sql.prepare(query).get(...values)||null},
   async all(){return {results:sql.prepare(query).all(...values)}},
   async run(){const r=sql.prepare(query).run(...values);return {meta:{changes:Number(r.changes)}}}
  }}};
 },
 async batch(statements){sql.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}
};
const objects=new Map();
globalThis.__testEnv={DB,BUCKET:{async put(key,bytes,options){objects.set(key,{body:bytes,httpMetadata:options.httpMetadata})},async get(key){return objects.get(key)}},AUTH_SECRET:'test-only-secret-which-is-long-enough-not-for-production',RESIDENCE_INVITE_CODE:'test-residence-invite',RESEND_API_KEY:'test-key',EMAIL_FROM:'test@example.com',ESCORT_EMAILS:'escort@example.com'};
globalThis.__background=[];
mkdirSync('.sites-runtime/tests',{recursive:true});
for(const name of ['policy','panic','gmail','push','server']){let src=readFileSync('lib/'+name+'.ts','utf8').replace("import {env,waitUntil} from 'cloudflare:workers';","const env=globalThis.__testEnv; const waitUntil=p=>globalThis.__background.push(p);").replace("from './policy'","from './policy.mjs'").replace("from './panic'","from './panic.mjs'").replace("from './gmail'","from './gmail.mjs'").replace("from './push'","from './push.mjs'");writeFileSync('.sites-runtime/tests/'+name+'.mjs',ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText)}
const {handle}=await import(pathToFileURL(process.cwd()+'/.sites-runtime/tests/server.mjs'));
const mail=new Map(),panicMail=[],otherMail=[];globalThis.fetch=async(url,opts)=>{const payload=JSON.parse(opts.body);if(url==='https://api.resend.com/emails/batch'){panicMail.push(...payload);return new Response('{}',{status:200})}assert.equal(url,'https://api.resend.com/emails');if(payload.subject==='Your Argyle Together verification code')mail.set(payload.to[0],payload.text.match(/\b\d{6}\b/)[0]);else otherMail.push(payload);return new Response('{}',{status:200})};
async function call(path,body,cookie,origin='https://argyle.test'){const headers={Origin:origin};if(cookie)headers.Cookie=cookie;const opts={headers};if(body!==undefined){opts.method='POST';headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}const res=await handle(new Request('https://argyle.test/api/'+path,opts));const data=res.headers.get('content-type')?.includes('json')?await res.json():null;return {res,data,status:res.status}}
async function account(email){const sent=await call('auth/send',{email,invite:'test-residence-invite'});assert.equal(sent.status,200,JSON.stringify(sent.data));const code=mail.get(email);const verified=await call('auth/verify',{email,code});assert.equal(verified.status,200);const cookie=verified.res.headers.get('set-cookie').split(';')[0];assert.match(verified.res.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);return {email,id:verified.data.user.id,cookie,code}}
function complete(a){sql.prepare("UPDATE users SET name=?,phone='+27821234567',photo=?,complete=1 WHERE id=?").run(a.email.split('@')[0],'profiles/'+a.id,a.id)}

test('accounts, admission, sessions and one-time verification',async()=>{
 assert.equal((await call('trips')).status,401);
 assert.equal((await call('auth/send',{email:'no@example.com',invite:'wrong'})).status,403);
 const a=await account('resident@example.com');globalThis.owner=a;
 assert.equal((await call('trips',undefined,a.cookie)).status,403);
 assert.equal((await call('auth/verify',{email:a.email,code:a.code})).status,401);
 assert.equal((await call('profile',{name:'Resident',phone:'nonsense',photo:'x',locationEnabled:true,privacyAccepted:true,privacyVersion:'2026-10-11'},a.cookie)).status,400);
 assert.equal((await call('profile',{name:'Resident',phone:'+27821234567',photo:'invented',locationEnabled:true,privacyAccepted:true,privacyVersion:'2026-10-11'},a.cookie)).status,400);
 const form=new FormData();form.append('photo',new File([new Uint8Array([137,80,78,71,13,10,26,10])],'test.png',{type:'image/png'}));
 const uploaded=await handle(new Request('https://argyle.test/api/photo',{method:'POST',headers:{Origin:'https://argyle.test',Cookie:a.cookie},body:form}));assert.equal(uploaded.status,200);
 const photo=(await uploaded.json()).photo;
 // Multipart requests add overhead beyond the image bytes. Accept the exact
 // advertised 5 MB limit and still reject a file one byte over it.
 for(const size of [5*1024*1024,5*1024*1024+1]){
  const image=new Uint8Array(size);image.set([137,80,78,71,13,10,26,10]);
  const upload=new FormData();upload.append('photo',new File([image],'large.png',{type:'image/png'}));
  const request=new Request('https://argyle.test/api/photo',{method:'POST',headers:{Origin:'https://argyle.test',Cookie:a.cookie},body:upload});
  request.headers.set('Content-Length',String((await request.clone().arrayBuffer()).byteLength));
  const response=await handle(request);assert.equal(response.status,size===5*1024*1024?200:400);
 }
 assert.equal(objects.get(photo).body.byteLength,5*1024*1024);
 assert.equal((await call('profile',{name:'Resident',phone:'+27821234567',photo,locationEnabled:false},a.cookie)).status,400);
 assert.equal((await call('profile',{name:'Resident',phone:'+27821234567',photo,locationEnabled:true},a.cookie)).status,400);
 assert.equal((await call('profile',{name:'Resident',phone:'+27821234567',photo,locationEnabled:true,privacyAccepted:true,privacyVersion:'2026-10-11'},a.cookie)).status,200);
 assert.equal(sql.prepare('SELECT privacy_version FROM users WHERE id=?').get(a.id).privacy_version,'2026-10-11');
 assert.equal((await call('trips',{},a.cookie,'https://evil.test')).status,403);
});

test('privacy requests are private, available before profile completion, and never imply deletion',async()=>{
 function seed(email){const id=crypto.randomUUID(),raw=crypto.randomUUID();sql.prepare('INSERT INTO users(id,email,created) VALUES (?,?,?)').run(id,email,Date.now());const digest=createHmac('sha256',globalThis.__testEnv.AUTH_SECRET).update(raw).digest('hex');sql.prepare('INSERT INTO sessions(digest,user_id,expires) VALUES (?,?,?)').run(digest,id,Date.now()+60000);return {id,cookie:'argyle_session='+raw}}
 const a=seed('privacy-requester@example.com'),other=seed('privacy-other@example.com');
 assert.equal((await call('privacy-requests')).status,401);
 assert.equal((await call('privacy-requests',{kind:'deletion'},a.cookie,'https://evil.test')).status,403);
 assert.equal((await call('privacy-requests',{kind:'invalid'},a.cookie)).status,400);
 const saved=await call('privacy-requests',{kind:'deletion',details:'Please remove my unused account.'},a.cookie);assert.equal(saved.status,201);
 assert.equal((await call('privacy-requests',{kind:'deletion'},a.cookie)).status,409);
 assert.equal((await call('privacy-requests',undefined,a.cookie)).data.requests.length,1);
 assert.equal((await call('privacy-requests',undefined,other.cookie)).data.requests.length,0);
 assert.equal((await call('privacy-requests/'+saved.data.id+'/review',{},other.cookie)).status,403);
 const oldAdmin=globalThis.__testEnv.ADMIN_EMAIL;globalThis.__testEnv.ADMIN_EMAIL='privacy-other@example.com';
 assert.equal((await call('privacy-requests',undefined,other.cookie)).data.requests[0].email,'privacy-requester@example.com');
 assert.equal((await call('privacy-requests/'+saved.data.id+'/review',{},other.cookie)).status,200);
 assert.equal((await call('privacy-requests',undefined,a.cookie)).data.requests[0].status,'reviewed');
 assert.ok(sql.prepare('SELECT id FROM users WHERE id=?').get(a.id));
 globalThis.__testEnv.ADMIN_EMAIL=oldAdmin;
});

test('volunteer registration, organiser-only approval, retries and live role changes',async()=>{
 globalThis.__testEnv.RESEND_API_KEY='test-key';
 const applicant=await account('volunteer@example.com');complete(applicant);
 const profile={name:'Volunteer Resident',phone:'+27821234567',photo:'profiles/'+applicant.id,locationEnabled:true,privacyAccepted:true,privacyVersion:'2026-10-11',volunteer:true,volunteerReason:'Available after lectures'};
 const applied=await call('profile',profile,applicant.cookie);
 assert.equal(applied.status,200);assert.equal(applied.data.user.volunteerStatus,'pending');assert.equal(applied.data.user.escort,false);assert.equal(applied.data.emailAccepted,true);
 const notification=otherMail.at(-1);assert.equal(notification.to[0],'asandaqwabe465@gmail.com');assert.match(notification.text,/Available after lectures/);assert.match(notification.text,/\?view=volunteers/);
 const count=otherMail.length;await call('profile',profile,applicant.cookie);assert.equal(otherMail.length,count);
 assert.equal((await call('volunteers',undefined,applicant.cookie)).status,403);
 assert.equal((await call('volunteers/'+applicant.id+'/review',{status:'approved'},applicant.cookie)).status,403);
 const adminAddress='asandaqwabe465@gmail.com';
 assert.equal((await call('auth/send',{email:adminAddress})).status,200);
 const verified=await call('auth/verify',{email:adminAddress,code:mail.get(adminAddress)});
 assert.equal(verified.data.user.admin,true);const admin={id:verified.data.user.id,email:adminAddress,cookie:verified.res.headers.get('set-cookie').split(';')[0]};complete(admin);
 assert.equal((await call('volunteers',undefined,admin.cookie)).data.inviteCode,'test-residence-invite');
 assert.equal((await call('volunteers/'+applicant.id+'/review',undefined,admin.cookie)).status,404);
 assert.equal((await call('volunteers/'+applicant.id+'/review',{status:'approved'},admin.cookie,'https://evil.test')).status,403);
 assert.equal((await call('volunteers/'+applicant.id+'/review',{status:'approved'},admin.cookie)).status,200);
 assert.equal((await call('session',undefined,applicant.cookie)).data.user.escort,true);
 assert.equal((await call('volunteers/'+applicant.id+'/review',{status:'approved'},admin.cookie)).status,409);
 const owner=globalThis.owner;
 const id=(await call('trips',{destination:'WEC',origin:'Argyle',note:'',departure:Date.now()+3600000},owner.cookie)).data.id;
 sql.prepare('UPDATE trips SET created=? WHERE id=?').run(Date.now()-1200001,id);
 globalThis.__testEnv.ESCORT_EMAILS='';assert.equal((await call('trips/'+id+'/escort',{},owner.cookie)).status,200);
 assert.equal((await call('trips/'+id+'/escort-accept',{},applicant.cookie)).status,200);
 assert.equal((await call('volunteers/'+applicant.id+'/review',{status:'revoked'},admin.cookie)).status,200);
 assert.equal((await call('session',undefined,applicant.cookie)).data.user.escort,false);
 globalThis.__testEnv.ESCORT_EMAILS='escort@example.com';
 const second=await account('applicant2@example.com');complete(second);globalThis.__testEnv.RESEND_API_KEY='';
 const pending=await call('volunteers/apply',{reason:'Weekends'},second.cookie);assert.equal(pending.status,200);assert.equal(pending.data.emailAccepted,false);assert.match(pending.data.warning,/saved/);
 assert.equal((await call('session',undefined,second.cookie)).data.user.volunteerStatus,'pending');
 globalThis.__testEnv.RESEND_API_KEY='test-key';assert.equal((await call('volunteers/retry',{},second.cookie)).data.emailAccepted,true);
 assert.equal((await call('volunteers/'+second.id+'/review',{status:'declined'},admin.cookie)).status,200);
 assert.equal((await call('volunteers/apply',{reason:'Try again',status:'approved'},second.cookie)).data.user.volunteerStatus,'declined');
 assert.equal((await call('session',undefined,second.cookie)).data.user.escort,false);
});
test('trip replies, privacy, timer, escort roles and completion',async()=>{
 const a=globalThis.owner,b=await account('partner@example.com'),stranger=await account('stranger@example.com'),escort=await account('escort@example.com');for(const x of [b,stranger,escort])complete(x);
 const created=await call('trips',{destination:'WEC',origin:'Argyle House',note:'Library',departure:Date.now()+3600000},a.cookie);assert.equal(created.status,201);const id=created.data.id;
 assert.equal((await call('trips/'+id+'/escort',{},a.cookie)).status,409);
 assert.equal((await call('trips/'+id+'/reply',{meeting:'Reception at 17:00'},b.cookie)).status,200);
 assert.equal((await call('trips/'+id+'/reply',{meeting:'Reception'},b.cookie)).status,409);
 const ownerView=await call('trips/'+id,undefined,a.cookie);const replyId=ownerView.data.replies[0].id;
 assert.equal((await call('trips/'+id,undefined,stranger.cookie)).data.replies.length,0);
 assert.equal((await call('trips/'+id+'/reply-action',{replyId,action:'accept'},stranger.cookie)).status,403);
 assert.equal((await call('trips/'+id+'/start',{},a.cookie)).status,409);
 assert.equal((await call('trips/'+id+'/reply-action',{replyId,action:'accept'},a.cookie)).status,200);
 assert.equal((await call('trips/'+id+'/start',{},a.cookie)).status,200);
 const point={tripId:id,lat:-26.19,lng:28.03,accuracy:10,at:Date.now()};
 assert.equal((await call('location',point,stranger.cookie)).status,403);
 assert.equal((await call('location',point,b.cookie)).status,200);
 assert.equal((await call('trips/'+id,undefined,a.cookie)).data.locations.length,1);
 assert.equal((await call('trips/'+id,undefined,stranger.cookie)).data.locations.length,0);
 assert.equal((await call('trips/'+id,undefined,escort.cookie)).data.locations.length,0);
 sql.prepare('UPDATE locations SET updated=?').run(Date.now()-120001);
 assert.equal((await call('trips/'+id,undefined,a.cookie)).data.locations.length,0);
 assert.equal((await call('location',{...point,at:Date.now()-120001},b.cookie)).status,400);
 assert.equal((await call('trips/'+id+'/finish',{},stranger.cookie)).status,403);
 assert.equal((await call('trips/'+id+'/finish',{},a.cookie)).status,200);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM locations').get().n,0);
 assert.equal((await call('location',{...point,at:Date.now()},b.cookie)).status,403);
 const t2=(await call('trips',{destination:'WEC',origin:'Argyle',note:'',departure:Date.now()+3600000},a.cookie)).data.id;
 sql.prepare('UPDATE trips SET created=? WHERE id=?').run(Date.now()-1200001,t2);
 assert.equal((await call('trips/'+t2+'/escort',{},a.cookie)).status,200);
 assert.equal((await call('trips/'+t2+'/escort-accept',{},b.cookie)).status,403);
 assert.equal((await call('trips/'+t2+'/escort-accept',{},escort.cookie)).status,200);
 const escortView=(await call('trips/'+t2,undefined,escort.cookie)).data;assert.equal(escortView.isParticipant,true);assert.equal(escortView.canChat,true);assert.equal(escortView.replies.length,0);
 assert.equal((await call('trips',undefined,escort.cookie)).data.trips.find(t=>t.id===t2).joined,1);
 const assigned=(await call('trips/'+t2,undefined,a.cookie)).data.escort;assert.equal(assigned.escort_id,escort.id);assert.ok(assigned.name);assert.ok(assigned.phone);
 assert.equal((await call('trips/'+t2,undefined,stranger.cookie)).data.escort.phone,null);
 assert.equal((await call('trips/'+t2+'/reply',{meeting:'Reception'},escort.cookie)).status,409);
 assert.equal((await call('trips/'+t2+'/messages',{id:crypto.randomUUID(),body:'I have joined as your escort.'},escort.cookie)).status,201);
 assert.equal((await call('trips/'+t2+'/escort-accept',{},escort.cookie)).status,409);
 assert.equal((await call('trips/'+t2+'/start',{},a.cookie)).status,200);
 assert.equal((await call('location',{...point,tripId:t2,at:Date.now()},escort.cookie)).status,200);
 assert.equal((await call('auth/logout',{},escort.cookie)).status,200);
 assert.equal((await call('session',undefined,escort.cookie)).data.user,null);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM locations').get().n,0);
});
test('panic broadcasts to every complete account, includes contact and location, and only sender resolves',async()=>{
 const a=globalThis.owner;const alert=await call('alerts',{location:{lat:-26.19,lng:28.03,accuracy:8,at:Date.now()}},a.cookie);assert.equal(alert.status,201);const id=alert.data.alert.id;
 assert.equal(panicMail.length,sql.prepare('SELECT COUNT(*) n FROM users WHERE complete=1').get().n);
 assert.ok(panicMail.every(m=>m.to.length===1&&m.text.includes('+27821234567')&&m.text.includes('-26.19,28.03')));
 assert.equal((await call('alerts')).status,401);
 const other=await account('panic-observer@example.com');complete(other);
 assert.equal((await call('alerts',undefined,other.cookie)).data.alerts[0].user_id,a.id);
 assert.equal((await call('alerts/'+encodeURIComponent(id)+'/resolve',{},other.cookie)).status,403);
 assert.equal((await call('alerts/'+encodeURIComponent(id)+'/location',{lat:28,lng:27,accuracy:10,at:Date.now()},other.cookie)).status,403);
 assert.equal((await call('alerts',{},a.cookie)).data.existing,true);
 for(let repeated=0;repeated<5;repeated++)assert.equal((await call('alerts',{},a.cookie)).data.existing,true);
 assert.equal((await call('alerts/'+encodeURIComponent(id)+'/resolve',{},a.cookie)).status,200);
 assert.equal((await call('alerts',undefined,other.cookie)).data.alerts.length,0);
 assert.equal(sql.prepare('SELECT lat FROM alerts WHERE id=?').get(id).lat,null);
 globalThis.__testEnv.RESEND_API_KEY='';
 const noGPS=await call('alerts',{location:null},a.cookie);
 assert.equal(noGPS.status,201);
 assert.notEqual(noGPS.data.alert.id,id);
 assert.equal(noGPS.data.alert.lat,null);
 assert.equal(noGPS.data.alert.email_sent,0);
 assert.equal(noGPS.data.emailStatus,'incomplete');
});

test('temporary Gmail mode sends signed codes but no volunteer or distress emails',async()=>{
 const e=globalThis.__testEnv,originalFetch=globalThis.fetch;
 Object.assign(e,{EMAIL_PROVIDER:'gmail',GMAIL_RELAY_URL:'https://script.google.com/macros/s/test-relay/exec',GMAIL_RELAY_SECRET:'test-relay-secret-that-is-at-least-32-characters'});
 let sends=0;
 globalThis.fetch=async(url,options)=>{assert.equal(url,e.GMAIL_RELAY_URL);const request=JSON.parse(options.body);assert.equal(request.signature,createHmac('sha256',e.GMAIL_RELAY_SECRET).update(request.payload).digest('hex'));const payload=JSON.parse(request.payload);assert.equal(payload.type,'verification');mail.set(payload.to,payload.code);sends++;return Response.json({ok:true})};
 try{
  assert.equal((await call('session')).data.authReady,true);
  const applicant=await account('gmailpilot@example.com');complete(applicant);assert.equal(sends,1);
  const application=await call('volunteers/apply',{reason:'Temporary pilot'},applicant.cookie);assert.equal(application.data.emailStatus,'disabled');assert.equal(application.data.user.volunteerStatus,'pending');assert.equal(sends,1);
  const panic=await call('alerts',{location:null},applicant.cookie);assert.equal(panic.status,201);assert.equal(panic.data.emailStatus,'disabled');assert.equal(panic.data.alert.email_total,0);assert.equal(sends,1);
  assert.equal((await call('alerts',{},applicant.cookie)).data.emailStatus,'disabled');assert.equal(sends,1);
  assert.equal((await call('alerts',undefined,globalThis.owner.cookie)).data.emailNotifications,false);
  globalThis.fetch=async()=>Response.json({error:'quota'});
  const exhausted=await call('auth/send',{email:'quota@example.com',invite:'test-residence-invite'});assert.equal(exhausted.status,429);assert.match(exhausted.data.error,/sending limit/);assert.equal(sql.prepare('SELECT email FROM challenges WHERE email=?').get('quota@example.com'),undefined);
  e.GMAIL_RELAY_URL='https://attacker.example/exec';assert.equal((await call('session')).data.authReady,false);
 }finally{globalThis.fetch=originalFetch;delete e.EMAIL_PROVIDER;delete e.GMAIL_RELAY_URL;delete e.GMAIL_RELAY_SECRET}
});


test('immediate reports, private flags, author corrections and organiser moderation',async()=>{
 globalThis.__testEnv.RESEND_API_KEY='test-key';
 const owner=globalThis.owner,reviewer=await account('incident-reviewer@example.com');complete(reviewer);
 const body={category:'Suspicious behaviour',place:'Outside the main entrance',occurred:Date.now()-60000,description:'A vehicle repeatedly followed us along the road as we walked to the entrance.',vehicle:'White hatchback',factual:true};
 assert.equal((await call('incidents')).status,401);
 assert.equal((await call('incidents',{...body,factual:false},owner.cookie)).status,400);
 assert.equal((await call('incidents',{...body,occurred:Date.now()+3600000},owner.cookie)).status,400);
 const created=await call('incidents',{...body,status:'pending'},owner.cookie);assert.equal(created.status,201);assert.equal(created.data.status,'published');const id=created.data.id;
 const other=(await call('incidents',undefined,reviewer.cookie)).data;assert.equal(other.reports.length,1);assert.equal(other.review.length,0);assert.equal(other.flags.length,0);assert.equal(other.mine.length,0);
 for(const field of ['reporter_id','reporter_name','email','phone','reviewer'])assert.equal(field in other.reports[0],false);
 assert.equal((await call('incidents/'+id+'/review',{status:'dismissed'},owner.cookie)).status,403);
 assert.equal((await call('incidents/'+id+'/edit',body,reviewer.cookie)).status,403);
 assert.equal((await call('incidents/'+id+'/edit',body,owner.cookie,'https://evil.test')).status,403);
 assert.equal((await call('incidents/'+id+'/flag',{reason:'Misleading or inaccurate'},owner.cookie)).status,403);
 assert.equal((await call('incidents/'+id+'/flag',{reason:'Misleading or inaccurate',details:'Please check the vehicle description.'},reviewer.cookie)).status,200);
 assert.equal((await call('incidents/'+id+'/flag',{reason:'Other'},reviewer.cookie)).status,409);
 assert.equal((await call('incidents',undefined,owner.cookie)).data.flags.length,0);
 assert.equal((await call('incidents',undefined,reviewer.cookie)).data.reports.length,1);
 assert.equal((await call('incidents/'+id+'/clear-flags',{},owner.cookie)).status,403);
 const edited={...body,description:'Correction: the car turned away before we reached the entrance.',vehicle:'Silver hatchback'};
 assert.equal((await call('incidents/'+id+'/edit',edited,owner.cookie)).status,200);
 const updated=(await call('incidents',undefined,reviewer.cookie)).data.reports[0];assert.equal(updated.description,edited.description);assert.ok(updated.updated);
 globalThis.__testEnv.ADMIN_EMAIL=reviewer.email;
 try{
  const moderation=(await call('incidents',undefined,reviewer.cookie)).data;
  assert.equal(moderation.review[0].flag_count,1);assert.equal(moderation.review[0].reporter_name,'Resident');
  assert.equal(JSON.parse(moderation.flags[0].snapshot).description,body.description);
  assert.equal((await call('incidents/'+id+'/review',undefined,reviewer.cookie)).status,404);
  assert.equal((await call('incidents/'+id+'/review',{status:'dismissed'},reviewer.cookie,'https://evil.test')).status,403);
  assert.equal((await call('incidents/'+id+'/review',{status:'dismissed'},reviewer.cookie)).status,200);
  assert.equal((await call('incidents',undefined,owner.cookie)).data.reports.length,0);
  assert.equal((await call('incidents/'+id+'/edit',{...edited,status:'published'},owner.cookie)).status,403);
  assert.equal((await call('incidents/'+id+'/flag',{reason:'Other'},owner.cookie)).status,403);
  assert.equal((await call('incidents/'+id+'/clear-flags',{},reviewer.cookie)).status,200);
  assert.equal((await call('incidents',undefined,reviewer.cookie)).data.flags.length,0);
  const second=(await call('incidents',body,owner.cookie)).data.id;
  assert.equal((await call('incidents/'+second+'/withdraw',{},reviewer.cookie)).status,403);
  assert.equal((await call('incidents/'+second+'/withdraw',{},owner.cookie)).status,200);
  assert.equal((await call('incidents/'+second+'/edit',body,owner.cookie)).status,403);
  const third=(await call('incidents',body,owner.cookie)).data.id;
  assert.equal((await call('incidents/'+third+'/review',{status:'resolved'},reviewer.cookie)).status,200);
  assert.equal((await call('incidents',undefined,owner.cookie)).data.reports.length,0);
  // Legacy reports retain the privacy promised when they were submitted.
  const legacy=(await call('incidents',body,owner.cookie)).data.id;sql.prepare("UPDATE incidents SET status='pending' WHERE id=?").run(legacy);
  assert.equal((await call('incidents',undefined,owner.cookie)).data.reports.length,0);
  assert.equal((await call('incidents/'+legacy+'/review',{status:'published'},reviewer.cookie)).status,200);
 }finally{delete globalThis.__testEnv.ADMIN_EMAIL}
});


test('trip conversations, photo access and private companion history',async()=>{
 function fixture(label){
  const id=crypto.randomUUID(),raw=crypto.randomUUID(),email=label+'@trip-test.invalid';
  sql.prepare("INSERT INTO users (id,email,name,phone,photo,complete,created) VALUES (?,?,?,?,?,1,?)").run(id,email,label,'+27821234567','profiles/'+id,Date.now());
  sql.prepare('INSERT INTO sessions (digest,user_id,expires) VALUES (?,?,?)').run(createHmac('sha256',globalThis.__testEnv.AUTH_SECRET).update(raw).digest('hex'),id,Date.now()+3600000);
  objects.set('profiles/'+id,{body:new Uint8Array([137,80,78,71]),httpMetadata:{contentType:'image/png'}});
  return {id,cookie:'argyle_session='+raw};
 }
 const a=fixture('Trip owner'),b=fixture('Accepted partner'),c=fixture('Declined applicant'),outsider=fixture('Unrelated resident');
 const made=await call('trips',{destination:'Library',origin:'Argyle reception',departure:Date.now()+3600000,note:'Study together'},a.cookie);assert.equal(made.status,201);const id=made.data.id,route='trips/'+id;
 assert.equal((await call('photo/'+a.id)).status,401);assert.equal((await call('photo/'+a.id,undefined,b.cookie)).status,200);
 assert.equal((await call(route+'/messages')).status,401);
 assert.equal((await call(route+'/messages',undefined,b.cookie)).status,403);
 assert.equal((await call(route+'/messages',{id:crypto.randomUUID(),body:'Hello'},b.cookie)).status,403);
 await call(route+'/reply',{meeting:'Reception at 17:00'},b.cookie);await call(route+'/reply',{meeting:'Front gate'},c.cookie);
 assert.equal((await call(route,undefined,b.cookie)).data.canChat,true);
 const message={id:crypto.randomUUID(),body:'Can we meet inside reception before leaving?'};
 assert.equal((await call(route+'/messages',message,b.cookie,'https://evil.test')).status,403);
 const sent=await call(route+'/messages',message,b.cookie);assert.equal(sent.status,201);
 assert.equal((await call(route+'/messages',message,b.cookie)).status,200);
 assert.equal(sql.prepare('SELECT count(*) AS n FROM trip_messages WHERE id=?').get(message.id).n,1);
 assert.equal((await call(route+'/messages',{...message,body:'Different message'},a.cookie)).status,409);
 assert.equal((await call(route+'/messages',{id:crypto.randomUUID(),body:''},a.cookie)).status,400);
 assert.equal((await call(route+'/messages',{id:crypto.randomUUID(),body:'x'.repeat(1501)},a.cookie)).status,400);
 assert.equal((await call(route+'/messages',undefined,outsider.cookie)).status,403);
 assert.equal((await call(route,undefined,outsider.cookie)).data.canChat,false);
 const pending=(await call(route,undefined,a.cookie)).data.replies;
 await call(route+'/reply-action',{replyId:pending.find(r=>r.user_id===b.id).id,action:'accept'},a.cookie);
 await call(route+'/reply-action',{replyId:pending.find(r=>r.user_id===c.id).id,action:'decline'},a.cookie);
 assert.equal((await call(route+'/messages',undefined,c.cookie)).status,403);
 assert.equal((await call(route+'/messages',{id:crypto.randomUUID(),body:'No longer allowed'},c.cookie)).status,403);
 for(let i=0;i<61;i++)sql.prepare('INSERT INTO trip_messages (id,trip_id,user_id,body,created) VALUES (?,?,?,?,?)').run(crypto.randomUUID(),id,a.id,'Message '+i,Date.now());
 const recent=(await call(route+'/messages',undefined,b.cookie)).data;assert.equal(recent.messages.length,50);assert.equal(recent.hasMore,true);
 const earlier=(await call(route+'/messages?before='+recent.messages[0].seq,undefined,b.cookie)).data;assert.equal(earlier.messages.length,12);assert.equal(earlier.hasMore,false);
 assert.equal((await call(route+'/messages?after='+recent.messages.at(-1).seq,undefined,b.cookie)).data.messages.length,0);
 assert.equal((await call('history',undefined,a.cookie)).data.trips.length,0);
 assert.equal((await call(route+'/start',{},a.cookie)).status,200);assert.equal((await call(route+'/finish',{},a.cookie)).status,200);
 const past=(await call('history',undefined,a.cookie)).data.trips[0];assert.equal(past.status,'complete');assert.deepEqual(past.companions.map(p=>p.id),[b.id]);assert.equal('lat'in past,false);
 assert.deepEqual((await call('history',undefined,b.cookie)).data.trips[0].companions.map(p=>p.id),[a.id]);
 assert.deepEqual((await call('history',undefined,c.cookie)).data.trips[0].companions,[]);
 assert.equal((await call('history',undefined,outsider.cookie)).data.trips.length,0);
 assert.equal((await call(route,undefined,outsider.cookie)).status,403);
 assert.equal((await call(route+'/messages',undefined,b.cookie)).data.readOnly,true);
 assert.equal((await call(route+'/messages',{id:crypto.randomUUID(),body:'Too late'},b.cookie)).status,409);
 const cancelled=(await call('trips',{destination:'WEC',origin:'Reception',departure:Date.now()+7200000},a.cookie)).data.id;
 await call('trips/'+cancelled+'/finish',{},a.cookie);assert.equal((await call('history',undefined,a.cookie)).data.trips.find(t=>t.id===cancelled).status,'cancelled');
 // Closed escort records still identify the assigned companion in history.
 sql.prepare("INSERT INTO escorts (trip_id,escort_id,status,created) VALUES (?,?,'closed',?)").run(cancelled,b.id,Date.now());
 assert.ok((await call('history',undefined,b.cookie)).data.trips.some(t=>t.id===cancelled&&t.myEscort));
 assert.equal((await call('trips/'+cancelled+'/messages',undefined,b.cookie)).status,200);
 assert.equal((await call('history?offset=-1',undefined,a.cookie)).status,400);
});

test('phone notifications: encrypted payloads, consent, private tests, retries, expiry and logout',async()=>{
 await Promise.all(globalThis.__background.splice(0));
 const e=globalThis.__testEnv,a=globalThis.owner,originalFetch=globalThis.fetch;
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=privateKey.export({format:'jwk'});
 e.VAPID_PRIVATE_KEY=JSON.stringify(jwk);e.VAPID_PUBLIC_KEY=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url');e.VAPID_SUBJECT='mailto:test@example.com';e.EMAIL_PROVIDER='gmail';
 const push=await import(pathToFileURL(process.cwd()+'/.sites-runtime/tests/push.mjs'));
 const browserKey=createECDH('prime256v1');browserKey.generateKeys();const auth=randomBytes(16),keys={p256dh:browserKey.getPublicKey().toString('base64url'),auth:auth.toString('base64url')};
 const endpoint='https://fcm.googleapis.com/fcm/send/device-one',requests=[],messages=[];let responseStatus=201;
 const subscription={endpoint,keys,distress:true,trips:true};
 globalThis.fetch=async(url,opts)=>{
  requests.push(url);assert.ok(push.validEndpoint(url));opts.headers=Object.fromEntries(new Headers(opts.headers));assert.ok(opts.body instanceof Uint8Array);assert.equal(opts.headers['content-encoding'],'aes128gcm');
  const encrypted=Buffer.from(opts.body),salt=encrypted.subarray(0,16),keyLength=encrypted[20],serverKey=encrypted.subarray(21,21+keyLength),ciphertext=encrypted.subarray(21+keyLength);
  const ikm=hkdfSync('sha256',browserKey.computeSecret(serverKey),auth,Buffer.concat([Buffer.from('WebPush: info\0'),browserKey.getPublicKey(),serverKey]),32);
  const cek=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16),nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
  const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(ciphertext.subarray(-16));const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);assert.equal(plain.at(-1),2);const message=JSON.parse(plain.subarray(0,-1));messages.push(message);assert.ok(['test','distress','trip'].includes(message.kind));assert.equal('phone'in message,false);assert.equal('lat'in message,false);assert.equal(opts.redirect,'manual');assert.equal(String(opts.headers.ttl),'60');
  const token=opts.headers.authorization.match(/^vapid t=(.*), k=/)[1],parts=token.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  assert.equal(claims.aud,new URL(url).origin);assert.equal(claims.sub,'mailto:test@example.com');assert.ok(claims.exp>Date.now()/1000&&claims.exp<Date.now()/1000+86400);
  assert.ok(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')));
  return new Response(null,{status:responseStatus});
 };
 try{
  assert.equal((await call('push/config')).status,401);
  assert.equal((await call('push/config',undefined,a.cookie)).data.ready,true);
  for(const bad of ['http://fcm.googleapis.com/a','https://127.0.0.1/a','https://fcm.googleapis.com.evil.test/a','https://user@fcm.googleapis.com/a','https://fcm.googleapis.com:444/a','https://evil.test/a'])assert.equal((await call('push/subscribe',{endpoint:bad},a.cookie)).status,400);
  assert.equal(requests.length,0);
  assert.equal((await call('push/subscribe',subscription,a.cookie,'https://evil.test')).status,403);
  assert.equal((await call('push/subscribe',subscription,a.cookie)).status,200);
  assert.equal((await call('push/status',{endpoint},a.cookie)).data.enabled,true);
  assert.equal((await call('push/test',{endpoint:endpoint+'other'},a.cookie)).status,403);
  assert.equal((await call('push/test',{endpoint},a.cookie)).status,200);assert.equal(requests.length,1);assert.equal(messages.at(-1).kind,'test');
  assert.equal((await call('push/unsubscribe',{endpoint},a.cookie)).status,200);
  assert.equal((await call('push/status',{endpoint},a.cookie)).data.enabled,false);
  await call('push/subscribe',subscription,a.cookie);
  // A genuine API alert queues push even when Gmail distress emails are paused.
  sql.exec("UPDATE alerts SET status='resolved'; DELETE FROM limits WHERE key LIKE 'panic:%'");
  const posted=await call('alerts',{},a.cookie);assert.equal(posted.status,201);assert.equal(posted.data.pushStatus,'queued');
  await Promise.all(globalThis.__background.splice(0));
  assert.equal(requests.length,2);assert.equal(sql.prepare("SELECT status FROM push_deliveries WHERE alert_id=?").get(posted.data.alert.id).status,'accepted');
  await push.enqueuePush(e);await Promise.all([push.drainPush(e),push.drainPush(e)]);assert.equal(requests.length,2);
  // Temporary push failures stay in the durable queue, without retry storms.
  sql.prepare("UPDATE push_deliveries SET status='pending',attempts=0,next_attempt=0").run();responseStatus=503;
  await Promise.all([push.drainPush(e),push.drainPush(e)]);assert.equal(requests.length,3);
  assert.equal(sql.prepare('SELECT attempts FROM push_deliveries').get().attempts,1);
  responseStatus=201;sql.exec('UPDATE push_deliveries SET next_attempt=0');await push.drainPush(e);assert.equal(requests.length,4);
  // Closed alerts are not delivered; gone endpoints are removed.
  sql.exec("UPDATE push_deliveries SET status='pending',attempts=0,next_attempt=0; UPDATE alerts SET status='resolved'");await push.drainPush(e);assert.equal(requests.length,4);
  assert.equal(sql.prepare('SELECT status FROM push_deliveries').get().status,'expired');
  assert.equal((await call('push/test',{endpoint},a.cookie)).status,429);sql.exec("UPDATE limits SET expires=0 WHERE key LIKE 'push-test-cooldown:%'");responseStatus=410;assert.equal((await call('push/test',{endpoint},a.cookie)).status,503);assert.equal((await call('push/status',{endpoint},a.cookie)).data.enabled,false);
  await call('push/subscribe',subscription,a.cookie);
  // Trip notifications exclude the author and respect each device's choices.
  responseStatus=201;const other=sql.prepare('SELECT id FROM users WHERE id!=? AND complete=1 LIMIT 1').get(a.id).id;
  const otherEndpoint=endpoint+'-other',otherId=await push.subscriptionId(otherEndpoint);
  sql.prepare('INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,distress,trips,created) VALUES (?,?,?,?,?,0,1,?)').run(otherId,other,otherEndpoint,keys.p256dh,keys.auth,Date.now()-10);
  const before=requests.length,trip=await call('trips',{destination:'Library',origin:'Argyle House',departure:Date.now()+3600000},a.cookie);assert.equal(trip.status,201);
  await Promise.all(globalThis.__background.splice(0));assert.equal(requests.length,before+1);assert.equal(requests.at(-1),otherEndpoint);assert.equal(messages.at(-1).kind,'trip');assert.equal(messages.at(-1).id,trip.data.id);
  sql.prepare('UPDATE push_subscriptions SET trips=0 WHERE id=?').run(otherId);
  await call('trips',{destination:'WEC',origin:'Argyle House',departure:Date.now()+3600000},a.cookie);await Promise.all(globalThis.__background.splice(0));assert.equal(requests.length,before+1);
  assert.equal((await call('auth/logout',{},a.cookie)).status,200);assert.equal(sql.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id=?').get(a.id).n,0);
 }finally{globalThis.fetch=originalFetch;delete e.VAPID_PRIVATE_KEY;delete e.VAPID_PUBLIC_KEY;delete e.VAPID_SUBJECT;delete e.EMAIL_PROVIDER}
});

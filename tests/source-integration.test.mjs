import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

// Keep the export integration unattached to the application. These tests apply
// the reviewed patch to an isolated copy of the real handler, never lib/server.ts.
const root=process.cwd();
const runtime=path.join(root,'.sites-runtime/source-integration-test');
mkdirSync(path.join(runtime,'lib'),{recursive:true});
mkdirSync(path.join(runtime,'migration'),{recursive:true});

function applyPatch(source,patch){
 const original=source.replaceAll('\r\n','\n').split('\n');
 const lines=patch.replaceAll('\r\n','\n').split('\n');
 const output=[];
 let offset=0;
 for(let i=0;i<lines.length;i++){
  const hunk=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
  if(!hunk)continue;
  const start=Number(hunk[1])-1;
  assert.ok(start>=offset,'Patch hunks must be ordered');
  output.push(...original.slice(offset,start));
  offset=start;
  let removed=0,added=0;
  while(i+1<lines.length&&!lines[i+1].startsWith('@@ ')){
   const line=lines[i+1];
   if(![' ','+','-','\\'].includes(line[0]))break;
   i++;
   if(line[0]==='\\')continue;
   if(line[0]===' '||line[0]==='-'){
    assert.equal(original[offset],line.slice(1),'Patch context must match current source');
    offset++;removed++;
   }
   if(line[0]===' '||line[0]==='+'){output.push(line.slice(1));added++}
  }
  assert.equal(removed,Number(hunk[2]??1));
  assert.equal(added,Number(hunk[4]??1));
 }
 assert.ok(offset>0,'The integration patch must contain a source hunk');
 output.push(...original.slice(offset));
 return output.join('\n');
}

function compile(source,target){
 const rewritten=source
  .replace("import {env,waitUntil} from 'cloudflare:workers';","const env=globalThis.__sourceIntegrationEnv; const waitUntil=p=>{globalThis.__sourceIntegrationActivity.waitUntil++;throw new Error('Unexpected background work');};")
  .replace(/from (['"])(\.\/policy|\.\/panic|\.\/gmail|\.\/push|\.\.\/migration\/source-export)\1/g,(_,quote,name)=>'from '+quote+name+'.mjs'+quote);
 writeFileSync(target,ts.transpileModule(rewritten,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
}

const source=readFileSync('lib/server.ts','utf8');
const patched=applyPatch(source,readFileSync('migration/source-integration.patch','utf8'));
assert.ok(!source.includes('migrationGate'),'The production handler must remain unattached');
for(const name of ['policy','panic','gmail','push'])compile(readFileSync('lib/'+name+'.ts','utf8'),path.join(runtime,'lib',name+'.mjs'));
compile(readFileSync('migration/source-export.ts','utf8'),path.join(runtime,'migration/source-export.mjs'));
compile(patched,path.join(runtime,'lib/server.mjs'));

const sql=new DatabaseSync(':memory:');
for(const name of readdirSync('drizzle').filter(name=>name.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+name,'utf8'));
const authSecret='test-only-auth-secret-never-a-real-production-credential';
const exportSecret='test-only-export-secret-never-a-real-production-credential';
const sessionTokens={owner:'test-owner-session',resident:'test-resident-session'};
for(const [id,email] of [['owner','owner@example.test'],['resident','resident@example.test']]){
 sql.prepare('INSERT INTO users(id,email,name,complete,created) VALUES(?,?,?,1,?)').run(id,email,id,Date.now());
 const digest=createHmac('sha256',authSecret).update(sessionTokens[id]).digest('hex');
 sql.prepare('INSERT INTO sessions(digest,user_id,expires) VALUES(?,?,?)').run(digest,id,Date.now()+3600000);
}

let activity;
const isReadQuery=query=>/^\s*SELECT\b/i.test(query)||/^PRAGMA table_info\("[a-z_]+"\)$/.test(query);
function resetActivity(){
 activity={queries:[],dbWrites:0,r2Reads:0,r2Writes:0,fetch:0,waitUntil:0};
 globalThis.__sourceIntegrationActivity=activity;
}
function rejectWrite(){activity.dbWrites++;throw new Error('Unexpected database write')}
const DB={
 prepare(query){
  activity.queries.push(query);
  if(!isReadQuery(query))return rejectWrite();
  const statement=sql.prepare(query);
  function bound(values=[]){return {
   bind(...next){return bound(next)},
   async first(column){const row=statement.get(...values)||null;return column&&row?row[column]:row},
   async all(){return {success:true,results:statement.all(...values),meta:{}}},
   async raw(){return statement.all(...values).map(row=>Object.values(row))},
   async run(){return rejectWrite()},
  }}
  return bound();
 },
 async batch(statements){return Promise.all(statements.map(statement=>statement.all()))},
 async exec(){return rejectWrite()},
};
const env={DB,BUCKET:{
 async get(){activity.r2Reads++;throw new Error('Unexpected R2 read')},
 async head(){activity.r2Reads++;throw new Error('Unexpected R2 read')},
 async list(){activity.r2Reads++;throw new Error('Unexpected R2 read')},
 async put(){activity.r2Writes++;throw new Error('Unexpected R2 write')},
 async delete(){activity.r2Writes++;throw new Error('Unexpected R2 write')},
}};
globalThis.__sourceIntegrationEnv=env;
globalThis.fetch=async()=>{activity.fetch++;throw new Error('Unexpected outbound request')};
resetActivity();
const {handle}=await import(pathToFileURL(path.join(runtime,'lib/server.mjs')));

function configure(overrides={}){
 for(const key of Object.keys(env))if(!['DB','BUCKET'].includes(key))delete env[key];
 Object.assign(env,{
  AUTH_SECRET:authSecret,
  ADMIN_EMAIL:'owner@example.test',
  MIGRATION_READ_ONLY:'true',
  MIGRATION_EXPORT_ENABLED:'true',
  MIGRATION_EXPORT_SECRET:exportSecret,
  MIGRATION_READ_ONLY_SINCE:new Date(Date.now()-180000).toISOString(),
  MIGRATION_EXPORT_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),
 },overrides);
 resetActivity();
}

function request(route,{method='GET',owner='owner',authorization='Bearer '+exportSecret,origin,body}={}){
 const headers={};
 if(owner)headers.Cookie='argyle_session='+sessionTokens[owner];
 if(authorization!==undefined&&authorization!==null)headers.Authorization=authorization;
 if(origin!==undefined)headers.Origin=origin;
 if(body!==undefined)headers['Content-Type']='application/json';
 return new Request('https://argyle.test'+route,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
function noEffects({allowQueries=false}={}){
 if(!allowQueries)assert.deepEqual(activity.queries,[]);
 assert.equal(activity.dbWrites,0);
 assert.equal(activity.r2Reads,0);
 assert.equal(activity.r2Writes,0);
 assert.equal(activity.fetch,0);
 assert.equal(activity.waitUntil,0);
}

test('the source integration patch applies only to its isolated handler copy',()=>{
 assert.equal(readFileSync('lib/server.ts','utf8'),source);
 assert.match(patched,/migrationGate\(req,E\(\),async\(\)=>/);
 assert.match(patched,/!e\.ADMIN_EMAIL\|\|!cleanEmail\(e\.ADMIN_EMAIL\)/);
});

test('maintenance blocks ordinary API methods before any query, storage, egress or background task',async()=>{
 const routes=[
  '/api','/api/session','/api/auth/send','/api/auth/verify','/api/auth/logout',
  '/api/profile','/api/photo','/api/photo/owner','/api/trips','/api/trips/fixture',
  '/api/trips/fixture/messages','/api/trips/fixture/finish','/api/trips/fixture/reply',
  '/api/trips/fixture/reply-action','/api/trips/fixture/escort','/api/trips/fixture/escort-accept',
  '/api/trips/fixture/start','/api/alerts','/api/alerts/fixture/resolve',
  '/api/alerts/fixture/location','/api/location','/api/location/stop','/api/history',
  '/api/incidents','/api/incidents/fixture/edit','/api/incidents/fixture/flag',
  '/api/incidents/fixture/clear-flags','/api/incidents/fixture/withdraw','/api/incidents/fixture/review',
  '/api/volunteers','/api/volunteers/apply','/api/volunteers/retry','/api/volunteers/fixture/review',
  '/api/privacy-requests','/api/privacy-requests/fixture/review',
  '/api/push/config','/api/push/status','/api/push/subscribe','/api/push/unsubscribe','/api/push/test',
 ];
 for(const method of ['GET','POST','HEAD'])for(const owner of ['owner',null])for(const route of routes){
  configure();
  const response=await handle(request(route,{method,owner,origin:'https://argyle.test',...(method==='POST'?{body:{}}:{})}));
  assert.equal(response.status,503,method+' '+route);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.ok(response.headers.has('retry-after'));
  noEffects();
 }
});

test('expired or disabled export never reopens ordinary API writes',async()=>{
 for(const overrides of [
  {MIGRATION_EXPORT_EXPIRES_AT:new Date(Date.now()-1000).toISOString()},
  {MIGRATION_EXPORT_ENABLED:'false'},
  {MIGRATION_EXPORT_SECRET:''},
 ]){
  configure(overrides);
  const exported=await handle(request('/api/migration-export/manifest'));
  assert.equal(exported.status,404);noEffects();
  for(const route of ['/api/alerts','/api/trips','/api/auth/logout','/api/photo']){
   const response=await handle(request(route,{method:'POST',body:{},origin:'https://argyle.test'}));
   assert.equal(response.status,503);noEffects();
  }
 }
});

test('migration is disabled by default and ordinary behavior remains available',async()=>{
 configure({MIGRATION_READ_ONLY:undefined,MIGRATION_EXPORT_ENABLED:undefined});
 const response=await handle(request('/api/session',{owner:null}));
 assert.equal(response.status,200);
 assert.equal((await response.json()).user,null);noEffects();
 const hidden=await handle(request('/api/migration-export/manifest'));
 assert.equal(hidden.status,404);noEffects();
 const denied=await handle(request('/api/trips',{owner:null}));
 assert.equal(denied.status,401);noEffects();
});

test('missing or incorrect export credentials and cross-origin access perform zero queries',async()=>{
 for(const authorization of [null, '', 'Bearer incorrect-export-secret', 'Basic '+exportSecret]){
  configure();
  const response=await handle(request('/api/migration-export/manifest',{authorization}));
  assert.equal(response.status,401);noEffects();
 }
 configure();
 const rejected=await handle(request('/api/migration-export/manifest',{origin:'https://other.test'}));
 assert.equal(rejected.status,403);noEffects();
});

test('manifest requires explicit organiser configuration and a valid existing organiser session',async()=>{
 for(const overrides of [{AUTH_SECRET:undefined},{AUTH_SECRET:'too-short'},{ADMIN_EMAIL:undefined},{ADMIN_EMAIL:''},{ADMIN_EMAIL:'  '}]){
  configure(overrides);
  const response=await handle(request('/api/migration-export/manifest'));
  assert.equal(response.status,403);noEffects();
 }
 configure();
 const missing=await handle(request('/api/migration-export/manifest',{owner:null}));
 assert.equal(missing.status,403);noEffects();
 configure();
 const resident=await handle(request('/api/migration-export/manifest',{owner:'resident'}));
 assert.equal(resident.status,403);noEffects({allowQueries:true});
 assert.ok(activity.queries.length>=2);
 configure({ADMIN_EMAIL:' OWNER@EXAMPLE.TEST '});
 const approved=await handle(request('/api/migration-export/manifest',{origin:'https://argyle.test'}));
 assert.equal(approved.status,200);
 assert.match(approved.headers.get('cache-control'),/no-store/);
 const body=await approved.text();
 assert.ok(body.length>0);
 assert.ok(!body.includes(authSecret)&&!body.includes(exportSecret));
 assert.ok(activity.queries.length>=2);
 assert.ok(activity.queries.every(isReadQuery));
 noEffects({allowQueries:true});
});

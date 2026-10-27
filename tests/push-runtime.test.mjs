import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createECDH,randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('actual worker runtime sends push and refuses redirects without following them',async()=>{
 mkdirSync('.sites-runtime/runtime-test',{recursive:true});
 await build({stdin:{contents:"import {sendPush} from './lib/push.ts';export default {async fetch(req,env){const fixture=JSON.parse(env.FIXTURE);return Response.json({outcome:await sendPush(fixture.keys,fixture.sub,{kind:'test',expires:Date.now()+60000})})}}",resolveDir:process.cwd(),sourcefile:'runtime-test.ts'},bundle:true,platform:'node',format:'esm',outfile:'.sites-runtime/runtime-test/worker.mjs',external:['node:*'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire('/runtime-test.mjs');"}});
 const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'}),browser=createECDH('prime256v1');browser.generateKeys();
 const fixture={keys:{VAPID_PRIVATE_KEY:JSON.stringify(key),VAPID_PUBLIC_KEY:Buffer.concat([Buffer.from([4]),Buffer.from(key.x,'base64url'),Buffer.from(key.y,'base64url')]).toString('base64url'),VAPID_SUBJECT:'mailto:test@example.com'},sub:{endpoint:'https://fcm.googleapis.com/fcm/send/dummy',p256dh:browser.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 let calls=0,status=201;
 const mf=new Miniflare({modules:true,scriptPath:'.sites-runtime/runtime-test/worker.mjs',compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],bindings:{FIXTURE:JSON.stringify(fixture)},outboundService:async request=>{calls++;assert.equal(request.url,fixture.sub.endpoint);assert.equal(request.headers.get('content-encoding'),'aes128gcm');return new Response(null,{status,headers:{Location:'http://127.0.0.1/private'}})}});
 try{
  assert.deepEqual(await(await mf.dispatchFetch('http://localhost/')).json(),{outcome:'accepted'});assert.equal(calls,1);
  status=307;assert.deepEqual(await(await mf.dispatchFetch('http://localhost/')).json(),{outcome:'failed'});assert.equal(calls,2);
 }finally{await mf.dispose()}
});

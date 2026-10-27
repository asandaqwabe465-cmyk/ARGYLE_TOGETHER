import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHmac,randomUUID} from 'node:crypto';
import vm from 'node:vm';

function relay(){
 const secret='test-relay-secret-with-more-than-32-characters',values=new Map([['RELAY_SECRET',secret]]),sent=[];
 let quota=100,locked=false;
 const properties={getProperty:k=>values.get(k),setProperty:(k,v)=>values.set(k,v),getProperties:()=>Object.fromEntries(values),deleteProperty:k=>values.delete(k)};
 const context=vm.createContext({console,Session:{getEffectiveUser:()=>({getEmail:()=> 'argyletogether@gmail.com'})},PropertiesService:{getScriptProperties:()=>properties},Utilities:{Charset:{UTF_8:'UTF-8'},getUuid:randomUUID,computeHmacSha256Signature:(body,key)=>Array.from(createHmac('sha256',key).update(body).digest())},ContentService:{MimeType:{JSON:'json'},createTextOutput:body=>({setMimeType:()=>JSON.parse(body)})},LockService:{getScriptLock:()=>({tryLock:()=>{locked=true;return true},hasLock:()=>locked,releaseLock:()=>{locked=false}})},MailApp:{getRemainingDailyQuota:()=>quota,sendEmail:m=>{sent.push(m);quota--}}});
 vm.runInContext(readFileSync('integrations/google-apps-script/Code.gs','utf8'),context);
 function envelope(changes={}){const payload=JSON.stringify({type:'verification',to:'resident@example.com',code:'123456',id:randomUUID(),at:Date.now(),...changes});return {payload,signature:createHmac('sha256',secret).update(payload).digest('hex')}}
 return {sent,envelope,send:r=>context.doPost({postData:{contents:JSON.stringify(r)}}),setQuota:n=>{quota=n},values,context};
}

test('relay sends fixed verification template and deduplicates a signed request',()=>{
 const r=relay(),request=r.envelope();assert.equal(r.send(request).ok,true);assert.equal(r.sent.length,1);assert.match(r.sent[0].body,/123456/);assert.equal(r.sent[0].to,'resident@example.com');assert.equal(r.send(request).ok,true);assert.equal(r.sent.length,1);assert.equal(r.context.doGet().ok,false);
});
test('relay rejects altered, unsigned, stale, future, multi-recipient and non-code requests',()=>{
 const r=relay(),tampered=r.envelope();tampered.payload=tampered.payload.replace('resident@','attacker@');assert.equal(r.send(tampered).error,'unauthorized');
 assert.equal(r.send({payload:'{}',signature:'0'.repeat(64)}).error,'unauthorized');
 for(const changes of [{at:Date.now()-300001},{at:Date.now()+60000},{to:'one@example.com,two@example.com'},{type:'distress'},{code:'click this link'},{id:'bad'}])assert.equal(r.send(r.envelope(changes)).error,'invalid');
 assert.equal(r.sent.length,0);
});
test('quota exhaustion sends nothing and a failed send is not retried with the same id',()=>{
 const r=relay();r.setQuota(0);assert.equal(r.send(r.envelope()).error,'quota');assert.equal(r.sent.length,0);
 r.setQuota(1);const request=r.envelope();r.context.MailApp.sendEmail=()=>{throw Error('provider uncertain')};assert.equal(r.send(request).error,'unavailable');assert.equal(r.send(request).error,'uncertain');
});

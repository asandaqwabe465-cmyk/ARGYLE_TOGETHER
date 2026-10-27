import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';

test('install manifest includes valid icons, standalone mode and same-origin scope',()=>{
 const manifest=JSON.parse(readFileSync('public/manifest.webmanifest','utf8'));
 assert.equal(manifest.scope,'/');assert.equal(manifest.start_url,'/');assert.equal(manifest.display,'standalone');
 for(const icon of manifest.icons){assert.ok(existsSync('public'+icon.src));const png=readFileSync('public'+icon.src);assert.equal(png.readUInt32BE(16),Number(icon.sizes.split('x')[0]));}
});
test('service worker distinguishes private tests, trips and distress; never caches API traffic',async()=>{
 const handlers={},shown=[],opened=[];
 const context={URL,Date,Number,encodeURIComponent,fetch:async()=>{throw Error('offline')},caches:{match:async()=>new Response('offline')},self:{location:{origin:'https://argyle.test'},addEventListener:(name,handler)=>handlers[name]=handler,registration:{showNotification:async(title,options)=>shown.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}}};
 vm.runInNewContext(readFileSync('public/sw.js','utf8'),context);
 for(const kind of ['test','trip','distress']){let pending;handlers.push({data:{json:()=>({kind,id:'trip-123',expires:Date.now()+60000})},waitUntil:p=>pending=p});await pending}
 assert.match(shown[0].title,/working/);assert.match(shown[0].body,/only to your device/);assert.match(shown[1].title,/New trip/);assert.equal(shown[1].data.url,'/?trip=trip-123');assert.match(shown[2].title,/Distress/);
 let pending;handlers.notificationclick({notification:{data:{url:'https://evil.test/'},close(){}},waitUntil:p=>pending=p});await pending;assert.equal(opened[0],'https://argyle.test/');
 let handled=false;handlers.fetch({request:{mode:'cors',method:'GET',url:'https://argyle.test/api/alerts'},respondWith(){handled=true}});assert.equal(handled,false);
 handlers.fetch({request:{mode:'navigate',method:'GET',url:'https://argyle.test/'},respondWith:p=>pending=p});assert.equal(await (await pending).text(),'offline');
});

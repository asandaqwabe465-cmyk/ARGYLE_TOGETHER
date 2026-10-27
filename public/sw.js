const CACHE='argyle-offline-v1';
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/offline.html','/icons/icon-192.png'])).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('argyle-offline-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 // Never cache accounts, photos, locations, API responses or signed-in pages.
 if(event.request.mode==='navigate'&&event.request.method==='GET')event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));
 else if(event.request.method==='GET'&&event.request.url===new URL('/icons/icon-192.png',self.location.origin).href)event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
self.addEventListener('push',event=>{
 let message={};try{message=event.data?.json()||{}}catch{}
 const fresh=Number.isFinite(message.expires)&&message.expires>Date.now();
 const trip=fresh&&message.kind==='trip'&&typeof message.id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(message.id);
 const test=message.kind==='test';
 event.waitUntil(self.registration.showNotification(test?'Notifications are working':trip?'New trip · Argyle Together':fresh&&message.kind==='distress'?'Distress alert · Argyle Together':'Argyle Together',{
  body:test?'This test was sent only to your device. No distress alert was created.':trip?'A neighbour is looking for walking company. Tap to view the trip.':fresh?'A resident has requested help. Open the app for current details.':'Open the app to check the latest trips and distress alerts.',
  icon:'/icons/icon-192.png',tag:test?'argyle-test':trip?'argyle-trip-'+message.id:'argyle-distress',data:{url:test?'/':trip?'/?trip='+encodeURIComponent(message.id):'/?alerts=1'}
 }));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const requested=event.notification.data?.url;
 const safe=typeof requested==='string'&&(/^\/\?trip=[a-zA-Z0-9%-]+$/.test(requested)||requested==='/?alerts=1'||requested==='/')?requested:'/';
 const url=new URL(safe,self.location.origin).href;
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
  for(const client of clients){if(new URL(client.url).origin===self.location.origin){await client.navigate(url);return client.focus()}}
  return self.clients.openWindow(url);
 }));
});

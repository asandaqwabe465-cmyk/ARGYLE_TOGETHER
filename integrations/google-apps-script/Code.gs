// Argyle Together: temporary verification-code sender ONLY.
// Run setup from the editor while signed in as argyletogether@gmail.com.
// Never place a Gmail password or a relay secret in this source file.
function setup() {
  if (Session.getEffectiveUser().getEmail().toLowerCase() !== 'argyletogether@gmail.com') {
    throw new Error('Use the argyletogether@gmail.com Google account.');
  }
  var properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('RELAY_SECRET')) {
    properties.setProperty('RELAY_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  MailApp.getRemainingDailyQuota(); // Request send-mail permission; sends no email.
  console.log('Setup complete. Find RELAY_SECRET under Project Settings > Script properties. Keep it private.');
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse({service: 'Argyle Together verification sender',ok: false});
}

function doPost(event) {
  var lock;
  try {
    var raw = event && event.postData && event.postData.contents;
    if (typeof raw !== 'string' || raw.length > 2000) return jsonResponse({error: 'invalid'});
    var request = JSON.parse(raw);
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('RELAY_SECRET');
    if (!secret || secret.length < 32 || typeof request.payload !== 'string' || request.payload.length > 1200 || !/^[a-f0-9]{64}$/.test(request.signature || '')) return jsonResponse({error: 'unauthorized'});
    var expected = Utilities.computeHmacSha256Signature(request.payload, secret, Utilities.Charset.UTF_8).map(function(b) {return ('0' + ((b + 256) % 256).toString(16)).slice(-2);}).join('');
    var difference = 0;
    for (var i = 0; i < 64; i++) difference |= expected.charCodeAt(i) ^ request.signature.charCodeAt(i);
    if (difference !== 0) return jsonResponse({error: 'unauthorized'});
    var message = JSON.parse(request.payload);
    var now = Date.now();
    if (message.type !== 'verification' || typeof message.to !== 'string' || message.to.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(message.to) || typeof message.code !== 'string' || !/^\d{6}$/.test(message.code) || !/^[a-f0-9-]{36}$/.test(message.id || '') || !Number.isSafeInteger(message.at) || message.at < now - 300000 || message.at > now + 30000) return jsonResponse({error: 'invalid'});
    if (Session.getEffectiveUser().getEmail().toLowerCase() !== 'argyletogether@gmail.com') return jsonResponse({error: 'configuration'});
    lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) return jsonResponse({error: 'busy'});
    var marker = 'request_' + message.id;
    var previous = properties.getProperty(marker);
    if (previous) return jsonResponse(JSON.parse(previous).sent ? {ok: true} : {error: 'uncertain'});
    var entries = properties.getProperties();
    Object.keys(entries).forEach(function(key) {
      if (key.indexOf('request_') === 0 && JSON.parse(entries[key]).at < now - 600000) properties.deleteProperty(key);
    });
    if (MailApp.getRemainingDailyQuota() < 1) return jsonResponse({error: 'quota'});
    // Reserve before sending: an uncertain result must never trigger a duplicate send.
    properties.setProperty(marker, JSON.stringify({at: now, sent: false}));
    MailApp.sendEmail({
      to: message.to,
      name: 'Argyle Together',
      subject: 'Your Argyle Together verification code',
      body: 'Your verification code is ' + message.code + '. It expires in 10 minutes. Do not share this code.\n\nIf you did not request this, ignore this email.'
    });
    properties.setProperty(marker, JSON.stringify({at: now, sent: true}));
    return jsonResponse({ok: true});
  } catch (_) {
    // Do not log recipient addresses, codes, signed requests or secrets.
    return jsonResponse({error: 'unavailable'});
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

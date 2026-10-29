import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { Miniflare } from 'miniflare';

const secret = 'synthetic-migration-token-for-local-tests-only-123456789';
const origin = 'https://source.example.test';
const source = ts.transpileModule(readFileSync('migration/source-export.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { migrationGate } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const settings = {
  MIGRATION_READ_ONLY: 'true', MIGRATION_EXPORT_ENABLED: 'true',
  MIGRATION_EXPORT_SECRET: secret,
  MIGRATION_READ_ONLY_SINCE: new Date(Date.now() - 180_000).toISOString(),
  MIGRATION_EXPORT_EXPIRES_AT: new Date(Date.now() + 600_000).toISOString(),
};
let mf, db, bucket;
let outboundCalls = 0;

before(async () => {
  mf = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    script: source + `
      export default { async fetch(request, env) {
        const breakData = request.headers.has('x-test-break-data');
        const bindings = {...env,
          DB: { prepare(sql) {
            if (breakData || !/^(SELECT |PRAGMA table_info\\()/i.test(sql)) throw Error('Forbidden data access');
            return env.DB.prepare(sql);
          }},
          BUCKET: {
            list(...args) { if (breakData) throw Error('Forbidden storage access'); return env.BUCKET.list(...args); },
            get(...args) { if (breakData) throw Error('Forbidden storage access'); return env.BUCKET.get(...args); },
          },
        };
        return await migrationGate(request, bindings, async () => request.headers.get('x-test-owner') === 'true')
          ?? new Response('normal-app-handler');
      }};
    `,
    d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: settings,
    outboundService: () => { outboundCalls++; throw Error('No external requests allowed'); },
  });
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  for (const name of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
    const sql = readFileSync('drizzle/' + name, 'utf8').replace(/--> statement-breakpoint/g, '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  for (let start = 0; start < 105; start += 30) {
    await db.batch(Array.from({ length: Math.min(30, 105 - start) }, (_, i) => {
      const id = 'fixture-user-' + (start + i);
      return db.prepare('INSERT INTO users (id,email,created) VALUES (?,?,?)').bind(id, id + '@example.test', 1000 + start + i);
    }));
  }
  // Real D1 gaps test keyset pagination rather than offset assumptions.
  await db.prepare('DELETE FROM users WHERE id=?').bind('fixture-user-20').run();
  await db.prepare('INSERT INTO trips (id,owner_id,destination,origin,departure,created) VALUES (?,?,?,?,?,?)')
    .bind('trip-1', 'fixture-user-0', 'Synthetic destination', 'Synthetic origin', 2000, 1000).run();
  await db.prepare('INSERT INTO trip_messages (id,trip_id,user_id,body,created) VALUES (?,?,?,?,?)')
    .bind('message-1', 'trip-1', 'fixture-user-0', 'Synthetic message', 1000).run();
  await bucket.put('profiles/fixture-user-0', new Uint8Array([0, 255, 10, 13, 42]), {
    httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' },
    customMetadata: { fixture: 'synthetic' },
  });
});

after(async () => { if (mf) await mf.dispose(); });

function request(path, options = {}) {
  return new Request(origin + path, {
    ...options, headers: { Authorization: 'Bearer ' + secret, 'x-test-owner': 'true', ...options.headers },
  });
}
const dispatch = (path, options) => {
  const input = request(path, options);
  return mf.dispatchFetch(input.url, { method: input.method, headers: Object.fromEntries(input.headers) });
};

test('global API maintenance stays enabled after token expiry; normal pages are untouched', async () => {
  const bindings = { ...settings, MIGRATION_EXPORT_EXPIRES_AT: new Date(Date.now() - 1).toISOString() };
  const neverOwner = async () => { throw Error('Owner auth must not run'); };
  for (const path of ['/api', '/api/trips', '/api/alerts', '/api/auth/logout']) {
    const response = await migrationGate(request(path), bindings, neverOwner);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /paused.*migration/);
  }
  for (const path of ['/', '/privacy', '/apiary', '/apiary/test']) {
    assert.equal(await migrationGate(request(path), bindings, neverOwner), null);
  }
  assert.equal((await migrationGate(request('/api/migration-export/manifest'), bindings, neverOwner)).status, 404);
});

test('disabled, immature, malformed, overlong or expired credentials fail closed before data', async () => {
  let reads = 0;
  const trap = { prepare() { reads++; throw Error('Unexpected read'); } };
  const cases = [
    { MIGRATION_READ_ONLY: 'false' }, { MIGRATION_EXPORT_ENABLED: 'false' },
    { MIGRATION_EXPORT_SECRET: 'short' }, { MIGRATION_EXPORT_SECRET: 'x'.repeat(4097) },
    { MIGRATION_EXPORT_SECRET: 'x'.repeat(40) + '\n' },
    { MIGRATION_READ_ONLY_SINCE: new Date(Date.now() - 10_000).toISOString() },
    { MIGRATION_READ_ONLY_SINCE: '2026-02-30T00:00:00Z' },
    { MIGRATION_EXPORT_EXPIRES_AT: new Date(Date.now() - 1).toISOString() },
    { MIGRATION_EXPORT_EXPIRES_AT: new Date(Date.now() + 5 * 3600_000).toISOString() },
  ];
  for (const changes of cases) {
    const response = await migrationGate(request('/api/migration-export/manifest'), { ...settings, ...changes, DB: trap }, async () => { throw Error('No owner lookup'); });
    assert.equal(response.status, 404);
  }
  assert.equal(reads, 0);
});

test('Worker endpoint checks token, origin, method and owner before data access', async () => {
  for (const token of ['', 'Bearer incorrect', 'Bearer ' + 'z'.repeat(secret.length)]) {
    assert.equal((await dispatch('/api/migration-export/manifest', { headers: { Authorization: token, 'x-test-break-data': 'true' } })).status, 401);
  }
  assert.equal((await dispatch('/api/migration-export/manifest', { headers: { Origin: 'https://elsewhere.example.test', 'x-test-break-data': 'true' } })).status, 403);
  assert.equal((await dispatch('/api/migration-export/manifest', { headers: { 'x-test-owner': 'false', 'x-test-break-data': 'true' } })).status, 403);
  assert.equal((await dispatch('/api/migration-export/manifest', { method: 'POST', headers: { 'x-test-break-data': 'true' } })).status, 405);
  assert.equal((await dispatch('/api/migration-export/unknown', { headers: { 'x-test-break-data': 'true' } })).status, 404);
  assert.equal((await dispatch('/api/migration-export/manifest?unexpected=1')).status, 400);
});

test('manifest reads actual D1 schema and excludes active credentials/queues', async () => {
  const response = await dispatch('/api/migration-export/manifest', { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const data = await response.json();
  assert.equal(data.format, 'argyle-export-v1');
  assert.equal(data.sourceOrigin, origin);
  assert.equal(data.tables.length, 10);
  assert.equal(data.tables.find(table => table.name === 'users').count, 104);
  assert.ok(data.tables.find(table => table.name === 'users').columns.some(column => column.name === 'privacy_accepted'));
  assert.ok(data.schema.some(item => item.name === 'trip_messages' && /AUTOINCREMENT/.test(item.sql)));
  assert.deepEqual(new Set(data.excludedTables), new Set(['sessions', 'challenges', 'limits', 'locations', 'push_subscriptions', 'push_deliveries']));
  assert.deepEqual(await (await dispatch('/api/migration-export/manifest')).json(), data);
});

test('actual D1 keyset pages preserve all rows across rowid gaps without leaking rowids', async () => {
  const first = await (await dispatch('/api/migration-export/table?name=users&cursor=0')).json();
  assert.equal(first.rows.length, 100);
  assert.ok(first.nextCursor);
  assert.equal(first.columns.includes('__migration_rowid'), false);
  const second = await (await dispatch('/api/migration-export/table?name=users&cursor=' + first.nextCursor)).json();
  assert.equal(second.rows.length, 4);
  assert.equal(second.nextCursor, null);
  const idColumn = first.columns.indexOf('id');
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row[idColumn])).size, 104);
  for (const query of ['name=sessions', 'name=users&cursor=-1', 'name=users&cursor=01', 'name=users&cursor=9007199254740992', 'name=users&name=trips', 'name=users%22%3BDROP%20TABLE%20users']) {
    assert.equal((await dispatch('/api/migration-export/table?' + query)).status, 400);
  }
});

test('unreviewed tables and shadowed SQLite rowid columns stop export', async () => {
  await db.exec('CREATE TABLE unreviewed_table (id TEXT);');
  try {
    const response = await dispatch('/api/migration-export/manifest');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'The migration export is temporarily unavailable.');
  } finally { await db.exec('DROP TABLE unreviewed_table;'); }
  await db.exec('ALTER TABLE users ADD COLUMN __migration_rowid TEXT;');
  try { assert.equal((await dispatch('/api/migration-export/table?name=users')).status, 503); }
  finally { await db.exec('ALTER TABLE users DROP COLUMN __migration_rowid;'); }
});

test('actual R2 lists metadata and conditionally streams identical bytes', async () => {
  const inventory = await (await dispatch('/api/migration-export/objects')).json();
  assert.equal(inventory.objects.length, 1);
  assert.equal(inventory.nextCursor, null);
  const object = inventory.objects[0];
  assert.equal(object.httpMetadata.contentType, 'image/png');
  assert.deepEqual(object.customMetadata, { fixture: 'synthetic' });
  assert.equal(object.size, 5);
  for (const etag of [object.etag, '"' + object.etag + '"']) {
    const response = await dispatch('/api/migration-export/object?key=' + encodeURIComponent(object.key), { headers: { 'If-Match': etag } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('ETag'), '"' + object.etag + '"');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 10, 13, 42]));
  }
  assert.equal((await dispatch('/api/migration-export/object?key=' + object.key, { headers: { 'If-Match': 'stale-etag' } })).status, 412);
  assert.equal((await dispatch('/api/migration-export/object?key=profiles/missing')).status, 404);
});

test('unknown bucket objects and invalid object requests fail closed, with no outbound calls', async () => {
  await bucket.put('unreviewed/file', 'synthetic');
  try { assert.equal((await dispatch('/api/migration-export/objects')).status, 503); }
  finally { await bucket.delete('unreviewed/file'); }
  for (const key of ['other/file', 'profiles/', 'profiles/' + 'x'.repeat(1024), 'profiles/control\nkey']) {
    assert.equal((await dispatch('/api/migration-export/object?key=' + encodeURIComponent(key))).status, 400);
  }
  const response = await dispatch('/api/migration-export/manifest', { headers: { 'x-test-break-data': 'true' } });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /Forbidden|SELECT|sqlite|AUTH_SECRET/);
  assert.equal(outboundCalls, 0);
});

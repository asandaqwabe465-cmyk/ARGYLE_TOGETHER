import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, stat, readdir, rm, chmod, symlink, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {Miniflare} from 'miniflare';
import {DatabaseSync} from 'node:sqlite';
import {downloadExport, TABLES, sha256, parseArguments, validateSource, ExportError} from '../migration/download-export.mjs';
import {rehearseImport} from '../migration/rehearse-import.mjs';

const source = 'https://original-site.example';
const clock = Date.parse('2026-10-29T12:00:00Z');
const token = 'synthetic-export-credential-'.repeat(2);
const cookie = 'argyle_session=' + 'synthetic-session-'.repeat(4);
const photo = Buffer.from([137, 80, 0, 255, 10]);
const json = value => Response.json(value);
const column = name => ({cid: 0, name, type: 'TEXT', notnull: 1, dflt_value: null, pk: 1});

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'argyle-export-test-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  const credentialsPath = path.join(root, 'credentials.json');
  await writeFile(credentialsPath, JSON.stringify({token, cookie}), {mode: 0o600});
  const output = path.join(root, 'export');
  const key = options.key || 'profiles/synthetic-resident';
  const tables = TABLES.map(name => ({name, count: name === 'users' ? 1 : 0, columns: name === 'users' ? [column('id'), {...column('photo'), cid: 1, pk: 0}] : [column('id')]}));
  const excludedTables = ['sessions', 'challenges', 'limits', 'locations', 'push_subscriptions', 'push_deliveries'];
  const manifest = {format: 'argyle-export-v1', sourceOrigin: source, pausedSince: new Date(clock - 180000).toISOString(), expiresAt: new Date(clock + 3600000).toISOString(), tables, excludedTables, schema: [...TABLES, ...excludedTables].map(name => ({type: 'table', name, tbl_name: name, sql: 'CREATE TABLE ' + name + ' (id TEXT)'}))};
  const object = {key, size: photo.length, etag: 'a'.repeat(32), uploaded: new Date(clock - 3600000).toISOString(), httpMetadata: {contentType: 'image/png'}, customMetadata: {}};
  const calls = [], routeCounts = new Map();
  const fetchImpl = async (input, init) => {
    const url = new URL(input), route = url.pathname.split('/').at(-1), name = url.searchParams.get('name');
    const countKey = route + (name ? ':' + name : '');
    routeCounts.set(countKey, (routeCounts.get(countKey) || 0) + 1);
    const count = routeCounts.get(countKey);
    calls.push({url, init});
    assert.equal(url.origin, source);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.equal(init.headers.Cookie, cookie);
    assert.equal(url.search.includes(token), false);
    assert.equal(url.search.includes(cookie), false);
    const changed = await options.respond?.({route, name, count, url, init, manifest, object});
    if (changed) return changed;
    if (route === 'manifest') return json(manifest);
    if (route === 'table') {
      const table = tables.find(table => table.name === name);
      return json({table: name, columns: table.columns.map(column => column.name), rows: name === 'users' ? [['synthetic-resident', key]] : [], nextCursor: null});
    }
    if (route === 'objects') return json({objects: [object], nextCursor: null});
    if (route === 'object') {
      assert.equal(url.searchParams.get('key'), key);
      assert.equal(init.headers['If-Match'], object.etag);
      return new Response(photo, {headers: {ETag: '"' + object.etag + '"'}});
    }
    throw new Error('Unexpected fixture request');
  };
  return {root, output, credentialsPath, calls, manifest, object, fetchImpl, run: overrides => downloadExport({source, credentialsPath, output, fetchImpl, now: () => clock, ...overrides})};
}

async function absentComplete(output) {
  await assert.rejects(stat(path.join(output, 'COMPLETE.json')), {code: 'ENOENT'});
}

test('private export preserves binary bytes and exact keys, verifies repeat reads, and writes checksummed 0600 files', async t => {
  // Even odd storage keys cannot become local filesystem paths.
  const f = await fixture(t, {key: 'profiles/../../literal-photo-key'});
  const result = await f.run();
  assert.deepEqual(result, {output: f.output, tables: 10, objects: 1});
  const completeBytes = await readFile(path.join(f.output, 'COMPLETE.json'));
  const complete = JSON.parse(completeBytes);
  assert.equal(complete.objectCount, 1);
  assert.match(complete.consistency, /Not a transactional snapshot/);
  const inventory = JSON.parse(await readFile(path.join(f.output, 'inventory.json')));
  assert.equal(inventory.objects[0].key, f.object.key);
  const checksumsBytes = await readFile(path.join(f.output, 'checksums.json'));
  assert.equal(sha256(checksumsBytes), complete.checksumsSha256);
  const checksums = JSON.parse(checksumsBytes);
  for (const [relative, hash] of Object.entries(checksums.files)) assert.equal(sha256(await readFile(path.join(f.output, relative))), hash);
  const photoPath = path.join(f.output, 'objects', sha256(f.object.key) + '.bin');
  assert.deepEqual(await readFile(photoPath), photo);
  const walk = async directory => {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else assert.equal((await stat(filename)).mode & 0o777, 0o600);
    }
  };
  await walk(f.output);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/manifest')).length, 2);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/table')).length, 20);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/objects')).length, 2);
});

test('source rejection never echoes the response body or marks an export complete', async t => {
  const f = await fixture(t, {respond: ({route}) => route === 'manifest' && new Response('SECRET SERVER CONTENT ' + token, {status: 403})});
  await assert.rejects(f.run(), error => error instanceof ExportError && error.message === 'Source rejected an export request (HTTP 403).');
  await absentComplete(f.output);
});

test('redirects and network exception details are not propagated', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({fetchImpl: async () => {throw new Error(token);}}), /Could not reach the authorised export endpoint/);
  await absentComplete(f.output);
  const other = await fixture(t, {respond: () => Response.redirect('https://elsewhere.example', 302)});
  await assert.rejects(other.run(), /HTTP 302/);
  await absentComplete(other.output);
});

test('unknown tables, changed columns, invalid cursors, and incomplete table counts fail closed', async t => {
  for (const change of ['unknown-table', 'column', 'cursor', 'count']) {
    const f = await fixture(t, {respond: ({route, name, manifest}) => {
      if (change === 'unknown-table' && route === 'manifest') return json({...manifest, tables: [...manifest.tables, {name: 'sessions', count: 1, columns: [column('digest')]}]});
      if (change === 'count' && route === 'manifest') return json({...manifest, tables: manifest.tables.map(table => table.name === 'users' ? {...table, count: 2} : table)});
      if (route === 'table' && name === 'users' && ['column', 'cursor'].includes(change)) return json({table: 'users', columns: change === 'column' ? ['id', 'digest'] : ['id', 'photo'], rows: [['synthetic-resident', 'profiles/synthetic-resident']], nextCursor: change === 'cursor' ? '0' : null});
    }});
    await assert.rejects(f.run(), ExportError);
    await absentComplete(f.output);
  }
});

test('changed row data during repeat verification prevents completion', async t => {
  const f = await fixture(t, {respond: ({route, name, count}) => route === 'table' && name === 'users' && count === 2 && json({table: 'users', columns: ['id', 'photo'], rows: [['CHANGED', 'profiles/synthetic-resident']], nextCursor: null})});
  await assert.rejects(f.run(), /Source records changed during export/);
  await absentComplete(f.output);
});

test('missing referenced photos, duplicate keys, and unknown object prefixes prevent completion', async t => {
  for (const change of ['missing', 'duplicate', 'prefix']) {
    const f = await fixture(t, {respond: ({route, object}) => route === 'objects' && json({objects: change === 'missing' ? [] : change === 'duplicate' ? [object, object] : [{...object, key: 'unknown/file'}], nextCursor: null})});
    await assert.rejects(f.run(), ExportError);
    await absentComplete(f.output);
  }
});

test('a changed photo etag or truncated download leaves no completion marker or partial object', async t => {
  for (const change of ['etag', 'truncated', 'larger']) {
    const f = await fixture(t, {respond: ({route, object}) => route === 'object' && new Response(change === 'truncated' ? photo.subarray(0, 2) : change === 'larger' ? Buffer.concat([photo, photo]) : photo, {headers: {ETag: '"' + (change === 'etag' ? 'b'.repeat(32) : object.etag) + '"'}})});
    await assert.rejects(f.run(), ExportError);
    await absentComplete(f.output);
    assert.deepEqual(await readdir(path.join(f.output, 'objects')), []);
  }
});

test('changed photo metadata during final inventory verification prevents completion', async t => {
  const f = await fixture(t, {respond: ({route, count, object}) => route === 'objects' && count === 2 && json({objects: [{...object, customMetadata: {changed: 'yes'}}], nextCursor: null})});
  await assert.rejects(f.run(), /Source photo inventory changed/);
  await absentComplete(f.output);
});

test('on-disk readback detects damaged private files before a completion marker is written', async t => {
  const f = await fixture(t, {respond: async ({route, count, object}) => {
    if (route === 'objects' && count === 2) await writeFile(path.join(f.output, 'objects', sha256(object.key) + '.bin'), 'damaged');
  }});
  await assert.rejects(f.run(), /Private export file verification failed/);
  await absentComplete(f.output);
});

test('private credential permissions and symlinks are checked before any request', async t => {
  const f = await fixture(t);
  await chmod(f.credentialsPath, 0o644);
  await assert.rejects(f.run(), /permissions 0600/);
  assert.equal(f.calls.length, 0);
  await chmod(f.credentialsPath, 0o600);
  const link = path.join(f.root, 'credentials-link.json');
  await symlink(f.credentialsPath, link);
  await assert.rejects(f.run({credentialsPath: link}), /regular private file/);
  assert.equal(f.calls.length, 0);
});

test('output cannot overwrite files or enter the repository, including through a parent symlink', async t => {
  const f = await fixture(t);
  await mkdir(f.output, {mode: 0o700});
  await writeFile(path.join(f.output, 'keep.txt'), 'keep', {mode: 0o600});
  await assert.rejects(f.run(), /must not already exist/);
  assert.equal(await readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'keep');
  const link = path.join(f.root, 'repository-link');
  await symlink(path.resolve('.'), link);
  await assert.rejects(f.run({output: path.join(link, 'private-export-must-not-exist')}), /outside the repository/);
  assert.equal(f.calls.length, 0);
});

test('CLI and origin validation reject ambiguous or credential-bearing inputs', () => {
  assert.deepEqual(parseArguments(['--help']), {help: true});
  assert.deepEqual(parseArguments(['--output', '/tmp/new', '--credentials', '/tmp/private', '--source', source]), {output: '/tmp/new', credentialsPath: '/tmp/private', source});
  for (const args of [[], ['--token', token], ['--source', source, '--source', source], ['--help', '--source', source], ['--source']]) assert.throws(() => parseArguments(args), ExportError);
  for (const origin of ['http://site.example', 'https://site.example/path', 'https://user:pass@site.example', 'https://site.example?key=value', 'https://site.example#fragment', 'https://site.example:8443']) assert.throws(() => validateSource(origin), ExportError);
  assert.equal(validateSource(source + '/'), source);
});

test('actual source helper and downloader round-trip 201 users through paginated D1 and private R2 in an offline Worker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'argyle-real-bindings-test-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  const credentialsPath = path.join(root, 'credentials.json');
  await writeFile(credentialsPath, JSON.stringify({token, cookie}), {mode: 0o600});
  const helper = ts.transpileModule(await readFile('migration/source-export.ts', 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
  const mf = new Miniflare({
    modules: true,
    script: helper + '\nexport default {async fetch(request,env){return await migrationGate(request,env,async()=>true)||new Response(null,{status:404});}};',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
    r2Buckets: ['BUCKET'],
    bindings: {MIGRATION_READ_ONLY: 'true', MIGRATION_EXPORT_ENABLED: 'true', MIGRATION_EXPORT_SECRET: token, MIGRATION_READ_ONLY_SINCE: new Date(Date.now() - 180000).toISOString(), MIGRATION_EXPORT_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString()},
    outboundService: async () => {throw new Error('No outbound network is permitted in the migration test.');},
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const filename of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) {
    for (const statement of (await readFile(path.join('drizzle', filename), 'utf8')).split('--> statement-breakpoint')) if (statement.trim()) await db.prepare(statement).run();
  }
  for (let offset = 0; offset < 201; offset += 50) {
    const statements = [];
    for (let index = offset; index < Math.min(201, offset + 50); index++) statements.push(db.prepare('INSERT INTO users (id,email,name,photo,complete,created) VALUES (?,?,?,?,?,?)').bind('synthetic-' + index, 'synthetic-' + index + '@example.invalid', 'Synthetic Resident ' + index, index === 0 ? 'profiles/synthetic-0' : '', 1, clock));
    await db.batch(statements);
  }
  await db.prepare('INSERT INTO trips (id,owner_id,destination,origin,departure,created) VALUES (?,?,?,?,?,?)').bind('synthetic-trip', 'synthetic-0', 'Synthetic Library', 'Synthetic Residence', clock + 1000, clock).run();
  await db.prepare('INSERT INTO replies (id,trip_id,user_id,meeting,created) VALUES (?,?,?,?,?)').bind('synthetic-reply', 'synthetic-trip', 'synthetic-1', 'Synthetic Gate', clock).run();
  await db.prepare('INSERT INTO trip_messages (id,trip_id,user_id,body,created) VALUES (?,?,?,?,?)').bind('synthetic-message', 'synthetic-trip', 'synthetic-0', 'Synthetic message', clock).run();
  // These operational credentials must never appear in any exported page.
  await db.prepare('INSERT INTO sessions (digest,user_id,expires) VALUES (?,?,?)').bind('SYNTHETIC-SESSION-NOT-FOR-EXPORT', 'synthetic-0', clock + 1000).run();
  const bucket = await mf.getR2Bucket('BUCKET');
  await bucket.put('profiles/synthetic-0', photo, {httpMetadata: {contentType: 'image/png'}, customMetadata: {fixture: 'synthetic'}});
  const calls = [];
  const output = path.join(root, 'export');
  const result = await downloadExport({source, credentialsPath, output, fetchImpl: async (url, init) => {
    calls.push(new URL(url));
    return mf.dispatchFetch(url, init);
  }});
  assert.equal(result.objects, 1);
  const first = JSON.parse(await readFile(path.join(output, 'tables/users/page-000000.json')));
  const second = JSON.parse(await readFile(path.join(output, 'tables/users/page-000001.json')));
  const third = JSON.parse(await readFile(path.join(output, 'tables/users/page-000002.json')));
  assert.equal(first.rows.length, 100);
  assert.equal(second.rows.length, 100);
  assert.equal(third.rows.length, 1);
  assert.equal(third.nextCursor, null);
  const replyPage = JSON.parse(await readFile(path.join(output, 'tables/replies/page-000000.json')));
  assert.equal(replyPage.rows[0][replyPage.columns.indexOf('trip_id')], 'synthetic-trip');
  assert.equal(replyPage.rows[0][replyPage.columns.indexOf('user_id')], 'synthetic-1');
  assert.deepEqual(await readFile(path.join(output, 'objects', sha256('profiles/synthetic-0') + '.bin')), photo);
  const inventory = JSON.parse(await readFile(path.join(output, 'inventory.json')));
  assert.deepEqual(inventory.objects[0].customMetadata, {fixture: 'synthetic'});
  assert.equal(inventory.objects[0].httpMetadata.contentType, 'image/png');
  assert.equal(calls.filter(url => url.pathname.endsWith('/table') && url.searchParams.get('name') === 'users').length, 6);
  assert.equal((await readdir(path.join(output, 'tables'))).includes('sessions'), false);
  assert.equal(JSON.parse(await readFile(path.join(output, 'COMPLETE.json'))).tables.find(table => table.name === 'users').count, 201);
  // Rehearse importing the real local D1/R2 export, rather than just a hand-built
  // SQLite manifest: source schema serialisation must remain compatible too.
  const restoredOutput = path.join(root, 'import-rehearsal');
  assert.deepEqual(await rehearseImport({exportDir: output, output: restoredOutput, expectedSource: source}), {output: restoredOutput, tables: 10, objects: 1});
  const restored = new DatabaseSync(path.join(restoredOutput, 'restored.sqlite'), {readOnly: true});
  try {
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM users').get().n, 201);
    assert.equal(restored.prepare('SELECT owner_id FROM trips WHERE id=?').get('synthetic-trip').owner_id, 'synthetic-0');
    assert.equal(restored.prepare('SELECT trip_id FROM replies WHERE id=?').get('synthetic-reply').trip_id, 'synthetic-trip');
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {restored.close();}
  assert.deepEqual(await readFile(path.join(restoredOutput, 'objects', sha256('profiles/synthetic-0') + '.bin')), photo);
  assert.deepEqual(JSON.parse(await readFile(path.join(restoredOutput, 'inventory.json'))), inventory);
  assert.equal(JSON.parse(await readFile(path.join(restoredOutput, 'REHEARSAL.json'))).remoteModified, false);
});

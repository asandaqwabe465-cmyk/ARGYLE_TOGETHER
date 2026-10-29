import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, stat, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {canonical, sha256, TABLES} from '../migration/download-export.mjs';
import {rehearseImport, ImportError} from '../migration/rehearse-import.mjs';

const excluded = ['sessions', 'challenges', 'limits', 'locations', 'push_subscriptions', 'push_deliveries'];
const allTables = [...TABLES, ...excluded];
const source = 'https://original-source.example.invalid';
const privatePhoto = Buffer.from([137, 80, 0, 255, 10, 13, 42]);
const orphanPhoto = Buffer.from([1, 2, 3, 0, 255]);
const photoKey = 'profiles/user-one';
const orphanKey = 'profiles/../../literal-unreferenced-object';
const jsonRead = async filename => JSON.parse(await readFile(filename, 'utf8'));
const jsonWrite = (filename, value) => writeFile(filename, canonical(value) + '\n', {mode: 0o600});

async function fixture(t, {manyUsers = false} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'argyle-import-rehearsal-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  const exportDir = path.join(root, 'export');
  const output = path.join(root, 'restored');
  await mkdir(exportDir, {mode: 0o700});
  await mkdir(path.join(exportDir, 'tables'), {mode: 0o700});
  await mkdir(path.join(exportDir, 'objects'), {mode: 0o700});
  const sql = new DatabaseSync(':memory:');
  try {
    for (const filename of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) sql.exec(await readFile(path.join('drizzle', filename), 'utf8'));
    const created = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const addUser = sql.prepare('INSERT INTO users (id,email,name,phone,photo,complete,created,privacy_version,privacy_accepted) VALUES (?,?,?,?,?,?,?,?,?)');
    addUser.run('user-one', 'first@example.invalid', "O’Connor's 名字\nSecond line", '+27000000000', photoKey, 1, created, 'synthetic-privacy-v1', created);
    addUser.run('user-two', 'second@example.invalid', 'Second Resident', '', '', 0, created + 1, null, null);
    addUser.run('organiser', 'organiser@example.invalid', 'Organiser', '', '', 1, created + 2, null, null);
    if (manyUsers) for (let i = 0; i < 105; i++) addUser.run('extra-' + i, 'extra-' + i + '@example.invalid', 'Synthetic extra ' + i, '', '', 0, created + i + 10, null, null);
    sql.prepare('INSERT INTO trips (id,owner_id,destination,origin,departure,note,created,status) VALUES (?,?,?,?,?,?,?,?)').run('trip-one', 'user-one', 'Synthetic library', 'Synthetic residence', created + 3600000, "Bring a friend's book\n☂", created, 'finished');
    sql.prepare('INSERT INTO replies (id,trip_id,user_id,meeting,status,created) VALUES (?,?,?,?,?,?)').run('reply-one', 'trip-one', 'user-two', 'Synthetic gate', 'accepted', created);
    sql.prepare('INSERT INTO escorts (trip_id,status,escort_id,created) VALUES (?,?,?,?)').run('trip-one', 'closed', null, created);
    sql.prepare('INSERT INTO alerts (id,user_id,created,status,lat,lng,accuracy,location_at) VALUES (?,?,?,?,?,?,?,?)').run('alert-one', 'user-one', created, 'resolved', null, null, null, null);
    sql.prepare('INSERT INTO volunteers (user_id,reason,status,created,reviewed,reviewer) VALUES (?,?,?,?,?,?)').run('user-two', 'Synthetic volunteer', 'approved', created, created + 1, 'organiser');
    sql.prepare('INSERT INTO incidents (id,reporter_id,category,place,occurred,description,status,created,reviewed,reviewer) VALUES (?,?,?,?,?,?,?,?,?,?)').run('incident-one', 'user-one', 'Synthetic category', 'Synthetic place', created, 'Synthetic report', 'resolved', created, created + 1, 'organiser');
    sql.prepare('INSERT INTO incident_flags (id,incident_id,user_id,reason,details,snapshot,created) VALUES (?,?,?,?,?,?,?)').run('flag-one', 'incident-one', 'user-two', 'Synthetic reason', 'Synthetic details', '{"fixture":true}', created);
    sql.prepare('INSERT INTO trip_messages (seq,id,trip_id,user_id,body,created) VALUES (?,?,?,?,?,?)').run(7, 'message-seven', 'trip-one', 'user-one', "I'll meet you\n你好", created);
    sql.prepare('INSERT INTO trip_messages (seq,id,trip_id,user_id,body,created) VALUES (?,?,?,?,?,?)').run(42, 'message-forty-two', 'trip-one', 'user-two', 'Synthetic reply', created + 1);
    sql.prepare('INSERT INTO privacy_requests (id,user_id,kind,details,status,created) VALUES (?,?,?,?,?,?)').run('privacy-one', 'user-two', 'deletion', 'Please review this synthetic request', 'open', created);
    // Source ephemeral credentials exist, but must never become export pages.
    sql.prepare('INSERT INTO sessions (digest,user_id,expires) VALUES (?,?,?)').run('SYNTHETIC-DO-NOT-EXPORT', 'user-one', created + 999999);
    const tables = TABLES.map(name => ({name, count: sql.prepare('SELECT COUNT(*) AS n FROM "' + name + '"').get().n, columns: sql.prepare('PRAGMA table_info("' + name + '")').all()}));
    const placeholders = allTables.map(() => '?').join(',');
    const schema = sql.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (' + placeholders + ') ORDER BY type,name').all(...allTables);
    const manifest = {format: 'argyle-export-v1', sourceOrigin: source, pausedSince: new Date(created).toISOString(), expiresAt: new Date(created + 4 * 3600000).toISOString(), tables, excludedTables: excluded, schema};
    await jsonWrite(path.join(exportDir, 'manifest.json'), manifest);
    for (const table of tables) {
      await mkdir(path.join(exportDir, 'tables', table.name), {mode: 0o700});
      const columns = table.columns.map(column => column.name);
      const records = sql.prepare('SELECT rowid AS __fixture_rowid,* FROM "' + table.name + '" ORDER BY rowid').all();
      const chunks = Math.max(1, Math.ceil(records.length / 100));
      for (let index = 0; index < chunks; index++) {
        const page = records.slice(index * 100, (index + 1) * 100);
        const nextCursor = index < chunks - 1 ? String(page.at(-1).__fixture_rowid) : null;
        await jsonWrite(path.join(exportDir, 'tables', table.name, 'page-' + String(index).padStart(6, '0') + '.json'), {table: table.name, columns, rows: page.map(record => columns.map(column => record[column])), nextCursor});
      }
    }
    const objects = [
      {key: photoKey, size: privatePhoto.length, etag: 'a'.repeat(32), uploaded: new Date(created).toISOString(), httpMetadata: {contentType: 'image/png', cacheControl: 'private, no-store'}, customMetadata: {fixture: 'synthetic', description: 'Metadata preserved'}},
      {key: orphanKey, size: orphanPhoto.length, etag: 'b'.repeat(32), uploaded: new Date(created + 1).toISOString(), httpMetadata: {contentType: 'image/webp'}, customMetadata: {}},
    ];
    await jsonWrite(path.join(exportDir, 'inventory.json'), {objects});
    await writeFile(path.join(exportDir, 'objects', sha256(photoKey) + '.bin'), privatePhoto, {mode: 0o600});
    await writeFile(path.join(exportDir, 'objects', sha256(orphanKey) + '.bin'), orphanPhoto, {mode: 0o600});
    const refresh = async () => {
      const files = {};
      const visit = async (directory, prefix = '') => {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
          const relative = prefix + entry.name;
          if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
          else if (!['checksums.json', 'COMPLETE.json'].includes(relative)) files[relative] = sha256(await readFile(path.join(directory, entry.name)));
        }
      };
      await visit(exportDir);
      const checksumBytes = canonical({algorithm: 'SHA-256', files}) + '\n';
      await writeFile(path.join(exportDir, 'checksums.json'), checksumBytes, {mode: 0o600});
      const currentManifest = await jsonRead(path.join(exportDir, 'manifest.json'));
      const currentInventory = await jsonRead(path.join(exportDir, 'inventory.json'));
      await jsonWrite(path.join(exportDir, 'COMPLETE.json'), {format: 'argyle-export-v1', sourceOrigin: source, completedAt: new Date(created + 180000).toISOString(), tables: currentManifest.tables.map(({name, count}) => ({name, count})), objectCount: currentInventory.objects.length, checksumsFile: 'checksums.json', checksumsSha256: sha256(checksumBytes), consistency: 'Maintenance required; repeated table and inventory reads matched. Not a transactional snapshot.'});
    };
    await refresh();
    const editJSON = async (relative, change) => {
      const filename = path.join(exportDir, relative), data = await jsonRead(filename);
      await change(data);
      await jsonWrite(filename, data);
    };
    return {root, exportDir, output, refresh, editJSON, manifest, created, run: overrides => rehearseImport({exportDir, output, expectedSource: source, ...overrides})};
  } finally {sql.close();}
}

async function noSuccess(output) {
  await assert.rejects(stat(path.join(output, 'REHEARSAL.json')), {code: 'ENOENT'});
}

test('offline rehearsal restores durable IDs, relationships, exact text, sparse chat sequences and photo bytes/metadata', async t => {
  const f = await fixture(t, {manyUsers: true});
  const oldFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {networkCalls++; throw new Error('No network in offline rehearsal');};
  t.after(() => {globalThis.fetch = oldFetch;});
  assert.deepEqual(await f.run(), {output: f.output, tables: 10, objects: 2});
  assert.equal(networkCalls, 0);
  const db = new DatabaseSync(path.join(f.output, 'restored.sqlite'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 108);
    assert.equal(db.prepare('SELECT name FROM users WHERE id=?').get('user-one').name, "O’Connor's 名字\nSecond line");
    assert.equal(db.prepare('SELECT privacy_accepted FROM users WHERE id=?').get('user-two').privacy_accepted, null);
    assert.equal(db.prepare('SELECT trip_id FROM replies WHERE id=?').get('reply-one').trip_id, 'trip-one');
    assert.equal(db.prepare('SELECT user_id FROM privacy_requests WHERE id=?').get('privacy-one').user_id, 'user-two');
    assert.equal(db.prepare('SELECT escort_id FROM escorts WHERE trip_id=?').get('trip-one').escort_id, null);
    assert.deepEqual(db.prepare('SELECT seq FROM trip_messages ORDER BY seq').all().map(row => row.seq), [7, 42]);
    db.prepare('INSERT INTO trip_messages (id,trip_id,user_id,body,created) VALUES (?,?,?,?,?)').run('after-restore', 'trip-one', 'user-one', 'Synthetic new message', Date.now());
    assert.ok(db.prepare('SELECT seq FROM trip_messages WHERE id=?').get('after-restore').seq > 42);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const name of excluded) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "' + name + '"').get().n, 0);
  } finally {db.close();}
  assert.deepEqual(await readFile(path.join(f.output, 'objects', sha256(photoKey) + '.bin')), privatePhoto);
  assert.deepEqual(await readFile(path.join(f.output, 'objects', sha256(orphanKey) + '.bin')), orphanPhoto);
  assert.deepEqual(await jsonRead(path.join(f.output, 'inventory.json')), await jsonRead(path.join(f.exportDir, 'inventory.json')));
  const report = await jsonRead(path.join(f.output, 'REHEARSAL.json'));
  assert.equal(report.format, 'argyle-import-rehearsal-v1');
  assert.equal(report.objectCount, 2);
  assert.equal(report.foreignKeys, 'ok');
  assert.equal(report.integrity, 'ok');
  assert.equal(report.excludedTablesEmpty, true);
  assert.equal(report.remoteModified, false);
  assert.equal(report.sourceOrigin, source);
  assert.equal(report.sourceManifestSha256, sha256(await readFile(path.join(f.exportDir, 'manifest.json'))));
  for (const item of report.tables) assert.equal(item.count, f.manifest.tables.find(table => table.name === item.name).count);
  const walk = async directory => {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else assert.equal((await stat(filename)).mode & 0o777, 0o600);
    }
  };
  await walk(f.output);
});

test('completion marker, checksum chain and exact source origin are required before success', async t => {
  for (const alteration of ['missing-complete', 'bad-checksum-file', 'bad-complete-hash', 'wrong-origin', 'completed-after-expiry']) {
    const f = await fixture(t);
    if (alteration === 'missing-complete') await rm(path.join(f.exportDir, 'COMPLETE.json'));
    if (alteration === 'bad-checksum-file') await writeFile(path.join(f.exportDir, 'checksums.json'), '{}');
    if (alteration === 'bad-complete-hash') await f.editJSON('COMPLETE.json', complete => {complete.checksumsSha256 = '0'.repeat(64);});
    if (alteration === 'wrong-origin') await f.editJSON('COMPLETE.json', complete => {complete.sourceOrigin = 'https://wrong.example.invalid';});
    if (alteration === 'completed-after-expiry') await f.editJSON('COMPLETE.json', complete => {complete.completedAt = new Date(f.created + 5 * 3600000).toISOString();});
    await assert.rejects(f.run(), ImportError);
    await noSuccess(f.output);
  }
});

test('corrupt or missing bytes and unchecksummed extras cannot produce a rehearsal report', async t => {
  for (const alteration of ['photo-damaged', 'photo-missing', 'page-damaged', 'extra-file', 'extra-page']) {
    const f = await fixture(t);
    if (alteration === 'photo-damaged') await writeFile(path.join(f.exportDir, 'objects', sha256(photoKey) + '.bin'), 'changed');
    if (alteration === 'photo-missing') await rm(path.join(f.exportDir, 'objects', sha256(photoKey) + '.bin'));
    if (alteration === 'page-damaged') await writeFile(path.join(f.exportDir, 'tables/users/page-000000.json'), '{}');
    if (alteration === 'extra-file') await writeFile(path.join(f.exportDir, 'unexpected.txt'), 'unexpected', {mode: 0o600});
    if (alteration === 'extra-page') await jsonWrite(path.join(f.exportDir, 'tables/users/page-999999.json'), {rows: []});
    await assert.rejects(f.run(), ImportError);
    await noSuccess(f.output);
  }
});

test('checksummed schema drift and source SQL injection are rejected without executing source SQL', async t => {
  for (const alteration of ['schema-sql', 'column-name', 'column-type', 'missing-index', 'unknown-table']) {
    const f = await fixture(t);
    await f.editJSON('manifest.json', manifest => {
      if (alteration === 'schema-sql') manifest.schema.find(item => item.type === 'table' && item.name === 'users').sql += '; DROP TABLE users;';
      if (alteration === 'column-name') manifest.tables.find(table => table.name === 'users').columns[0].name = 'different_id';
      if (alteration === 'column-type') manifest.tables.find(table => table.name === 'users').columns[0].type = 'BLOB';
      if (alteration === 'missing-index') manifest.schema = manifest.schema.filter(item => item.name !== 'users_email_unique');
      if (alteration === 'unknown-table') manifest.tables.push({name: 'sessions', count: 1, columns: []});
    });
    await f.refresh();
    await assert.rejects(f.run(), ImportError);
    await noSuccess(f.output);
  }
});

test('orphan relationships, duplicate IDs/emails, bad counts and unsupported numeric values fail safely', async t => {
  for (const alteration of ['orphan', 'duplicate-id', 'duplicate-email', 'count', 'unsafe-integer']) {
    const f = await fixture(t);
    const target = alteration === 'orphan' ? 'replies' : 'users';
    await f.editJSON('tables/' + target + '/page-000000.json', page => {
      if (alteration === 'orphan') page.rows[0][page.columns.indexOf('trip_id')] = 'NONEXISTENT-SYNTHETIC-TRIP';
      if (alteration === 'duplicate-id') page.rows[1][page.columns.indexOf('id')] = page.rows[0][page.columns.indexOf('id')];
      if (alteration === 'duplicate-email') page.rows[1][page.columns.indexOf('email')] = page.rows[0][page.columns.indexOf('email')];
      if (alteration === 'count') page.rows.pop();
      if (alteration === 'unsafe-integer') page.rows[0][page.columns.indexOf('created')] = Number.MAX_SAFE_INTEGER + 1;
    });
    await f.refresh();
    await assert.rejects(f.run(), error => error instanceof ImportError && !/NONEXISTENT-SYNTHETIC|first@example|SELECT|INSERT INTO|FOREIGN KEY constraint/.test(error.message));
    await noSuccess(f.output);
  }
});

test('valid hashes do not permit missing referenced photos or unexpected inventory keys', async t => {
  for (const alteration of ['missing-reference', 'unknown-key', 'wrong-size']) {
    const f = await fixture(t);
    if (alteration === 'missing-reference') await f.editJSON('tables/users/page-000000.json', page => {page.rows[0][page.columns.indexOf('photo')] = 'profiles/not-in-the-inventory';});
    else await f.editJSON('inventory.json', inventory => {
      if (alteration === 'unknown-key') inventory.objects[0].key = 'other-prefix/file';
      if (alteration === 'wrong-size') inventory.objects[0].size += 1;
    });
    await f.refresh();
    await assert.rejects(f.run(), ImportError);
    await noSuccess(f.output);
  }
});

test('input symlinks, public permissions and checksum path traversal are rejected', async t => {
  for (const alteration of ['input-root-link', 'object-link', 'directory-link', 'public-file', 'public-directory', 'checksum-traversal']) {
    const f = await fixture(t);
    let overrides;
    if (alteration === 'input-root-link') {
      const link = path.join(f.root, 'export-link');
      await symlink(f.exportDir, link);
      overrides = {exportDir: link};
    }
    if (alteration === 'object-link') {
      const name = path.join(f.exportDir, 'objects', sha256(photoKey) + '.bin');
      await rm(name);
      await symlink(path.join(f.root, 'nonexistent-private-file'), name);
    }
    if (alteration === 'directory-link') {
      const name = path.join(f.exportDir, 'tables', 'users');
      await rm(name, {recursive: true});
      await symlink(path.join(f.root, 'nonexistent-private-directory'), name);
    }
    if (alteration === 'public-file') await chmod(path.join(f.exportDir, 'manifest.json'), 0o644);
    if (alteration === 'public-directory') await chmod(path.join(f.exportDir, 'objects'), 0o755);
    if (alteration === 'checksum-traversal') {
      await f.editJSON('checksums.json', checksums => {checksums.files['../outside-private-data'] = '0'.repeat(64);});
      const bytes = await readFile(path.join(f.exportDir, 'checksums.json'));
      await f.editJSON('COMPLETE.json', complete => {complete.checksumsSha256 = sha256(bytes);});
    }
    await assert.rejects(f.run(overrides), ImportError);
    await noSuccess(f.output);
  }
});

test('existing output and repository destinations remain untouched', async t => {
  const f = await fixture(t);
  await mkdir(f.output, {mode: 0o700});
  await writeFile(path.join(f.output, 'keep.txt'), 'keep', {mode: 0o600});
  await assert.rejects(f.run(), ImportError);
  assert.equal(await readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'keep');
  const repositoryTarget = path.resolve('private-rehearsal-must-not-exist');
  await assert.rejects(f.run({output: repositoryTarget}), ImportError);
  await assert.rejects(stat(repositoryTarget), {code: 'ENOENT'});
  const link = path.join(f.root, 'repo-link');
  await symlink(path.resolve('.'), link);
  await assert.rejects(f.run({output: path.join(link, 'private-rehearsal-must-not-exist')}), ImportError);
});

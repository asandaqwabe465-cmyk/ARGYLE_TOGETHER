// Owner-run downloader. This file does not install routes, import records, or deploy.
import {createHash} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {open, mkdir, realpath, lstat, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const TABLES = Object.freeze(['users', 'trips', 'replies', 'escorts', 'alerts', 'incidents', 'incident_flags', 'volunteers', 'trip_messages', 'privacy_requests']);
const EXCLUDED = Object.freeze(['sessions', 'challenges', 'limits', 'locations', 'push_subscriptions', 'push_deliveries']);
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PHOTO = 5 * 1024 * 1024;
const MAX_PAGES = 10000;
const MAX_OBJECTS = 100000;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export class ExportError extends Error {}
const fail = message => {throw new ExportError(message);};
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep);
const same = (a, b) => canonical(a) === canonical(b);

export function validateSource(source) {
  let url;
  try {url = new URL(source);} catch {fail('Source must be one HTTPS origin.');}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') fail('Source must be one HTTPS origin.');
  return url.origin;
}

export async function readCredentials(filename) {
  if (!path.isAbsolute(filename)) fail('Credentials path must be absolute.');
  let handle;
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('Credentials must be a regular private file.');
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const actual = await handle.stat();
    if (!actual.isFile() || (actual.mode & 0o777) !== 0o600 || (process.getuid && actual.uid !== process.getuid()) || actual.size > 16384) fail('Credentials file must be owned by this user with permissions 0600.');
    const credentials = JSON.parse(await handle.readFile('utf8'));
    if (!isObject(credentials) || Object.keys(credentials).some(key => !['token', 'cookie'].includes(key)) || typeof credentials.token !== 'string' || Buffer.byteLength(credentials.token) < 32 || credentials.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(credentials.token)) fail('Credentials file has invalid fields.');
    if (typeof credentials.cookie !== 'string' || !/^argyle_session=[A-Za-z0-9_-]{32,256}$/.test(credentials.cookie)) fail('Credentials must contain only the organiser session cookie.');
    return credentials;
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail('Could not read the private credentials file.');
  } finally {await handle?.close();}
}

async function createOutput(output) {
  if (!path.isAbsolute(output) || output === path.parse(output).root) fail('Output must be a new absolute directory outside the repository.');
  let parent;
  try {parent = await realpath(path.dirname(output));} catch {fail('Output parent directory must already exist.');}
  const resolved = path.join(parent, path.basename(output));
  const repository = await realpath(REPO);
  if (inside(resolved, repository)) fail('Private exports must be stored outside the repository.');
  try {await mkdir(resolved, {mode: 0o700});} catch {fail('Output directory must not already exist.');}
  return resolved;
}

async function writePrivate(filename, bytes) {
  const file = await open(filename, 'wx', 0o600);
  try {await file.writeFile(bytes);} finally {await file.close();}
}
function validateManifest(manifest, source, now) {
  if (!isObject(manifest) || manifest.format !== 'argyle-export-v1' || manifest.sourceOrigin !== source || !Array.isArray(manifest.tables) || !Array.isArray(manifest.excludedTables) || !Array.isArray(manifest.schema)) fail('Source manifest is incompatible.');
  const paused = Date.parse(manifest.pausedSince), expiry = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(paused) || !Number.isFinite(expiry) || paused > now - 120000 || expiry <= now || expiry > paused + 4 * 60 * 60 * 1000) fail('Source export window is invalid or expired.');
  if (!same([...manifest.excludedTables].sort(), [...EXCLUDED].sort())) fail('Source exclusion policy is incompatible.');
  const names = manifest.tables.map(table => table?.name);
  if (!same([...names].sort(), [...TABLES].sort())) fail('Source table inventory is incompatible.');
  for (const table of manifest.tables) {
    if (!integer(table.count) || table.count > 1000000 || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 100) fail('Source table metadata is invalid.');
    const columns = table.columns.map(column => column?.name);
    if (columns.some(column => typeof column !== 'string' || !/^[a-z][a-z0-9_]*$/.test(column)) || new Set(columns).size !== columns.length) fail('Source column metadata is invalid.');
    if (table.name === 'users' && !columns.includes('photo')) fail('Source user photo references are unavailable.');
  }
  const schemaNames = new Set();
  for (const item of manifest.schema) {
    if (!isObject(item) || !['table', 'index'].includes(item.type) || typeof item.name !== 'string' || typeof item.tbl_name !== 'string' || ![...TABLES, ...EXCLUDED].includes(item.tbl_name) || (item.sql !== null && typeof item.sql !== 'string') || schemaNames.has(item.type + ':' + item.name)) fail('Source schema metadata is invalid.');
    schemaNames.add(item.type + ':' + item.name);
  }
  for (const name of [...TABLES, ...EXCLUDED]) if (manifest.schema.filter(item => item.type === 'table' && item.name === name && item.tbl_name === name && typeof item.sql === 'string').length !== 1) fail('Source schema metadata is incomplete.');
}

async function readLimited(response) {
  if (!response.body) fail('Source returned an empty response.');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON) {await reader.cancel(); fail('Source JSON response exceeds the permitted size.');}
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    fail('Source response could not be read.');
  } finally {reader.releaseLock();}
}

function validatePage(page, table, cursor) {
  const columns = table.columns.map(column => column.name);
  if (!isObject(page) || page.table !== table.name || !same(page.columns, columns) || !Array.isArray(page.rows) || page.rows.length > 100) fail('Source table page is invalid.');
  if (page.rows.some(row => !Array.isArray(row) || row.length !== columns.length || row.some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))))) fail('Source table values are unsupported.');
  if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !/^[1-9]\d*$/.test(page.nextCursor) || !Number.isSafeInteger(Number(page.nextCursor)) || Number(page.nextCursor) <= Number(cursor) || !page.rows.length)) fail('Source table cursor is invalid.');
}

function validateObject(object) {
  if (!isObject(object) || typeof object.key !== 'string' || !object.key.startsWith('profiles/') || object.key.length <= 9 || Buffer.byteLength(object.key) > 1024 || /[\x00-\x1f\x7f]/.test(object.key) || !integer(object.size) || object.size <= 0 || object.size > MAX_PHOTO || typeof object.etag !== 'string' || !/^[a-fA-F0-9]{32}(?:-\d+)?$/.test(object.etag) || typeof object.uploaded !== 'string' || !Number.isFinite(Date.parse(object.uploaded)) || !isObject(object.httpMetadata) || !isObject(object.customMetadata)) fail('Source photo metadata is invalid or unsupported.');
}

export async function downloadExport({source, credentialsPath, output, fetchImpl = globalThis.fetch, now = Date.now}) {
  source = validateSource(source);
  const credentials = await readCredentials(credentialsPath);
  const outputRoot = await createOutput(output);
  const checksums = {};
  const request = async (route, params = {}, headers = {}) => {
    const url = new URL('/api/migration-export/' + route, source);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url.href, {method: 'GET', headers: {Authorization: 'Bearer ' + credentials.token, Cookie: credentials.cookie, ...headers}, redirect: 'error', signal: AbortSignal.timeout(30000), cache: 'no-store'});
    } catch {fail('Could not reach the authorised export endpoint.');}
    if (response.redirected || (response.url && new URL(response.url).origin !== source)) {await response.body?.cancel(); fail('Source returned an unexpected redirect.');}
    if (!response.ok) {await response.body?.cancel(); fail('Source rejected an export request (HTTP ' + response.status + ').');}
    return response;
  };
  const json = async (route, params) => {
    const response = await request(route, params);
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {await response.body?.cancel(); fail('Source did not return JSON.');}
    try {return JSON.parse((await readLimited(response)).toString('utf8'));} catch (error) {
      if (error instanceof ExportError) throw error;
      fail('Source returned invalid JSON.');
    }
  };
  const saveJSON = async (relative, value) => {
    const bytes = canonical(value) + '\n';
    await writePrivate(path.join(outputRoot, relative), bytes);
    checksums[relative] = sha256(bytes);
  };

  try {
    const manifest = await json('manifest');
    validateManifest(manifest, source, now());
    await saveJSON('manifest.json', manifest);
    await mkdir(path.join(outputRoot, 'tables'), {mode: 0o700});
    await mkdir(path.join(outputRoot, 'objects'), {mode: 0o700});
    const pageFingerprints = {}, photoReferences = new Set();
    for (const name of TABLES) {
      const table = manifest.tables.find(table => table.name === name);
      await mkdir(path.join(outputRoot, 'tables', name), {mode: 0o700});
      let cursor = '0', count = 0, index = 0;
      pageFingerprints[name] = [];
      do {
        if (index >= MAX_PAGES) fail('Source table pagination exceeded the permitted limit.');
        const page = await json('table', {name, cursor});
        validatePage(page, table, cursor);
        count += page.rows.length;
        if (count > table.count) fail('Source table count changed during export.');
        if (name === 'users') {
          const photoColumn = page.columns.indexOf('photo');
          for (const row of page.rows) {
            const key = row[photoColumn];
            if (typeof key !== 'string') fail('Source photo reference has an unsupported value.');
            if (key) photoReferences.add(key);
          }
        }
        const relative = 'tables/' + name + '/page-' + String(index).padStart(6, '0') + '.json';
        await saveJSON(relative, page);
        pageFingerprints[name].push({cursor, fingerprint: sha256(canonical(page))});
        cursor = page.nextCursor;
        index++;
      } while (cursor !== null);
      if (count !== table.count) fail('Source table count did not match its manifest.');
    }
    const inventory = async () => {
      const objects = [], seenKeys = new Set(), cursors = new Set();
      let cursor;
      do {
        if (cursors.size >= MAX_PAGES) fail('Source photo pagination exceeded the permitted limit.');
        const page = await json('objects', {cursor});
        if (!isObject(page) || !Array.isArray(page.objects) || page.objects.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 8192 || !page.objects.length || cursors.has(page.nextCursor)))) fail('Source photo inventory cursor is invalid.');
        for (const object of page.objects) {
          validateObject(object);
          if (seenKeys.has(object.key)) fail('Source photo inventory contains a duplicate key.');
          seenKeys.add(object.key);
          objects.push(object);
          if (objects.length > MAX_OBJECTS) fail('Source photo count exceeds the permitted limit.');
        }
        cursor = page.nextCursor;
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
      return objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    };
    const objects = await inventory();
    const keys = new Set(objects.map(object => object.key));
    if ([...photoReferences].some(key => !keys.has(key))) fail('A resident photo reference is missing from storage.');
    await saveJSON('inventory.json', {objects});
    for (const object of objects) {
      const response = await request('object', {key: object.key}, {'If-Match': object.etag});
      const receivedEtag = response.headers.get('etag')?.replace(/^"|"$/g, '');
      if (receivedEtag !== object.etag || !response.body) {await response.body?.cancel(); fail('Source photo changed or was not readable.');}
      const filename = 'objects/' + sha256(object.key) + '.bin';
      const partial = path.join(outputRoot, filename + '.partial');
      const file = await open(partial, 'wx', 0o600), hash = createHash('sha256');
      const reader = response.body.getReader();
      let length = 0;
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > object.size || length > MAX_PHOTO) {await reader.cancel(); fail('Source photo size changed during download.');}
          hash.update(value);
          await file.writeFile(value);
        }
        if (length !== object.size) fail('Source photo size did not match its inventory.');
        checksums[filename] = hash.digest('hex');
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof ExportError) throw error;
        fail('Source photo download was interrupted.');
      } finally {reader.releaseLock(); await file.close();}
      await rename(partial, path.join(outputRoot, filename));
    }
    // Repeat reads detect ordinary source mutations; these checks are not an atomic snapshot.
    const finalManifest = await json('manifest');
    validateManifest(finalManifest, source, now());
    if (!same(manifest, finalManifest)) fail('Source manifest changed during export. Keep the source paused and start a new export.');
    for (const name of TABLES) {
      const table = manifest.tables.find(table => table.name === name);
      for (const expected of pageFingerprints[name]) {
        const page = await json('table', {name, cursor: expected.cursor});
        validatePage(page, table, expected.cursor);
        if (sha256(canonical(page)) !== expected.fingerprint) fail('Source records changed during export. Keep the source paused and start a new export.');
      }
    }
    if (!same(objects, await inventory())) fail('Source photo inventory changed during export. Keep the source paused and start a new export.');
    // Re-read private files so the completion marker describes bytes actually stored.
    for (const [relative, expected] of Object.entries(checksums)) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path.join(outputRoot, relative), {flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0)})) hash.update(bytes);
      if (hash.digest('hex') !== expected) fail('Private export file verification failed.');
    }
    await saveJSON('checksums.json', {algorithm: 'SHA-256', files: checksums});
    await writePrivate(path.join(outputRoot, 'COMPLETE.json'), canonical({format: 'argyle-export-v1', sourceOrigin: source, completedAt: new Date(now()).toISOString(), tables: manifest.tables.map(({name, count}) => ({name, count})), objectCount: objects.length, checksumsFile: 'checksums.json', checksumsSha256: checksums['checksums.json'], consistency: 'Maintenance required; repeated table and inventory reads matched. Not a transactional snapshot.'}) + '\n');
    return {output: outputRoot, tables: TABLES.length, objects: objects.length};
  } catch (error) {
    // Incomplete exports retain private files for owner inspection, never a completion marker.
    const {readdir} = await import('node:fs/promises');
    for (const file of await readdir(path.join(outputRoot, 'objects')).catch(() => [])) if (/^[a-f0-9]{64}\.bin\.partial$/.test(file)) await rm(path.join(outputRoot, 'objects', file)).catch(() => {});
    if (error instanceof ExportError) throw error;
    fail('Export stopped before completion. The private output is incomplete.');
  }
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return {help: true};
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = {'--source': 'source', '--credentials': 'credentialsPath', '--output': 'output'}[args[index]];
    if (!key || key in values || typeof args[index + 1] !== 'string' || args[index + 1].startsWith('--')) fail('Use --source, --credentials and --output once each.');
    values[key] = args[index + 1];
  }
  if (Object.keys(values).length !== 3) fail('Use --source, --credentials and --output once each.');
  return values;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node migration/download-export.mjs --source https://ORIGINAL-SITE --credentials /absolute/private-credentials.json --output /absolute/NEW-private-export-directory\nRun only after the original owner has authorised and installed the exporter and confirmed a maintenance window. Credentials file: {"token":"...","cookie":"argyle_session=..."}, owned by you, permissions 0600. Files contain private resident data; keep them outside Git and chat. No import or deployment is performed.');
    else {
      const result = await downloadExport(options);
      console.log('Private export completed: ' + result.tables + ' tables and ' + result.objects + ' photo objects. Verify COMPLETE.json and checksums before any import.');
    }
  } catch (error) {
    console.error(error instanceof ExportError ? error.message : 'Export failed before completion.');
    process.exitCode = 1;
  }
}

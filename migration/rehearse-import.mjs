// Offline only: verifies a private export and rehearses restoration in local SQLite.
// No Cloudflare credentials, network calls, source SQL execution or remote writes.
import {DatabaseSync} from 'node:sqlite';
import {constants, createReadStream} from 'node:fs';
import {lstat, readdir, readFile, mkdir, realpath, open, chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TABLES, canonical, sha256, validateSource} from './download-export.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const excluded = ['sessions','challenges','limits','locations','push_subscriptions','push_deliveries'];
const known = [...TABLES,...excluded];
const hashPattern = /^[a-f0-9]{64}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a,b) => canonical(a) === canonical(b);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const inside = (candidate,root) => candidate === root || candidate.startsWith(root+path.sep);
export class ImportError extends Error {}
function fail(message) {throw new ImportError(message);}

async function noLinks(filename) {
  const absolute=path.resolve(filename), parsed=path.parse(absolute);
  let current=parsed.root;
  for(const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,component);
    if((await lstat(current)).isSymbolicLink())fail('Symbolic links are not allowed in private input or output paths.');
  }
  return absolute;
}
async function privateInventory(root) {
  const files=new Map();
  const walk=async(directory,relative='')=>{
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700||
       (process.getuid&&info.uid!==process.getuid()))fail('Private export directories must be owned by this user with permissions 0700.');
    for(const item of await readdir(directory,{withFileTypes:true})) {
      const name=relative?relative+'/'+item.name:item.name, filename=path.join(directory,item.name);
      const stat=await lstat(filename);
      if(stat.isSymbolicLink())fail('Private exports must not contain symbolic links.');
      if(stat.isDirectory()) {
        if(name!=='tables'&&name!=='objects'&&!TABLES.some(table=>name==='tables/'+table))fail('Unexpected export directory.');
        await walk(filename,name);
      } else {
        if(!stat.isFile()||(stat.mode&0o777)!==0o600||(process.getuid&&stat.uid!==process.getuid()))fail('Private export files must be owned by this user with permissions 0600.');
        if(files.size>=200010)fail('Export file inventory exceeds the permitted limit.');
        files.set(name,{filename,size:stat.size});
      }
    }
  };
  await walk(root);
  return files;
}
async function digest(filename) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(filename,{flags:constants.O_RDONLY|(constants.O_NOFOLLOW||0)}))hash.update(bytes);
  return hash.digest('hex');
}
async function privateWrite(filename,bytes) {
  const handle=await open(filename,'wx',0o600);
  try {await handle.writeFile(bytes);} finally {await handle.close();}
}
function sqlSchema(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name").all()
    .filter(item=>known.includes(item.tbl_name)).map(item=>({...item,sql:item.sql===null?null:item.sql.trim().replace(/\s+/g,' ')}));
}
function checkedSchema(schema) {
  if(!Array.isArray(schema)||schema.length>200)fail('Export schema is incompatible with the trusted migrations.');
  const entries=new Set();
  for(const item of schema) {
    if(!object(item)||!['table','index'].includes(item.type)||typeof item.name!=='string'||!known.includes(item.tbl_name)||
       (item.sql!==null&&typeof item.sql!=='string')||entries.has(item.type+':'+item.name))fail('Export schema is incompatible with the trusted migrations.');
    entries.add(item.type+':'+item.name);
  }
  return schema.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql:sql===null?null:sql.trim().replace(/\s+/g,' ')}))
    .sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
}

export async function rehearseImport({exportDir,output,expectedSource}) {
  let db;
  try {
    const source=validateSource(expectedSource);
    if(!path.isAbsolute(exportDir)||!path.isAbsolute(output))fail('Input and output must be absolute private paths.');
    const root=await noLinks(exportDir), repository=await realpath(repo);
    if(inside(root,repository))fail('Private exports must stay outside the repository.');
    const parent=await noLinks(path.dirname(output)), destination=path.join(await realpath(parent),path.basename(output));
    if(inside(destination,repository)||inside(destination,root)||destination===path.parse(destination).root)fail('Output must be a new private directory outside the repository and input.');
    try {await lstat(destination);fail('Output directory must not already exist.');}catch(error){if(error.code!=='ENOENT')throw error;}
    const files=await privateInventory(root);
    const parsedHashes=new Map();
    let verifiedHashes=null;
    const json=async(name)=>{
      const item=files.get(name);
      if(!item||item.size>2*1024*1024)fail('An export JSON file is missing or too large.');
      const bytes=await readFile(item.filename), hash=sha256(bytes);
      if(verifiedHashes&&verifiedHashes[name]!==hash)fail('An export JSON file changed before it could be read.');
      parsedHashes.set(name,hash);
      return JSON.parse(bytes.toString('utf8'));
    };
    const complete=await json('COMPLETE.json'), checksums=await json('checksums.json');
    if(!object(complete)||complete.format!=='argyle-export-v1'||complete.sourceOrigin!==source||complete.checksumsFile!=='checksums.json'||
       !hashPattern.test(complete.checksumsSha256)||!object(checksums)||checksums.algorithm!=='SHA-256'||!object(checksums.files)||
       parsedHashes.get('checksums.json')!==complete.checksumsSha256)fail('Export completion or checksum information is invalid.');
    const hashedNames=Object.keys(checksums.files), expectedNames=[...hashedNames,'checksums.json','COMPLETE.json'].sort();
    if(!same([...files.keys()].sort(),expectedNames))fail('Export file inventory does not match its checksums.');
    for(const name of hashedNames) {
      const valid=name==='manifest.json'||name==='inventory.json'||TABLES.some(table=>new RegExp('^tables/'+table+'/page-[0-9]{6}\\.json$').test(name))||/^objects\/[a-f0-9]{64}\.bin$/.test(name);
      if(!valid||!hashPattern.test(checksums.files[name])||files.get(name).size>(name.startsWith('objects/')?5*1024*1024:2*1024*1024)||
         await digest(files.get(name).filename)!==checksums.files[name])fail('An export file failed integrity or path validation.');
    }
    verifiedHashes=checksums.files;
    const manifest=await json('manifest.json'), inventory=await json('inventory.json');
    if(!object(manifest)||manifest.format!=='argyle-export-v1'||manifest.sourceOrigin!==source||!Array.isArray(manifest.tables)||
       !same(manifest.tables.map(table=>table?.name).sort(),[...TABLES].sort())||!same([...(manifest.excludedTables||[])].sort(),[...excluded].sort()))fail('Export table scope is incompatible.');
    const since=Date.parse(manifest.pausedSince), until=Date.parse(manifest.expiresAt), completed=Date.parse(complete.completedAt);
    if(!Number.isFinite(since)||!Number.isFinite(until)||!Number.isFinite(completed)||until>since+4*3600000||completed<since+120000||completed>until)fail('Export completion does not fall inside its source window.');
    if(!same(complete.tables,manifest.tables.map(({name,count})=>({name,count}))))fail('Export completion counts do not match the manifest.');
    db=new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    const migrationNames=(await readdir(path.join(repo,'drizzle'))).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
    if(migrationNames.length!==8)fail('Trusted migration set changed; review is required.');
    for(const name of migrationNames)db.exec(await readFile(path.join(repo,'drizzle',name),'utf8'));
    if(!same(checkedSchema(manifest.schema),sqlSchema(db)))fail('Export schema differs from the trusted migrations; reconcile it before import.');
    const expectedFiles=new Set(['manifest.json','inventory.json']);
    const references=new Set();
    const summary=[];
    db.exec('BEGIN');
    for(const name of ['users','trips','replies','escorts','alerts','volunteers','incidents','incident_flags','trip_messages','privacy_requests']) {
      const table=manifest.tables.find(table=>table.name===name);
      const columns=db.prepare('PRAGMA table_info("'+name+'")').all().map(column=>({...column}));
      if(!integer(table.count)||table.count>1000000||!same(table.columns,columns))fail('Export columns or counts differ from the trusted schema.');
      const names=columns.map(column=>column.name);
      const statement=db.prepare('INSERT INTO "'+name+'" ('+names.map(column=>'"'+column+'"').join(',')+') VALUES ('+names.map(()=>'?').join(',')+')');
      let cursor='0', count=0, index=0;
      do {
        if(index>=10000)fail('Export table has too many pages.');
        const filename='tables/'+name+'/page-'+String(index).padStart(6,'0')+'.json';
        expectedFiles.add(filename);
        const page=await json(filename);
        if(!object(page)||page.table!==name||!same(page.columns,names)||!Array.isArray(page.rows)||page.rows.length>100||
           (page.nextCursor!==null&&(typeof page.nextCursor!=='string'||!/^\d+$/.test(page.nextCursor)||!Number.isSafeInteger(Number(page.nextCursor))||Number(page.nextCursor)<=Number(cursor)||page.rows.length===0)))fail('An export table page is invalid.');
        for(const row of page.rows) {
          if(!Array.isArray(row)||row.length!==columns.length)fail('An export row is incompatible.');
          for(let i=0;i<row.length;i++) {
            const value=row[i], column=columns[i];
            if(value===null) {if(column.notnull||column.pk)fail('An export row has a missing required value.');}
            else if(column.type.toUpperCase()==='INTEGER') {if(!Number.isSafeInteger(value))fail('An exported integer cannot be represented safely.');}
            else if(column.type.toUpperCase()==='REAL') {if(typeof value!=='number'||!Number.isFinite(value))fail('An exported number is invalid.');}
            else if(column.type.toUpperCase()==='TEXT') {if(typeof value!=='string')fail('An exported text value is invalid.');}
            else fail('An exported column type needs review.');
          }
          statement.run(...row);
          if(name==='users'&&row[names.indexOf('photo')])references.add(row[names.indexOf('photo')]);
        }
        count+=page.rows.length;
        if(count>table.count)fail('Export row counts do not match.');
        cursor=page.nextCursor;index++;
      }while(cursor!==null);
      if(count!==table.count)fail('Export row counts do not match.');
      summary.push({name,count});
    }
    db.exec('COMMIT');
    if(db.prepare('PRAGMA foreign_key_check').all().length)fail('Restored relationships failed verification.');
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail('Restored database failed integrity verification.');
    for(const name of excluded)if(db.prepare('SELECT COUNT(*) AS n FROM "'+name+'"').get().n!==0)fail('Temporary authentication or notification state must remain empty.');
    if(!object(inventory)||!Array.isArray(inventory.objects)||inventory.objects.length>100000||complete.objectCount!==inventory.objects.length)fail('Photo inventory is incompatible.');
    const keys=new Set();
    for(const item of inventory.objects) {
      if(!object(item)||typeof item.key!=='string'||!item.key.startsWith('profiles/')||item.key.length<=9||Buffer.byteLength(item.key)>1024||/[\x00-\x1f\x7f]/.test(item.key)||keys.has(item.key)||
         !integer(item.size)||item.size===0||item.size>5*1024*1024||typeof item.etag!=='string'||!object(item.httpMetadata)||!object(item.customMetadata))fail('Photo inventory metadata is invalid.');
      keys.add(item.key);
      const filename='objects/'+sha256(item.key)+'.bin';
      if(!files.has(filename)||files.get(filename).size!==item.size)fail('A photo file is missing or has the wrong size.');
      expectedFiles.add(filename);
    }
    if([...references].some(key=>!keys.has(key)))fail('A resident photo reference is missing from the inventory.');
    if(!same([...expectedFiles].sort(),[...hashedNames].sort()))fail('Export contains unexpected files or incomplete table pages.');
    await mkdir(destination,{mode:0o700});
    const databasePath=path.join(destination,'restored.sqlite');
    db.prepare('VACUUM INTO ?').run(databasePath);
    await chmod(databasePath,0o600);
    await mkdir(path.join(destination,'objects'),{mode:0o700});
    for(const item of inventory.objects) {
      const filename='objects/'+sha256(item.key)+'.bin';
      const bytes=await readFile(files.get(filename).filename);
      if(sha256(bytes)!==checksums.files[filename])fail('A photo changed while preparing the rehearsal.');
      await privateWrite(path.join(destination,filename),bytes);
    }
    await privateWrite(path.join(destination,'inventory.json'),canonical(inventory)+'\n');
    // Verify the stored database, not just the in-memory rehearsal.
    const restored=new DatabaseSync(databasePath,{readOnly:true});
    try {
      if(restored.prepare('PRAGMA foreign_key_check').all().length||restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail('Stored rehearsal failed database verification.');
      for(const {name,count} of summary)if(restored.prepare('SELECT COUNT(*) AS n FROM "'+name+'"').get().n!==count)fail('Stored rehearsal row counts differ.');
    }finally{restored.close();}
    const report={format:'argyle-import-rehearsal-v1',sourceOrigin:source,sourceManifestSha256:checksums.files['manifest.json'],
      tables:summary,objectCount:keys.size,foreignKeys:'ok',integrity:'ok',excludedTablesEmpty:true,remoteModified:false,
      note:'Offline rehearsal only. Internal checksums do not prove owner authorisation, private transfer or source quiescence.'};
    await privateWrite(path.join(destination,'REHEARSAL.json'),canonical(report)+'\n');
    return {output:destination,tables:TABLES.length,objects:keys.size};
  }catch(error){
    if(error instanceof ImportError)throw error;
    fail('Import rehearsal stopped before completion. No remote resources were changed; any private output is incomplete.');
  }finally{db?.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.length===1&&args[0]==='--help')console.log('Offline only: node migration/rehearse-import.mjs --source https://ORIGINAL-SITE --export /absolute/private/export --output /absolute/NEW-private-rehearsal');
    else {
      const options={};
      for(let i=0;i<args.length;i+=2) {
        const key={'--source':'expectedSource','--export':'exportDir','--output':'output'}[args[i]];
        if(!key||key in options||!args[i+1]||args[i+1].startsWith('--'))fail('Use --source, --export and --output once each.');
        options[key]=args[i+1];
      }
      if(Object.keys(options).length!==3)fail('Use --source, --export and --output once each.');
      const result=await rehearseImport(options);
      console.log('Offline import rehearsal passed: '+result.tables+' tables, '+result.objects+' photos. No remote resources changed.');
    }
  }catch(error){console.error(error instanceof ImportError?error.message:'Import rehearsal failed.');process.exitCode=1;}
}

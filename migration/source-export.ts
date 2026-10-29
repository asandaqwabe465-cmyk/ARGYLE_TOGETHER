/**
 * Temporary, owner-reviewed source-side export capability.
 * This module is deliberately not connected to the application router.
 * Reads span multiple requests: a real maintenance window and downloader
 * verification are required; the clock guard is not a snapshot guarantee.
 */
export type MigrationBindings = {
  DB?: D1Database;
  BUCKET?: R2Bucket;
  MIGRATION_READ_ONLY?: string;
  MIGRATION_EXPORT_ENABLED?: string;
  MIGRATION_EXPORT_SECRET?: string;
  MIGRATION_READ_ONLY_SINCE?: string;
  MIGRATION_EXPORT_EXPIRES_AT?: string;
};

const tables = [
  "users", "trips", "replies", "escorts", "alerts", "incidents",
  "incident_flags", "volunteers", "trip_messages", "privacy_requests",
] as const;
const excludedTables = [
  "sessions", "challenges", "limits", "locations",
  "push_subscriptions", "push_deliveries",
] as const;
const knownTables = new Set<string>([...tables, ...excludedTables]);
const exportPath = "/api/migration-export";
const pageSize = 100;
const encoder = new TextEncoder();
const securityHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...securityHeaders, ...headers } });
}

function unavailable() {
  return json({ error: "The migration export is temporarily unavailable." }, 503);
}

function isoTime(value: unknown): number | null {
  // An explicit timezone is mandatory; locale-dependent dates are rejected.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  const calendarDay = Date.parse(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== value.slice(0, 10) ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  return Number.isFinite(time) ? time : null;
}

function enabled(bindings: MigrationBindings) {
  const since = isoTime(bindings.MIGRATION_READ_ONLY_SINCE);
  const expires = isoTime(bindings.MIGRATION_EXPORT_EXPIRES_AT);
  const now = Date.now();
  return bindings.MIGRATION_READ_ONLY === "true" &&
    bindings.MIGRATION_EXPORT_ENABLED === "true" &&
    typeof bindings.MIGRATION_EXPORT_SECRET === "string" &&
    bindings.MIGRATION_EXPORT_SECRET.length <= 4096 &&
    !/[\s\u0000-\u001f\u007f]/u.test(bindings.MIGRATION_EXPORT_SECRET) &&
    encoder.encode(bindings.MIGRATION_EXPORT_SECRET).length >= 32 &&
    since !== null && expires !== null &&
    since <= now - 120_000 && expires > now && expires <= since + 4 * 60 * 60 * 1000;
}

async function tokenMatches(request: Request, secret: string) {
  const authorization = request.headers.get("Authorization");
  if (!authorization || authorization.length > 8192) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const a = new Uint8Array(provided), b = new Uint8Array(expected);
  let different = 0;
  for (let i = 0; i < 32; i++) different |= a[i] ^ b[i];
  return different === 0;
}

async function readAll(db: D1Database, sql: string, ...values: unknown[]) {
  const result = await db.prepare(sql).bind(...values).all<Record<string, unknown>>();
  if (!result.success || !Array.isArray(result.results)) throw new Error("Read failed");
  return result.results;
}

async function tableColumns(db: D1Database, name: string) {
  // Identifiers reach this function only from the fixed table allowlist.
  const columns = await readAll(db, `PRAGMA table_info("${name}")`);
  if (!columns.length || columns.some(column => typeof column.name !== "string")) throw new Error("Schema unavailable");
  const reserved = new Set(["__migration_rowid", "rowid", "_rowid_", "oid"]);
  if (columns.some(column => reserved.has((column.name as string).toLowerCase()))) throw new Error("Unreviewed schema");
  return columns;
}

async function manifest(url: URL, bindings: MigrationBindings, db: D1Database) {
  const discovered = await readAll(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  for (const { name } of discovered) {
    if (typeof name !== "string") throw new Error("Schema unavailable");
    if (!knownTables.has(name) && !name.startsWith("sqlite_") &&
        !name.startsWith("_cf") && name !== "d1_migrations" &&
        name !== "__drizzle_migrations") throw new Error("Unreviewed table");
  }
  if ([...knownTables].some(name => !discovered.some(table => table.name === name))) throw new Error("Missing application table");
  const descriptions = [];
  for (const name of tables) {
    const columns = await tableColumns(db, name);
    const count = await db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).first<{ count: number }>();
    if (!count || !Number.isSafeInteger(count.count) || count.count < 0) throw new Error("Invalid row count");
    descriptions.push({ name, count: count.count, columns });
  }
  const placeholders = [...knownTables].map(() => "?").join(",");
  const schema = await readAll(db,
    `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (${placeholders}) ORDER BY type,name`,
    ...knownTables);
  return json({
    format: "argyle-export-v1",
    sourceOrigin: url.origin,
    pausedSince: bindings.MIGRATION_READ_ONLY_SINCE,
    expiresAt: bindings.MIGRATION_EXPORT_EXPIRES_AT,
    tables: descriptions,
    excludedTables: [...excludedTables],
    schema,
  });
}

async function tablePage(url: URL, db: D1Database) {
  const name = url.searchParams.get("name");
  const cursor = url.searchParams.get("cursor") ?? "0";
  if (url.searchParams.getAll("name").length !== 1 ||
      url.searchParams.getAll("cursor").length > 1 ||
      !tables.some(table => table === name) || !/^(0|[1-9][0-9]*)$/.test(cursor) ||
      !Number.isSafeInteger(Number(cursor))) return json({ error: "Invalid export request." }, 400);
  const columns = (await tableColumns(db, name!)).map(column => column.name as string);
  const records = await readAll(db,
    `SELECT rowid AS "__migration_rowid", * FROM "${name}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    Number(cursor), pageSize + 1);
  for (const record of records) {
    if (!Number.isSafeInteger(record.__migration_rowid) || Number(record.__migration_rowid) <= Number(cursor)) throw new Error("Invalid row cursor");
  }
  const page = records.slice(0, pageSize);
  return json({
    table: name,
    columns,
    rows: page.map(record => columns.map(column => record[column])),
    nextCursor: records.length > pageSize ? String(page[page.length - 1].__migration_rowid) : null,
  });
}

function validObjectKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith("profiles/") &&
    key.length > "profiles/".length && !/[\u0000-\u001f\u007f]/.test(key) && encoder.encode(key).length <= 1024;
}

async function objectsPage(url: URL, bucket: R2Bucket) {
  const cursor = url.searchParams.get("cursor");
  if (url.searchParams.getAll("cursor").length > 1 ||
      (cursor !== null && (!cursor || cursor.length > 4096))) return json({ error: "Invalid export request." }, 400);
  // The pinned Workers typings omit R2's supported metadata-inclusion option.
  const options: R2ListOptions & { include: ("httpMetadata" | "customMetadata")[] } = {
    limit: pageSize, ...(cursor ? { cursor } : {}), include: ["httpMetadata", "customMetadata"],
  };
  const page = await bucket.list(options);
  if (page.objects.some(object => !validObjectKey(object.key))) throw new Error("Unreviewed object key");
  if (page.truncated && !page.cursor) throw new Error("Missing object cursor");
  return json({
    objects: page.objects.map(object => ({
      key: object.key,
      size: object.size,
      etag: object.etag,
      uploaded: object.uploaded.toISOString(),
      httpMetadata: object.httpMetadata ?? {},
      customMetadata: object.customMetadata ?? {},
    })),
    nextCursor: page.truncated ? page.cursor : null,
  });
}

async function objectBody(url: URL, request: Request, bucket: R2Bucket) {
  const key = url.searchParams.get("key");
  if (url.searchParams.getAll("key").length !== 1 || !validObjectKey(key)) return json({ error: "Invalid export request." }, 400);
  const conditional = request.headers.get("If-Match");
  let etag: string | undefined;
  if (conditional !== null) {
    const match = /^(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))$/.exec(conditional);
    if (!match || conditional.length > 256) return json({ error: "Invalid export request." }, 400);
    etag = match[1] ?? match[2];
  }
  const object = await bucket.get(key, etag ? { onlyIf: { etagMatches: etag } } : {});
  if (!object) return json({ error: "Object not found." }, 404);
  if (!("body" in object) || (etag !== undefined && object.etag !== etag)) {
    if ("body" in object) await object.body.cancel();
    return json({ error: "Object changed. Restart the export." }, 412);
  }
  return new Response(object.body, {
    headers: {
      ...securityHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
    },
  });
}

/** Call before any existing API handler, including GET cleanup/push handlers. */
export async function migrationGate(
  request: Request,
  bindings: MigrationBindings,
  authorizeOwner: () => Promise<boolean>,
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const isExport = url.pathname === exportPath || url.pathname.startsWith(exportPath + "/");
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (!isExport) {
      if (isApi && bindings.MIGRATION_READ_ONLY === "true") return json({
        error: "The app is temporarily paused for a data migration. For urgent help, contact emergency services or the organiser directly.",
      }, 503, { "Retry-After": "120" });
      return null;
    }
    if (!enabled(bindings)) return json({ error: "Not found." }, 404);
    if (!["/manifest", "/table", "/objects", "/object"].some(route => url.pathname === exportPath + route)) return json({ error: "Not found." }, 404);
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) return json({ error: "Export access denied." }, 403);
    if (!await tokenMatches(request, bindings.MIGRATION_EXPORT_SECRET!)) return json({ error: "Export access denied." }, 401);
    if (!await authorizeOwner()) return json({ error: "Export access denied." }, 403);
    const allowedParameters: Record<string, string[]> = {
      "/manifest": [], "/table": ["name", "cursor"], "/objects": ["cursor"], "/object": ["key"],
    };
    const permitted = allowedParameters[url.pathname.slice(exportPath.length)];
    if ([...url.searchParams.keys()].some(key => !permitted.includes(key) || url.searchParams.getAll(key).length !== 1)) {
      return json({ error: "Invalid export request." }, 400);
    }
    if (!bindings.DB || !bindings.BUCKET) return unavailable();
    if (url.pathname === exportPath + "/manifest") return await manifest(url, bindings, bindings.DB);
    if (url.pathname === exportPath + "/table") return await tablePage(url, bindings.DB);
    if (url.pathname === exportPath + "/objects") return await objectsPage(url, bindings.BUCKET);
    return await objectBody(url, request, bindings.BUCKET);
  } catch {
    return unavailable();
  }
}

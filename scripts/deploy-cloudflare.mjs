import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const configIndex = args.indexOf("--config");
const configName = configIndex === -1
  ? (dryRun ? "wrangler.cloudflare.json" : "wrangler.cloudflare.local.json")
  : args[configIndex + 1];
const rest = args.filter((_, i) => i !== configIndex && (configIndex === -1 || i !== configIndex + 1));
if (!configName || rest.some(arg => arg !== "--dry-run")) {
  console.error("Usage: node scripts/deploy-cloudflare.mjs [--dry-run] [--config file.json]");
  process.exit(64);
}

const configPath = path.resolve(root, configName);
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  console.error("Cloudflare configuration is missing or invalid. Read CLOUDFLARE-DEPLOYMENT.md.");
  process.exit(78);
}
for (const relative of [config.main, config.assets?.directory]) {
  if (!relative || !existsSync(path.resolve(path.dirname(configPath), relative))) {
    console.error("The Worker build is missing. Run npm run build first.");
    process.exit(78);
  }
}

if (!dryRun) {
  const database = config.d1_databases?.find(item => item.binding === "DB");
  const bucket = config.r2_buckets?.find(item => item.binding === "BUCKET");
  const accountId = config.account_id;
  let origin;
  try { origin = new URL(config.vars?.APP_ORIGIN); } catch {}
  const placeholder = "00000000-0000-4000-8000-000000000000";
  const realId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const validOrigin = origin && origin.protocol === "https:" &&
    !origin.username && !origin.password && !origin.search && !origin.hash &&
    origin.pathname === "/" && origin.hostname.includes(".") &&
    !origin.hostname.endsWith(".chatgpt.site") &&
    origin.hostname !== "chatgpt.site";
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") ||
      !database || !realId.test(database.database_id ?? "") ||
      database.database_id === placeholder || !bucket?.bucket_name || !validOrigin) {
    console.error("Deployment stopped: configure your own Cloudflare account ID, real D1 ID, R2 bucket, and HTTPS APP_ORIGIN in the local config. The template is for local checks only.");
    process.exit(78);
  }
}

const runtime = path.join(root, ".sites-runtime");
const xdg = process.env.XDG_CONFIG_HOME || path.join(runtime, "xdg-config");
mkdirSync(xdg, { recursive: true });
const wranglerArgs = [
  "--import", path.join(root, "scripts/sites-env.mjs"),
  path.join(root, "node_modules/wrangler/bin/wrangler.js"),
  "deploy", "--config", configPath,
  ...(dryRun ? ["--dry-run", "--outdir", path.join(runtime, "cloudflare-dry-run")] : []),
];
const result = spawnSync(process.execPath, wranglerArgs, {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    CLOUDFLARE_CF_FETCH_ENABLED: process.env.CLOUDFLARE_CF_FETCH_ENABLED ?? "false",
    WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? "false",
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

# Hosting Argyle Together on your own Cloudflare account

This path uses the existing Worker, D1 database interface and R2 photo storage.
A normal address is `https://argyle-together.<your-subdomain>.workers.dev`.
A domain you own can be connected separately. Neither requires a `.chatgpt.site`
address or access to the original Sites account for future deployments.

The original Site remains a separate live service. This configuration does not
transfer its ownership, URL, database, photos, secrets or Google account.

## Current state

- `wrangler.cloudflare.json` is a standalone, local-testable template. Its D1 ID
  is deliberately a placeholder, and it has no production credentials.
- `scripts/deploy-cloudflare.mjs --dry-run` checks deployment packaging without
  publishing or creating resources. A real deployment defaults to the ignored
  `wrangler.cloudflare.local.json` and rejects missing account/database/origin
  configuration before invoking Wrangler.
- The app's resident sign-in is its own email-code flow. It does not require
  ChatGPT sign-in. Existing starter helpers are unrelated to resident accounts.
- Resident features are preserved. This hosting branch updates the privacy
  notice for Cloudflare hosting and describes verification email conditionally.
  The original `.openai/hosting.json` and original Site remain unchanged.

## Local validation without a Cloudflare account

Use the existing checkout and Node >=22.13.0. From the repository root:

```sh
export npm_config_cache="$PWD/.sites-runtime/npm-cache"
export XDG_CONFIG_HOME="$PWD/.sites-runtime/xdg-config"
mkdir -p "$npm_config_cache" "$XDG_CONFIG_HOME"

# Only install/rebuild if dependencies or build output need refreshing.
npm run install:ci
npm run build
node scripts/deploy-cloudflare.mjs --dry-run

# Separate local state for the standalone hosting rehearsal; never add --remote.
CI=1 node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --config wrangler.cloudflare.json --persist-to .wrangler/cloudflare-local
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev --local --config wrangler.cloudflare.json --persist-to .wrangler/cloudflare-local --ip 127.0.0.1 --port 8790 --inspector-port 0
```

The migrations create an empty local database, not a copy of production. Startup
checks: `/` and `/privacy` render with status 200; `/api/session` returns 200 with
`user:null` and `authReady:false`; `/api/trips` rejects signed-out access with 401.
Sign-in requests fail with 503 while account secrets are absent. Requests with a
mismatched Origin are rejected with 403. Static assets and PWA files should load.
Do not share a loopback address as a user-facing preview.

Existing synthetic tests remain relevant:

```sh
node --test tests/integration.mjs tests/pwa.test.mjs tests/gmail-relay.test.mjs tests/push-runtime.test.mjs
node --experimental-strip-types --test tests/policy.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

## Account and destination resources

1. Create your own Cloudflare account and confirm Workers, D1 and R2 availability
   and applicable pricing/billing requirements. Review costs before provisioning.
2. Authenticate Wrangler in an interactive session you control, or connect a
   scoped Cloudflare API token securely in the execution environment. Never put
   token values in source or chat. Verify that Wrangler is using your account.
3. Create a new D1 database and private R2 bucket in that account. The original
   Sites-managed resources are not automatically accessible from this account.
4. Copy `wrangler.cloudflare.json` to `wrangler.cloudflare.local.json` in the
   repository root. Set `account_id` to your account's ID; replace the DB name/ID
   and bucket name with the new resources. Keep bindings named `DB` and `BUCKET`.
5. Set non-secret `vars` in the local config, including the actual HTTPS
   `APP_ORIGIN`, `ADMIN_EMAIL`, and `EMAIL_PROVIDER` (`gmail` for the current
   relay setup). Use your account's Workers subdomain for the new address, or
   configure a domain you own. `APP_ORIGIN` must be correct before sending emails:
   the old code has an original-Site fallback for volunteer approval links.

An account ID, database ID and public URL are not credentials. Keep authentication
keys and application secrets in the appropriate private settings rather than
inside `vars` or committed files. The local config is ignored to avoid accidental
publication of environment-specific configuration.

## Preserve existing resident data before cutover

The source ZIP and SQL migrations do not contain resident records or photos.
The user has chosen to retain existing accounts, trip history and photos.
This source preparation does not establish that a complete supported export from
the original Site is available.

Support has not supplied a supported export procedure. A custom source-side
export proposal is prepared in `migration/OWNER-REVIEW.md`; it is deliberately
not connected to the app's routes. The original owner must review and authorise
installation, data scope, a private transfer and any maintenance window before
it is used. This is separate from a Sites-provided backup or an ownership
transfer, and live bucket access and export consistency remain unverified.
Obtain an authorised, consistent database export and complete photo export
before planning a live cutover. Transfer resident data privately; do not put it
in GitHub or source attachments.

Before importing, inspect whether the export includes schema and migration
metadata. Do not apply table-creation migrations over a full schema dump. Restore
with the backup's supported procedure, preserve user IDs/relationships and photo
object keys, and compare row counts, relationships and object checksums. Plan a
maintenance/read-only window or verified final copy so new changes are retained.
Keep a rollback backup and the original Site operational until acceptance checks
pass. An empty destination database is not a completed migration.

## Private app configuration and acceptance checks

Configure server secrets privately in your Cloudflare Worker settings:

- `AUTH_SECRET` and `RESIDENCE_INVITE_CODE`.
- `GMAIL_RELAY_URL` and `GMAIL_RELAY_SECRET` for the existing Gmail mode, with
  `EMAIL_PROVIDER=gmail`. The Google relay owner must authorise continued use;
  its Script Property `RELAY_SECRET` must match. Source does not transfer Google
  account ownership or its deployment authorisation.
- `VAPID_PRIVATE_KEY` (JSON JWK text), `VAPID_PUBLIC_KEY`, and `VAPID_SUBJECT` for
  Web Push. Public key/contact values may be ordinary server variables.
- Optional `ESCORT_EMAILS`; `RESEND_API_KEY` and `EMAIL_FROM` only if intentionally
  switching to the alternative email provider.

Decide how to invalidate old sessions/challenges and pending notification queues
as part of the data migration. A new origin requires residents to sign in again
and re-enable/install notifications; copied push subscriptions alone do not make
notifications work on the new origin. Preserve or rotate signing keys deliberately.

After configuring real resource IDs and `APP_ORIGIN`, rebuild the current source
immediately before every deployment, run the checks above, and then dry-run your
local deployment config. The helper checks that output exists; it does not
rebuild it automatically:

```sh
npm run build
node scripts/deploy-cloudflare.mjs --dry-run --config wrangler.cloudflare.local.json
```

A deliberate deployment uses:

```sh
node scripts/deploy-cloudflare.mjs
```

That last command publishes to Cloudflare. Do not use it as a local check or
assume it imports data or completes email configuration. Public access should
be announced only after testing login, organiser permissions, restored photos,
trip/chat/history, privacy requests, actual email delivery and real-device push
with consenting test users. Review provider/storage details and the privacy
notice for the new deployment before launch. Confirm the new address is
used in emails and resident instructions. The historical PDF generator needs
review before regeneration and contains an old URL.

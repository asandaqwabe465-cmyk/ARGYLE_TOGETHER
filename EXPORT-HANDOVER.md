# Argyle Together source handover

Prepared 27 October 2026. Read this before the older setup documents: those documents preserve project history and may describe the earlier residence-domain proposal. Management declined that proposal. The app is independently operated by Asanda Qwabe; no residence security participation has been confirmed in this review.

## What this archive is

A snapshot of current files on disk, not just the last Git commit. Tracked files, tracked modifications and eligible untracked project files are included. No Git history, installed dependencies, generated builds, live database records, local database state, uploaded resident photos, environment secret values or provider credentials are included. `.env.example` is deliberately blank. Synthetic test fixtures are not production credentials.

`EXPORT-MANIFEST.json` records the source commit, working-copy status, file hashes and exclusions. The untracked resident-guide builder is included under `tmp/pdfs/`; its configuration is replaced by a blank template. The generated guide PDF/screenshots are excluded because they contain the shared residence invitation code. The guide is historical and needs updating for the privacy changes before being regenerated for residents.

Editor buffers that have not been saved to disk cannot be captured by this filesystem export. Save them and request an updated archive if needed.

## Hosting and ownership map

| Component | Current implementation | Where to look |
|---|---|---|
| Website/API | OpenAI Sites publication running on Cloudflare Workers | `.openai/hosting.json`, `vite.config.ts`, `build/sites-vite-plugin.ts` |
| Records | Cloudflare D1, binding `DB`, managed through Sites | `db/schema.ts`, `drizzle/`, `lib/server.ts` |
| Resident authentication | App-owned email OTP and cookie sessions running in the Worker; users, challenges and session digests stored in D1 | `lib/server.ts` |
| Uploaded photos | Cloudflare R2, binding `BUCKET`, managed through Sites | `/api/photo` in `lib/server.ts`; keys use `profiles/<user-id>` |
| Verification emails | Google Apps Script Web App using MailApp/Gmail, currently under argyletogether@gmail.com | `integrations/google-apps-script/Code.gs`, `lib/gmail.ts`, `GMAIL-SETUP.md` |
| Optional future email provider | Resend; present in source but not the active verification provider | `EMAIL-SETUP.md`, `lib/server.ts` |
| Phone notifications | Browser Web Push providers with VAPID credentials | `lib/push.ts`, `public/sw.js`, `app/phone-setup.tsx` |

The latest saved Site version observed is 12. The current live URL is https://argyle-walk-together.sweet-cream-7564.chatgpt.site/ . The existing Site identity is retained in `.openai/hosting.json` as provenance and for authorised continuation. It is not an access credential and copying it does not grant the new account access. The physical storage jurisdictions and provider backup/log retention have not been verified.

The Sites database overview confirmed 16 application tables: alerts, challenges, escorts, incident_flags, incidents, limits, locations, privacy_requests, push_deliveries, push_subscriptions, replies, sessions, trip_messages, trips, users, volunteers. No rows were read or exported for this handover.

The Google account and Apps Script deployment are separate from the ChatGPT account. Creating another ChatGPT account does not move the Gmail account, sender deployment or Script Properties. The relay source currently checks the sender account explicitly; changing senders requires reviewing those checks and reauthorising/redeploying the Google script.

## Environment variable names

Do not paste values into ChatGPT or put them in source. Configure them directly in the target's server-side secret/environment settings. Changing local `.env` alone does not update production.

| Name | Purpose |
|---|---|
| `AUTH_SECRET` | HMAC signing/digest secret for app OTP/session verification and related checks |
| `RESIDENCE_INVITE_CODE` | Shared first-registration admission code; not a personal emailed OTP |
| `ADMIN_EMAIL` | Organiser identity for restricted admin operations; this does not change the public support email |
| `APP_ORIGIN` | Deployed app origin used in links and notification behaviour |
| `EMAIL_PROVIDER` | Selects Gmail relay mode or the retained Resend path |
| `GMAIL_RELAY_URL` | Deployed Apps Script Web App endpoint |
| `GMAIL_RELAY_SECRET` | HMAC secret matching the relay Script Property |
| `VAPID_PRIVATE_KEY` | Private Web Push signing key; this implementation expects JSON JWK text |
| `VAPID_PUBLIC_KEY` | Matching base64url Web Push application-server public key |
| `VAPID_SUBJECT` | Web Push contact identifier |
| `ESCORT_EMAILS` | Optional server-side approved-escort allowlist; database-approved volunteers work separately |
| `RESEND_API_KEY` | Required only when enabling the Resend email path |
| `EMAIL_FROM` | Sender address required for the Resend email path |

The first ten names above are present in the production environment metadata. The final three are supported optional/alternative settings. `DB` and `BUCKET` are platform-provisioned resource bindings, not ordinary text secrets. The Google Apps Script project additionally needs Script Property `RELAY_SECRET`; it must match the server's `GMAIL_RELAY_SECRET`. Do not include that property value in code.

Build/runtime helper flags such as `SITES_MANAGED_LINUX_CONTAINER`, `CLOUDFLARE_CF_FETCH_ENABLED`, `SITES_RUNTIME_ROOT`, `SITES_INSTALL_REPORT_PATH`, `WRANGLER_LOG_PATH`, `WRANGLER_REGISTRY_PATH`, `WRANGLER_SEND_METRICS`, `WRANGLER_WRITE_LOGS`, `MINIFLARE_REGISTRY_PATH` and Sharp/npm installation flags are tooling settings, not app account credentials. Preserve the supported Sites workflow rather than supplying guessed platform settings.

## Start development in the new account

1. Upload this ZIP and ask the assistant to read this document, `docs/PRIVACY-REVIEW.md`, `SETUP.md` and `package.json`. Extract it to a dedicated working folder.
2. Decide whether the new account will be authorised to edit the EXISTING Site or will create a SEPARATE Site. Do not deploy from the new account until this is resolved. Keep the original Site operational.
3. Use the available Sites plugin and its supported source/hosting workflow. For an existing Site, it must first verify access. Public visitor access is not editor access.
4. Use Node.js 22.13 or later, preserve `package-lock.json`, and install dependencies with the supported installer or `npm run install:ci`. Generated runtime files and dependencies intentionally are not in the ZIP. A clean checkout defaults to portable mode; let Sites configure its execution profile if the destination environment requires it.
5. Create a private local `.env` from the blank `.env.example` and configure only the settings needed for local testing. Never use production residents or send real panic alerts for tests. Local D1 and R2 are separate from production; apply the included migrations only to the intended database using the documented platform workflow.
6. Validate with `node --test tests/integration.mjs tests/pwa.test.mjs tests/gmail-relay.test.mjs`, `node --experimental-strip-types --test tests/policy.test.ts`, and `node node_modules/typescript/bin/tsc --noEmit`. Runtime Web Push regression coverage is in `tests/push-runtime.test.mjs`. Build with the supported Sites build helper or `npm run build` for the configured profile. Preview with `npm run dev`.
7. Browser/Cloudflare APIs are required. This is not a static HTML-only site. Hosting outside Sites requires adapting provisioning/deployment configuration while preserving the app's Workers/D1/R2 behaviour.

The source contains generic ChatGPT sign-in helpers inherited from the starter, but resident login uses the app's own email OTP flow. Do not replace resident authentication with ChatGPT authentication merely because those helpers exist.

## Can existing accounts and data be retained?

Yes in principle, but the source ZIP alone is not a data backup or account transfer.

### Preferred route: continue using the existing Site and resources

Check whether the new account can be added as an eligible editor using Sites access settings, or ask Sites support about a supported ownership transfer. Availability and eligibility must be confirmed; this export has not granted access or transferred ownership. A normal public visitor link gives no administrative rights. Keep the same database, R2 bucket, app identity, origin and server configuration. Once the new account's editing/deployment access and resource continuity are verified, existing resident records remain in those resources. There is no need to re-create resident accounts merely to change the developer account. Do not delete the old ChatGPT account or Site until ownership/access implications are confirmed.

### Alternative route: create a new deployment and migrate

1. Obtain a supported, consistent D1 export and R2 object export from the current hosting owner/provider. Sites tools can inspect database tables, but the tools reviewed here do not provide a complete transactional D1-plus-R2 backup/import or cross-account transfer. Confirm supported export/import access with Sites support; do not assume a personal Cloudflare login can manage Sites-owned resources.
2. Plan a maintenance/read-only cutover or a verified final incremental copy so new registrations and messages are not lost during migration. Keep a rollback backup. Transfer personal data privately, not inside a ChatGPT source ZIP.
3. Provision the new Site and its own resource bindings. In a NEW project copy, replace the old Site identity using the supported new-site workflow; never overwrite or delete the original Site's identity to force a transfer. Apply schema/migrations consistently with the chosen backup method, preserving existing migration history and avoiding duplicate table creation.
4. Import persistent records with original user IDs, trip IDs and relationships intact. This preserves account profiles, volunteer approvals, trips, history, chat, reports and privacy requests. Copy R2 objects at their original keys and verify `users.photo` references. SQL migrations in this ZIP define structure only; they contain no resident records.
5. Reconfigure secrets privately in the destination. Preserve `AUTH_SECRET` only when deliberately retaining compatible session/challenge digests; otherwise invalidate old sessions/challenges and have residents request fresh email codes. Rotating it does not require discarding persistent user profiles. Do not migrate active sessions casually. Match `ADMIN_EMAIL`, volunteer records and any escort allowlist to the intended permissions.
6. Keep or reauthorise the existing Google relay (with its secret privately configured), or deploy a new relay under an authorised sender. Verify actual email delivery. Its Google authorisation and ownership do not transfer with source files.
7. Update `APP_ORIGIN`, site metadata, links and any hardcoded original-origin fallbacks. A new origin means existing browser cookies and installed-app storage do not move: residents must open the new URL and sign in again. Existing accounts can still be recognised by email if their database records were migrated.
8. Review Web Push migration. A new origin normally requires users to reinstall/add the new app and enable notifications again. Existing subscriptions are tied to their browser origin/service worker and application-server key; do not assume copying them is enough. Retain keys privately only when appropriate for continuity, and avoid replaying stale pending alerts or notification queues.
9. Test logins, photos, organiser permissions, volunteer acceptance, trips/chat/history, privacy requests and notifications with consenting test users. Compare row counts/relationships and R2 object counts/checksums, and verify the rollback path. Publish the new link only after acceptance checks; retire the old service only after a successful cutover.

Provider contracts, storage jurisdictions, privacy obligations, retention/deletion and responder participation remain unresolved as documented in `docs/PRIVACY-REVIEW.md`. This export does not resolve or certify those matters.

## Prompt to continue in the other account

“Continue developing the attached Argyle Together source. First read EXPORT-HANDOVER.md and docs/PRIVACY-REVIEW.md. Preserve existing features, IDs, migrations, privacy limits and the lockfile. Do not request or print secret values. Do not deploy, create a replacement Site, delete resources, or migrate live data until we choose an authorised continuation or migration plan. Explain which hosting access and private secret configuration are still needed.”

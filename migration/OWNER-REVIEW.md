# Temporary source export: owner review

This is a proposed custom export tool, not a Sites-provided backup facility.
The code is prepared locally and is **not connected to the app's routes**.
Nothing in this folder deploys a Site, changes its database, or imports data into
the destination. The original owner must review and authorise any installation,
data access, private transfer and pause of the live app first.

The destination is the user's own Cloudflare account, whose separate preview is
`https://argyle-together.asandaqwabe465.workers.dev`. Its database has no resident
data. Opening that preview does not demonstrate a completed migration.

## What would be copied

The default scope preserves IDs, relationships, message sequence numbers and
exact photo object keys for these durable tables:

`users`, `trips`, `replies`, `escorts`, `alerts`, `incidents`, `incident_flags`,
`volunteers`, `trip_messages`, `privacy_requests`.

This includes contact details, incident reports, conversations, privacy requests
and any coordinates still stored in the durable `alerts` table. The owner must
approve that scope. Pending correction/deletion requests must remain visible and
be handled after migration; copying a request does not fulfil it.

The tool deliberately excludes `sessions`, `challenges`, `limits`, `locations`,
`push_subscriptions` and `push_deliveries`. These are temporary authentication,
rate-limit, live-location or notification state. Residents will sign in again
and enable notifications at the new address. Old delivery queues must not be
replayed. Keep the original database and bucket as the rollback source; this
scoped export is not a full sixteen-table archival backup.

All bucket objects must be under `profiles/`; unexpected keys stop the export
for review. Every nonempty `users.photo` reference must resolve to an exported
object. Missing files, unsupported schema or checksum mismatches are failures,
not permission to silently omit a resident's data.
Known-table column changes are recorded in the manifest rather than assumed
identical to this checkout; reconcile the actual schema before any import.

## Owner approval and source access

The Sites owner and the app organiser are separate identities. Owning the Site
does not automatically provide an authenticated app organiser session. Verify
that the organiser can sign in with the **explicitly configured** `ADMIN_EMAIL`
before any maintenance window. Preserve the existing authentication configuration.

Required approval covers the precise code patch, exporting the above data and
photo scope, an agreed maintenance window, a private owner-controlled receiving
computer, encrypted transfer to the user responsible for the named destination,
and retention/deletion of temporary copies. Do not attach an actual export to a
chat or commit it to GitHub. This source-only review packet contains no data.

## Proposed installation, after approval

1. On the original account, compare `lib/server.ts` with the expected source and
   review `migration/source-export.ts` and `migration/source-integration.patch`.
   Run the synthetic tests below before proposing any publication. If the source
   has changed, adapt and re-review the patch; never replace the whole app with
   the new Cloudflare branch or reuse its hosting manifest on the original Site.
2. The patch adds an early API gate and organiser authorisation callback. Apply
   it only to the original source after approval. No SQL migration is involved.
   Publish with export and maintenance disabled first, then verify ordinary
   sign-in, trips and the organiser's own photo still work. Do not test by
   reading another resident's photo or triggering alerts.
3. Prepare a new high-entropy `MIGRATION_EXPORT_SECRET` (at least 32 random bytes)
   in private settings. Never reuse `AUTH_SECRET` or the Gmail relay secret.
   Do not put values in source, a URL, chat or screenshots. Set the ordinary
   configuration flags described below only for the agreed window.
4. Sign in as the app organiser before pausing the API. Keep its unexpired
   session available privately to the downloader. Do not bypass authentication
   or allow new OTP/login requests during the pause.

| Setting | Meaning |
| --- | --- |
| `MIGRATION_READ_ONLY` | Literal `true` blocks all ordinary API requests. |
| `MIGRATION_EXPORT_ENABLED` | Literal `true` enables only the protected export routes. |
| `MIGRATION_EXPORT_SECRET` | New temporary secret stored privately. |
| `MIGRATION_READ_ONLY_SINCE` | ISO UTC timestamp of the confirmed pause. |
| `MIGRATION_EXPORT_EXPIRES_AT` | ISO UTC expiry, at most four hours after the pause. |

Missing, disabled, malformed or expired export configuration fails closed. The
maintenance flag remains in effect when the export credential expires: expiry
does **not** silently reopen writes. The owner must explicitly restore service.
Avoid an extended outage if a transfer fails or credentials expire.

## Consistency and safety during the pause

This safety app cannot provide live trip coordination or distress alerts while
its API is paused. Agree on timing and notify residents of the pause and their
normal emergency contacts before activation. Do not begin while trips or a
distress response are active. The owner must agree to the operational impact.

Blocking POST alone is insufficient. GET trips performs cleanup and GET alerts
updates alerts and starts background push work. The gate therefore blocks all
ordinary API requests, including GET and HEAD, before auth, rate limiting,
database operations, photo writes or background work. There is no organiser
bypass of normal app writes.

Confirm the maintenance version has fully rolled out and all previous requests
and background tasks have drained. Existing uploads and serial email batches
may outlive a deployment; an elapsed timer alone does not prove they stopped.
The exporter's minimum two-minute delay is a guard against an immediate copy,
not proof of quiescence. Any other source of writes must also be stopped. If
quiescence cannot be established, stop and resolve it rather than claiming a
consistent snapshot.

The downloader repeats table content and bucket-inventory checks before marking
an export complete. These checks catch ordinary changes but are not a database
transaction across pages, nor an atomic snapshot across D1 and R2. A confirmed
frozen source remains required. If the original app is reopened after this
copy, this copy becomes a rehearsal: obtain another verified final copy during
cutover so later resident changes are not lost.

## Private download

Run the downloader on an owner-controlled computer with encrypted storage,
Node >=22.13 and a restrictive local account. Establish privately how the owner
will supply an unexpired organiser session before installing the feature.
The session is the app's `argyle_session` cookie, not a ChatGPT account cookie.

Create a new private JSON credentials file outside any repository or shared
folder, mode `0600`, containing `token` (the temporary export secret) and
`cookie` (only `argyle_session=...`). Populate actual values through private
local tooling; never paste them into this guide or a conversation. On Windows,
use WSL or another supported private environment that enforces these Unix file
permissions; do not relax the downloader's permission check.

The command contains paths and a public origin only:

```sh
node migration/download-export.mjs \
  --source https://argyle-walk-together.sweet-cream-7564.chatgpt.site \
  --credentials /absolute/private/export-credentials.json \
  --output /absolute/private/argyle-export-new-directory
```

The output directory must not exist and must be outside the source repository.
The downloader creates private files, streams photos, checks hashes and verifies
references. It refuses redirects and never uses a server-supplied download URL.
No completion marker is written on failure. Failed partial exports still contain
private data and need the same protection as complete ones.

Do not import just because a download directory exists. Review `COMPLETE.json`,
manifest and checksum checks locally without posting records or credentials.
Agree on an encrypted private transfer method and verify its integrity at the
destination. Import tooling, schema reconciliation, foreign-key checks, email
and notification configuration, and an end-to-end restore rehearsal remain
separate work. Do not run table-creation migrations over a schema-containing
backup without reconciling it first.

## Cleanup and rollback

Disable export immediately after the verified download. Remove the export
secret and private credentials file when no longer needed. Remove the temporary
route patch/helper in a reviewed subsequent publication. Explicitly restore
ordinary API service when appropriate, or keep the agreed pause through final
cutover. Verify sign-in, organiser access and normal app operation afterwards.

Keep the original Site, database and bucket until the user has verified the
destination with consenting test users. Do not delete either source resource
as part of cleanup. Agree on retention and securely remove temporary export
copies after acceptance, subject to the owner's backup/retention needs.

## Synthetic local verification

Before installing the patch, from the source repository with dependencies
already installed:

```sh
git apply --check migration/source-integration.patch
node --test tests/source-export.test.mjs tests/source-integration.test.mjs tests/download-export.test.mjs
node node_modules/typescript/bin/tsc --noEmit
```

These checks use synthetic data and do not establish live bucket access,
publishing capability, live snapshot consistency, or a successful import.
The integration test deliberately applies the patch in memory to unchanged
source. Do not rerun that pre-install test after applying the patch to the real
file. Type-check and build the installed source before proposing publication,
then run separately reviewed post-install checks with export disabled.

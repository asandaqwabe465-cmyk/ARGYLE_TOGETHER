# Export proposal verification — 30 October 2026

Status: source-only review proposal. No exporter is attached to the app router,
no original Site has been published, and no real records or photos were read.
Nothing has been imported into the separate Cloudflare preview.

Local checks passed:

- 35 synthetic exporter, downloader, handler integration and offline restore
  tests, including failures for corrupt exports, schema drift, invalid foreign
  keys, duplicate IDs, unsafe integers, missing photos and unsafe private paths.
- 17 existing app, email relay, notification, PWA and policy tests.
- TypeScript `tsc --noEmit`.
- `git apply --check migration/source-integration.patch` against unchanged
  imported source, and whitespace validation.
- An offline Worker round trip using real local D1/R2 interfaces, all eight
  existing migrations, 201 synthetic users, linked trip/chat records and private
  photo bytes/metadata, followed by restoration into SQLite. Pagination, original
  IDs, foreign keys, exact bytes and metadata were checked. Sparse message
  sequences and the next auto-generated sequence were tested separately.
- 240 ordinary API requests across routes, methods and authentication states
  were blocked during maintenance with no database, storage, outbound network
  or background side effects in the instrumented handler.
- Temporarily applying the integration patch in the local checkout passed a full
  TypeScript check and production build. Original source, the previous build and
  generated deployment configuration were restored afterwards; nothing was
  published. The owner's installed source still needs its own build validation.

Failure cases include invalid owner/session/secret/configuration, unexpected
tables or unsupported metadata, changing records/files, missing referenced
photos, invalid cursors, redirects, unsafe output paths and damaged local files.
The downloader writes its completion marker only after verification.

The optional integration patch targets the imported `lib/server.ts` with SHA-256:

```
0ce9803f15726c00774fb04745b088eaf7243c31d656779095d79101c90202e5
```

That file remains unchanged in this proposal. If the original account has newer
source, review and adapt the patch there rather than replacing its whole app.
The integration tests are pre-install tests that apply the patch in memory;
type-check and build the actual installed source separately before publishing.

Not established by these tests: current live bucket retrieval, successful
organiser sign-in, readiness/protection of the user's Windows receiver, an
original-Site publication, a fully drained source, atomic snapshot consistency,
the real private transfer or a remote destination import. The two-minute guard
and repeated reads do not prove quiescence. Owner approval and an agreed pause
remain required. See `OWNER-REVIEW.md` for the scope and operational procedure.

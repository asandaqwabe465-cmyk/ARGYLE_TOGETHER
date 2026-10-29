# Export proposal verification — 30 October 2026

Status: source-only review proposal. No exporter is attached to the app router,
no original Site has been published, and no real records or photos were read.
Nothing has been imported into the separate Cloudflare preview.

Local checks passed:

- 27 new synthetic exporter, downloader and handler integration tests.
- 17 existing app, email relay, notification, PWA and policy tests.
- TypeScript `tsc --noEmit`.
- `git apply --check migration/source-integration.patch` against unchanged
  imported source, and whitespace validation.
- An offline Worker round trip using real local D1/R2 interfaces, all eight
  existing migrations, 201 synthetic users, linked trip/chat records and private
  photo bytes/metadata. Pagination, exact bytes and references were checked.
- 240 ordinary API requests across routes, methods and authentication states
  were blocked during maintenance with no database, storage, outbound network
  or background side effects in the instrumented handler.

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

Not established by these tests: current live bucket retrieval, a successful
original-Site publication, a fully drained source, atomic snapshot consistency,
the private transfer mechanism or a destination import. The two-minute guard
and repeated reads do not prove quiescence. Owner approval and an agreed pause
remain required. See `OWNER-REVIEW.md` for the scope and operational procedure.

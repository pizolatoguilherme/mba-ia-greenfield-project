---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 4
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T09:58:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T09:25:29-03:00"
  docs/decisions/technical-decisions-video-upload-delivery-limits.md: "2026-11-14T09:54:48-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide prescribes local-filesystem storage in tests; TDs require MinIO via S3 API"
  - id: IC-2
    status: open
    summary: "Part size: phase-03-videos/TD-03 says 64 MiB; video-upload-delivery-limits/TD-01 decides 16 MiB"
  - id: AMB-1
    status: open
    summary: "Pre-registration (draft) does not define init input/stored fields nor accepted formats"
  - id: AMB-2
    status: open
    summary: "'extração de duração e metadados' does not list which metadata to persist"
  - id: MD-1
    status: resolved
    summary: "Upload/delivery numeric policies (part size, URL TTLs) are suggested, not decided"
    resolved_by: video-upload-delivery-limits/TD-01, video-upload-delivery-limits/TD-02, video-upload-delivery-limits/TD-03, video-upload-delivery-limits/TD-04
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` quotes `testing-guide-nestjs-project` → `references/external-systems.md`: "Object Storage — Local Filesystem: Local filesystem storage in development and tests. S3 in production", via a `StorageService` abstraction with a local adapter in tests. This contradicts `phase-03-videos/TD-01` and `phase-03-videos/TD-04`, under which storage is accessed only through the S3 API against MinIO running in Compose (internal `S3_ENDPOINT`), and `phase-03-videos/TD-03` / `phase-03-videos/TD-09`, whose presigned multipart upload and presigned `Range` GET cannot be exercised by a local-filesystem adapter. Explicit choice: (a) storage integration tests run against the real MinIO service in Compose, recorded as a deliberate deviation from the guide's storage strategy; (b) follow the guide with a local adapter in tests and accept that presigned multipart, `Range`/`206` and CORS behavior are not covered by tests.
- **IC-2** — Two decided TDs state different multipart part sizes:
  - `phase-03-videos/TD-03` Recommendation: "64 MiB would be a reasonable value: a 10 GB file then needs about 160 parts".
  - `video-upload-delivery-limits/TD-01` decides "Fixed 16 MiB" (≤ 640 parts).

  The second doc was written to fix that value, but the first still carries the old figure, and `/plan-build` reads both Recommendations. Related, without a conflicting number: `phase-03-videos/TD-11` says "A 24 h threshold for `draft` uploads", while `video-upload-delivery-limits/TD-04` measures those 24 h from `last_activity_at`. Explicit choice: (a) append a `**Revisions:**` entry to `phase-03-videos/TD-03`, with the Option letter A unchanged, pointing the part size to `video-upload-delivery-limits/TD-01`, plus a matching entry on `phase-03-videos/TD-11` for the inactivity basis (`video-upload-delivery-limits/TD-04`); (b) leave both TDs as they are and treat `video-upload-delivery-limits` as authoritative for every numeric parameter, recorded as a clarification.

### Ambiguities

- **AMB-1** — Capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" does not state what the upload-init request carries and what the draft record stores. Open points: is a title supplied by the client or derived from the original filename? Is the original filename persisted? Is the declared size persisted? Is the declared content type persisted? Which input formats or MIME types are accepted at init, with anything else rejected? `phase-03-videos/TD-03` fixes the size ceiling (10 GB), `phase-03-videos/TD-10` fixes the initial status (`draft`), and `video-upload-delivery-limits/TD-04` adds `last_activity_at`, but none of them fixes the field set. The init API contract and the `videos` Data Model depend on it. Explicit choice: define the init input fields, the persisted draft fields and the accepted-format policy (for example, a `video/*` allowlist at init plus ffprobe as the final check in the worker, with `failed` on rejection per `phase-03-videos/TD-10`).
- **AMB-2** — Capability "Processamento automático do vídeo após upload (extração de duração e metadados)" names duration but leaves "metadados" open. Candidates from ffprobe include width/height, video/audio codecs, bitrate, container format, frame rate and stored file size. This sets the `videos` columns (or a JSON metadata column) and what the worker writes. Explicit choice: list the metadata fields to persist and their storage shape (typed columns vs. a single `jsonb` column).

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(`## UI Inventory` is in the deferred state, so Check 7 does not apply.)_

## Resolved Issues

- **MD-1** _(resolved_by video-upload-delivery-limits/TD-01, video-upload-delivery-limits/TD-02, video-upload-delivery-limits/TD-03, video-upload-delivery-limits/TD-04)_ — Upload/delivery numeric policies (part size, URL TTLs) are suggested, not decided. Closed by the ad-hoc research doc `video-upload-delivery-limits` (`related_phases: [3]`), which decides part size 16 MiB, part-URL TTL 1 h, GET-URL TTL 6 h and a cleanup threshold of 24 h of inactivity.

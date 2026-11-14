---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 4
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T09:41:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T09:25:29-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide prescribes local-filesystem storage in tests; TDs require MinIO via S3 API"
  - id: AMB-1
    status: open
    summary: "Pre-registration (draft) does not define init input/stored fields nor accepted formats"
  - id: AMB-2
    status: open
    summary: "'extração de duração e metadados' does not list which metadata to persist"
  - id: MD-1
    status: open
    summary: "Upload/delivery numeric policies (part size, URL TTLs) are suggested, not decided"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` quotes `testing-guide-nestjs-project` → `references/external-systems.md`: "Object Storage — Local Filesystem: Local filesystem storage in development and tests. S3 in production", via a `StorageService` abstraction with a local adapter in tests. This contradicts `phase-03-videos/TD-01` and `phase-03-videos/TD-04`, under which storage is accessed only through the S3 API against MinIO running in Compose (internal `S3_ENDPOINT`), and `phase-03-videos/TD-03` / `phase-03-videos/TD-09`, whose presigned multipart upload and presigned `Range` GET cannot be exercised by a local-filesystem adapter. Explicit choice: (a) storage integration tests run against the real MinIO service in Compose, recorded as a deliberate deviation from the guide's storage strategy; (b) follow the guide with a local adapter in tests and accept that presigned multipart, `Range`/`206` and CORS behavior are not covered by tests.

### Ambiguities

- **AMB-1** — Capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" does not state what the upload-init request carries and what the draft record stores. Open points: is a title supplied by the client or derived from the original filename? Is the original filename persisted? Is the declared size persisted? Is the declared content type persisted? Which input formats or MIME types are accepted at init, with anything else rejected? `phase-03-videos/TD-03` fixes the size ceiling (10 GB) and `phase-03-videos/TD-10` fixes the initial status (`draft`), but not the field set. The init API contract and the `videos` Data Model depend on it. Explicit choice: define the init input fields, the persisted draft fields and the accepted-format policy (for example, a `video/*` allowlist at init plus ffprobe as the final check in the worker, with `failed` on rejection per `phase-03-videos/TD-10`).
- **AMB-2** — Capability "Processamento automático do vídeo após upload (extração de duração e metadados)" names duration but leaves "metadados" open. Candidates from ffprobe include width/height, video/audio codecs, bitrate, container format, frame rate and stored file size. This sets the `videos` columns (or a JSON metadata column) and what the worker writes. Explicit choice: list the metadata fields to persist and their storage shape (typed columns vs. a single `jsonb` column).

### Missing Decisions

- **MD-1** — Several numeric policies that cut across env, code and API contract are only suggested in the decided TDs:
  - multipart part size: "64 MiB would be a reasonable value" (`phase-03-videos/TD-03`);
  - lifetime of presigned part URLs: "short-lived, re-signed on demand" (`phase-03-videos/TD-03`);
  - lifetime of presigned stream/download GET URLs: "hours, not minutes" (`phase-03-videos/TD-09`).

  `phase-03-videos/TD-11` (24 h draft threshold) states that its threshold must be chosen against the part-URL lifetime. Without fixed values, `/plan-build` would have to invent them. Explicit choice: fix part size, part-URL TTL and GET-URL TTL, and confirm the TD-11 threshold. Record the values as `**Revisions:**` on the existing TDs: the Option letters stay the same, only the parameters change.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(`## UI Inventory` is in the deferred state, so Check 7 does not apply.)_

## Resolved Issues

_No issues resolved yet._

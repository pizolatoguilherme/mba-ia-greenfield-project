---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T13:41:27-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T10:28:20-03:00"
  docs/decisions/technical-decisions-video-upload-delivery-limits.md: "2026-11-14T09:54:48-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-filesystem storage in tests; TDs require MinIO via S3 API"
    resolved_by: phase-03-videos/TD-04 (Revision 2026-11-14)
  - id: IC-2
    status: resolved
    summary: "Part size: phase-03-videos/TD-03 says 64 MiB; video-upload-delivery-limits/TD-01 decides 16 MiB"
    resolved_by: phase-03-videos/TD-03, phase-03-videos/TD-11 (Revisions 2026-11-14)
  - id: AMB-1
    status: resolved
    summary: "Pre-registration (draft) does not define init input/stored fields nor accepted formats"
    resolved_by: phase-03-videos/TD-03 (Revision 2026-11-14)
  - id: AMB-2
    status: resolved
    summary: "'extração de duração e metadados' does not list which metadata to persist"
    resolved_by: phase-03-videos/TD-06 (Revision 2026-11-14)
  - id: MD-1
    status: resolved
    summary: "Upload/delivery numeric policies (part size, URL TTLs) are suggested, not decided"
    resolved_by: video-upload-delivery-limits/TD-01, video-upload-delivery-limits/TD-02, video-upload-delivery-limits/TD-03, video-upload-delivery-limits/TD-04
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

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

- **IC-1** _(resolved_by phase-03-videos/TD-04, Revision 2026-11-14)_ — Testing guide prescribes local-filesystem storage in tests; TDs require MinIO via S3 API. User chose (a): storage integration tests run against the real MinIO service in Compose, recorded as a deliberate deviation from the guide.
- **IC-2** _(resolved_by phase-03-videos/TD-03, phase-03-videos/TD-11, Revisions 2026-11-14)_ — Part size was 64 MiB in TD-03 vs 16 MiB in `video-upload-delivery-limits/TD-01`.
  - TD-03 Revision: part size and part-URL TTL now point to `video-upload-delivery-limits/TD-01` / `TD-02`.
  - TD-11 Revision: the 24 h are measured from `last_activity_at`, per `video-upload-delivery-limits/TD-04`.
  - Rationale: parâmetros fixados em doc de limites dedicado.
- **AMB-1** _(resolved_by phase-03-videos/TD-03, Revision 2026-11-14)_ — Init carries `filename`, `size`, `contentType` and a required `title`, all persisted on the draft. `contentType` allowlist: `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`. ffprobe in the worker is the final check, with `failed` on unreadable input.
- **AMB-2** _(resolved_by phase-03-videos/TD-06, Revision 2026-11-14)_ — Persisted metadata: typed columns `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `container`, plus `metadata` `jsonb` with a raw ffprobe summary.
- **MD-1** _(resolved_by video-upload-delivery-limits/TD-01, video-upload-delivery-limits/TD-02, video-upload-delivery-limits/TD-03, video-upload-delivery-limits/TD-04)_ — Upload/delivery numeric policies (part size, URL TTLs) were suggested, not decided. Closed by the ad-hoc research doc `video-upload-delivery-limits` (`related_phases: [3]`), which decides part size 16 MiB, part-URL TTL 1 h, GET-URL TTL 6 h and a cleanup threshold of 24 h of inactivity.

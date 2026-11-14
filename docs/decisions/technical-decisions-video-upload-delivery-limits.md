---
scope_type: ad-hoc
related_phases: [3]
status: decided
date: 2026-11-14
scope_description: "Numeric policies for the Phase 03 upload/delivery pipeline: multipart part size, presigned part-URL lifetime, presigned stream/download GET-URL lifetime, and the abandoned-upload cleanup threshold. Parameters only — the options decided in phase-03-videos/TD-03, TD-09 and TD-11 are not reopened."
---

# Technical Decisions — Video Upload & Delivery Limits

_Subprojects in scope:_

- `nestjs-project/` — owns all four values. They live in the storage/upload config namespace (Joi-validated env, per `phase-01-configuracao-base/TD-02` and `TD-03`), are returned in API responses (part size, URL expiry), and are read by the worker's sweep job.
- `next-frontend/` — no open decision and no code in this phase. The values reach a future client only through API responses (e.g., `partSize`, `expiresAt`), so the `Cross-layer` TDs below fix the contract once.

**Context for all TDs:** this doc follows up on `phase-03-videos/validation.md` MD-1, which flagged that `phase-03-videos/TD-03`, `TD-09` and `TD-11` suggest numeric values without deciding them. It does **not** reopen those TDs' chosen options (presigned multipart direct to MinIO, presigned GET via JSON, scheduled sweep job).

**Hard limits (primary sources):**

- S3 multipart: parts from 5 MiB to 5 GiB (no minimum for the last part), at most 10,000 parts per upload ([AWS — multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)).
- SigV4 presigned URLs: `@aws-sdk/s3-request-presigner` defaults `expiresIn` to 900 s and rejects values above 604,800 s (7 days, `MAX_PRESIGNED_TTL`) (context7 `/aws/aws-sdk-js-v3`; [AWS — presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)). Expiry is validated when a request is made. The sources consulted do not say whether a transfer already in progress survives expiry, so no TD below depends on that behavior.

**Reference upload times for 10 GiB** (≈ 85.9 Gbit, ignoring overhead):

| Link | Time |
|---|---|
| 50 Mbps | ≈ 29 min |
| 10 Mbps | ≈ 2.4 h |
| 5 Mbps | ≈ 4.8 h |
| 1 Mbps | ≈ 23.9 h |

---

## TD-01: Multipart Part Size

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `phase-03-videos/TD-03` has the backend set the part size and return it in the init response, and the client slices the file accordingly. So the value is a contract between API config, the init response and any client. It sets three things: how much data is re-sent when one part fails (resume granularity, a plan requirement under "Pontos de Atenção"), how many part URLs must be signed, and how many `ETag`s the `complete` call carries.

**Options:**

### Option A: Fixed 16 MiB
- Every part is 16 MiB, except the last. A 10 GiB file needs 640 parts.
- **Pros:** A failed part costs at most 16 MiB of re-upload (≈ 2.2 min at 1 Mbps), which suits the resume requirement on unstable links. Well inside the 10,000-part limit. Keeps the in-flight memory per part small in a client.
- **Cons:** 640 part URLs to sign over the upload (batched on demand per TD-03), and a `complete` payload with 640 `ETag`s. More HTTP requests in total.

### Option B: Fixed 64 MiB
- Every part is 64 MiB, except the last. A 10 GiB file needs 160 parts.
- **Pros:** Fewer requests, fewer signatures and a smaller `complete` payload. This is the value `phase-03-videos/TD-03` suggested.
- **Cons:** A failed part costs up to 64 MiB (≈ 9 min at 1 Mbps) of re-upload, so resume is coarser on exactly the slow links where failures are most likely.

### Option C: Adaptive part size by declared file size
- `partSize = max(5 MiB, ceil(declaredSize / 1000))`, rounded up to a whole MiB, which caps any upload at about 1,000 parts.
- **Pros:** Small files get small parts and large files fewer parts, with the part count bounded.
- **Cons:** One more formula to implement and test on both sides. With a fixed 10 GB ceiling, a fixed size already stays far from the 10,000-part limit, so the adaptivity buys little.

**Recommendation:** **Option A (fixed 16 MiB)**. The plan explicitly asks for resuming after connection failures, and a 16 MiB part keeps the cost of a failure small even on a 1 Mbps link. The 640-part maximum is far from the 10,000 limit. The extra signatures are cheap because presigning is a local computation (`phase-03-videos/TD-04`). Option C solves a part-count problem that a fixed 10 GB ceiling never creates.

**Decision:** A (fixed 16 MiB)

---

## TD-02: Presigned Part-URL Lifetime

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `phase-03-videos/TD-03` signs `UploadPart` URLs for the part numbers a client requests and re-signs them on demand ("short-lived"). The lifetime goes into the response (`expiresAt`), so a client knows when to ask for fresh URLs. A part URL only lets someone `PUT` one part number of one in-progress upload. Assembling the object still requires the authenticated `complete` call, so a leaked part URL is low-impact. Depends on TD-01, because the part size sets how long a single `PUT` can take.

**Options:**

### Option A: 15 minutes (SDK default, 900 s)
- Clients request part URLs in small batches just ahead of sending them.
- **Pros:** The SDK default, so no tuning. The shortest exposure window.
- **Cons:** On slow links a client that requests a large batch may see later URLs expire before use, so it has to refresh more often (more round trips through the API, or the BFF later).

### Option B: 1 hour
- Clients can request a larger window of part URLs per call.
- **Pros:** On a 1 Mbps link, one hour covers about 27 parts of 16 MiB (TD-01 A), so a single batch request rarely goes stale. Fewer signing round trips, and the exposure stays low given the narrow scope of a part URL.
- **Cons:** A longer window than strictly needed on fast links.

### Option C: 24 hours, all parts signed at init
- The init response carries URLs for every part, and no further signing calls are needed.
- **Pros:** The simplest client: one call, then only `PUT`s.
- **Cons:** A 640-URL init response. The `ListParts` + re-sign resume path from TD-03 is still needed whenever an upload outlives 24 h. Wide exposure window.

**Recommendation:** **Option B (1 hour)**. TD-03 already relies on on-demand re-signing, so the TTL only has to cover one batch on a slow link. An hour does that with margin while keeping exposure narrow. 15 minutes forces frequent refreshes on the slow links the resume requirement targets. 24 hours trades a bloated init response for no gain over re-signing.

**Decision:** B (1 hour)

---

## TD-03: Presigned Stream/Download GET-URL Lifetime

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** `phase-03-videos/TD-09` returns `{ url, expiresAt }` for `ready` videos, and storage serves `Range` requests directly. Seeking during playback issues new `Range` requests against the same URL, so after expiry those fail until the client fetches a new URL ("hours, not minutes" in TD-09). The same lifetime applies to download URLs (`ResponseContentDisposition: attachment`). A shorter lifetime limits how long a shared URL keeps working, which matters for unlisted videos (Phases 04/05). Expiry is checked when each request is made (see the hard-limit note above).

**Options:**

### Option A: 1 hour
- **Pros:** The shortest window for a leaked URL.
- **Cons:** Long videos and long sessions routinely outlive it, so every client must implement refresh-on-expiry for playback and for resuming downloads.

### Option B: 6 hours
- **Pros:** Covers the vast majority of single viewing sessions, and a resumed 10 GiB download on a 5 Mbps link (≈ 4.8 h), without refresh. A refresh path is still possible via `expiresAt`. A leaked URL stops working the same day.
- **Cons:** A shared URL works for up to 6 hours.

### Option C: 24 hours
- **Pros:** Practically no refresh needed, and covers even very slow downloads.
- **Cons:** The longest leak window, and it weakens the unlisted-link semantics Phases 04/05 build on. It does not remove the need for refresh logic for sessions longer than a day.

**Recommendation:** **Option B (6 hours)**. It keeps playback and a resumed 10 GiB download on modest links working without the refresh path, so `expiresAt` becomes a safety net rather than a requirement. A leaked link also stays bounded to the same day, which preserves the unlisted model of the later phases. One value for both stream and download keeps a single config key.

**Decision:** B (6 hours)

---

## TD-04: Abandoned-Upload Cleanup Threshold

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** `phase-03-videos/TD-11` decided a scheduled sweep that aborts the multipart upload and marks `draft` videos `failed` after a threshold, with 24 h as the stated value. A 10 GiB upload at 1 Mbps takes about 23.9 h, so a threshold counted from the **creation** time would kill slow uploads that are still progressing. The threshold must also exceed the part-URL lifetime (TD-02), or a paused client could not resume. The threshold value and how activity is tracked appear in config, in the `videos` data model and in the sweep query.

**Options:**

### Option A: 24 h since init (age-based)
- The sweep fails `draft` videos whose `created_at` is older than 24 h.
- **Pros:** No extra column, the simplest query, and it matches the TD-11 text literally.
- **Cons:** Cuts off legitimate slow uploads (≈ 24 h at 1 Mbps) that are still sending parts.

### Option B: 24 h since last upload activity (inactivity-based)
- Each part-URL signing request (and `complete`) updates a `last_activity_at` timestamp on the video. The sweep fails `draft` videos idle for more than 24 h.
- **Pros:** Never kills an upload that is still progressing. Keeps the 24 h figure from TD-11. Bounds orphaned storage to about one day after the last activity, and stays well above the 1 h part-URL lifetime (TD-02 B).
- **Cons:** One extra column and a write per signing request.

### Option C: 7 days since init (age-based)
- **Pros:** Matches common S3 lifecycle defaults for incomplete uploads. Covers any realistic link speed with no extra column.
- **Cons:** Orphaned parts (up to 10 GiB each) can sit for a week, against the plan's storage-cost concern.

**Recommendation:** **Option B (24 h of inactivity, tracked by `last_activity_at`)**. It confirms the 24 h figure from `phase-03-videos/TD-11` while measuring it from the last activity, so slow-but-active uploads survive and abandoned ones are reclaimed within a day. The added column is cheap compared with either killing real uploads (A) or holding orphaned gigabytes for a week (C). The hourly sweep cadence from TD-11 stays unchanged.

**Decision:** B (24 h of inactivity, tracked by `last_activity_at`)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Cross-layer | Multipart part size | A — fixed 16 MiB (≤ 640 parts for 10 GiB) | A |
| TD-02 | Cross-layer | Presigned part-URL lifetime | B — 1 hour | B |
| TD-03 | Cross-layer | Presigned stream/download GET-URL lifetime | B — 6 hours | B |
| TD-04 | Backend | Abandoned-upload cleanup threshold | B — 24 h of inactivity (`last_activity_at`) | B |

**Dependencies:**

- TD-02 → TD-01 (the part size sets the duration of a single `PUT`).
- TD-04 → TD-02 (the threshold must exceed the part-URL lifetime).
- All four refine, without reopening: `phase-03-videos/TD-03` (→ TD-01, TD-02), `phase-03-videos/TD-09` (→ TD-03), `phase-03-videos/TD-11` (→ TD-04).

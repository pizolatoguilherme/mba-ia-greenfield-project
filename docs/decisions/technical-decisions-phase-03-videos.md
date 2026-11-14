---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-14
scope_description: "Video upload and processing foundation: object storage service and layout, background job queue, 10GB direct-to-storage upload protocol, presigned-URL endpoint topology, processing trigger, video worker deployment, thumbnail generation, unique public video ID, streaming/download delivery, video status model, and abandoned-upload cleanup."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns every TD below: new Compose services (object storage, queue backend, video worker), S3 client and presigning, the `videos` table linked to `channels`, upload/stream/download endpoints, the job producer and the FFmpeg worker.
- `next-frontend/` — no frontend-only decision. Phase 03 has no screen bullet (the management panel is Phase 04 and the player page is Phase 05). The browser-facing contracts the frontend will consume are decided here once as `Cross-layer` TDs (TD-04, TD-05, TD-09, TD-10, TD-11), consistent with the inherited Strict BFF rule (`next-frontend-config-base/TD-03`), which already anticipates presigned object-storage URLs as the path for large payloads.

**Inherited constraints (not reopened):** global `JwtAuthGuard` + `@Public()` opt-out (`phase-02-auth/TD-02`); domain error envelope via `DomainExceptionFilter` (`phase-02-auth/TD-07`); class-validator DTOs (`phase-02-auth/TD-06`); namespaced `registerAs` config + Joi env schema (`phase-01-configuracao-base/TD-01..TD-04`); one channel per user (`channels.user_id` unique); Strict BFF on the frontend (`next-frontend-config-base/TD-03`); Docker Compose service names as hosts (root `CLAUDE.md`).

**Installed versions checked:** NestJS 11, TypeORM 0.3.28, `pg` 8.20, Node 25.6 (container), Jest 30. Candidate libraries checked against the npm registry on 2026-11-14: `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` 3.1169.0, `bullmq` 6.7.6, `@nestjs/bullmq` 12.0.2 (peer `@nestjs/common` ^11 and `bullmq` ^6), `pg-boss` 12.38.2, `nanoid` 6.0.2. `fluent-ffmpeg` 2.1.3 is marked **deprecated** on npm.

---

## TD-01: Object Storage Service for the Compose Environment

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture diagram names "S3 or MinIO" for object storage. Since then, MinIO stopped publishing Community Edition images and binaries (October 2025), and the community repository was archived in February 2026: the last image still works but gets no security or compatibility fixes. The backend will talk to storage only through the S3 API (`@aws-sdk/client-s3` v3 with `endpoint` + `forcePathStyle: true`), so the choice decides which S3-compatible server runs in Compose and in integration tests. It does not decide application code. The S3 operations this phase needs are presigned `UploadPart`, `Create/Complete/AbortMultipartUpload`, `ListParts`, presigned `GetObject` with `Range` support, and bucket CORS.

**Options:**

### Option A: MinIO, pinned to the last Community release
- Keep `minio/minio` pinned to the final published Community tag (or a rebuilt image such as Chainguard's).
- **Pros:** The most widely documented S3 target for local dev. Presigned multipart, CORS and Range support are well known. Plenty of Compose and test examples.
- **Cons:** Archived upstream: known CVEs stay unpatched and the image is frozen. The admin console was already reduced in 2025. Choosing an unmaintained component in a greenfield phase builds in a forced migration later.

### Option B: RustFS 1.0
- Apache-2.0 S3-compatible server written in Rust, positioned as a MinIO drop-in. 1.0 reached GA on 2026-09-16 and ships an official container image.
- **Pros:** Actively maintained, permissive license, single container, same S3 surface as MinIO.
- **Cons:** GA only two months ago, with less community material. Some interoperability features are still labeled preview. Our research found no documentation confirming presigned `UploadPart` and bucket CORS end to end, so this must be proven by an integration test in the infra SI.

### Option C: SeaweedFS (`weed server -s3`)
- Mature Apache-2.0 distributed storage. One command starts master, volume server, filer and the S3 gateway.
- **Pros:** Long production track record. The wiki documents presigned URLs and the multipart operation set.
- **Cons:** Several internal components, so heavier for a dev stack. S3 is a gateway over its filer, and the multipart operation names in the docs do not map 1:1 to the S3 API. A presigned `UploadPart` flow is not documented end to end either.

**Recommendation:** **Option B (RustFS 1.0)**, pinned to an exact version. It is the only maintained candidate that keeps the single-container MinIO footprint. Because the code depends only on the S3 API, switching to A or C later means changing the Compose image and env values, with no code change. To keep that swap invisible, name the Compose service generically (`storage`), not after the product. The compatibility gap is real: the first infra SI must include an integration test that runs presigned multipart (create → presigned PUT part → complete), presigned GET with `Range`, and CORS against the running container. If that test fails, fall back to A.

**Decision:** B (RustFS 1.0, pinned; S3 API only; fallback to pinned MinIO if the infra compatibility test fails)

---

## TD-02: Storage Layout — Buckets and Object Key Scheme

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The API writes keys (when it starts the multipart upload), the worker reads the source and writes the thumbnail, and the delivery endpoints presign reads. All three must agree on bucket names and key shapes, and the bucket names also appear in env/config and in the Compose bootstrap that creates them. The project plan asks for storage growth and cost to be planned from the start.

**Options:**

### Option A: Single bucket, prefixes per video
- One bucket (e.g., `streamtube-media`), with keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to create, one CORS policy, one env key. Deleting a video means deleting one prefix.
- **Cons:** Retention or lifecycle rules can only target prefixes, not separate policies per media type.

### Option B: Separate buckets per media type
- `streamtube-videos` (`{videoId}/source`) and `streamtube-thumbnails` (`{videoId}.jpg`).
- **Pros:** Independent policies per bucket: thumbnails are small and hot, while sources are large and could later move to a cheaper tier. Clear cost attribution per bucket.
- **Cons:** Two buckets to bootstrap and configure (CORS, env keys). Deleting a video touches two places.

**Recommendation:** **Option B (separate buckets for videos and thumbnails)**. Storage cost is an explicit concern in the plan, and source videos (up to 10 GB) and thumbnails (tens of KB) have opposite access and retention profiles. Keeping them apart lets a lifecycle or tier policy target sources alone. The extra env key and bootstrap step cost little. Keys are derived from the internal video UUID, never from the user-supplied filename, so uploads cannot collide or traverse paths. Phase 04's custom thumbnails can live in the same thumbnails bucket under a different key.

**Decision:** B (separate videos / thumbnails buckets, UUID-derived keys)

---

## TD-03: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The diagram leaves the message queue as "TBD". The API publishes a processing job after the upload completes, and the worker consumes it. The job runs ffprobe and ffmpeg, so retries, backoff, concurrency and deduplication matter. The `nestjs-best-practices` skill (`micro-use-queues`) points to `@nestjs/bullmq`. BullMQ 6 (2026-07-30) added pluggable backends, including PostgreSQL.

**Options:**

### Option A: BullMQ with the Redis backend (`@nestjs/bullmq` + Redis/Valkey container)
- `BullModule.forRoot({ connection })`, `registerQueue`, `@Processor` + `WorkerHost`. Jobs live in Redis.
- **Pros:** The canonical and most documented NestJS queue path, and the one the best-practices skill recommends. Built-in attempts and exponential backoff, `jobId` deduplication, concurrency, job schedulers and events. Years of production use with Redis.
- **Cons:** Adds a Redis (or Valkey) container to Compose and to the integration test environment. Redis becomes a new piece of infrastructure to run.

### Option B: BullMQ with the PostgreSQL backend (`createPostgresBackend`)
- Same BullMQ and `@nestjs/bullmq` API (`backendFactory` option, `@nestjs/bullmq` ≥ 11.0.5), with jobs stored in the existing PostgreSQL.
- **Pros:** No new container: it reuses `db`. The code is the same as Option A, so moving to Redis later is a configuration change.
- **Cons:** Introduced in 6.0, only about 3.5 months ago. No source we found labels it production-ready on its own. It requires running BullMQ's own schema migrations (no downgrades) next to TypeORM's, and it adds connection pressure on the main database.

### Option C: pg-boss
- PostgreSQL-native job queue (`SKIP LOCKED`), with no official Nest module.
- **Pros:** No new container, a mature library, transactional enqueue in the same database.
- **Cons:** No `@nestjs/*` integration, so the module, lifecycle and graceful shutdown have to be wired by hand. Smaller feature set for flows and events. It diverges from the path the best-practices skill recommends.

### Option D: RabbitMQ (`@nestjs/microservices` RMQ transport)
- AMQP broker with acknowledgements and dead-letter exchanges.
- **Pros:** A real message broker, language-agnostic consumers.
- **Cons:** No built-in delayed retry or backoff (that needs DLX/TTL plumbing). Heaviest operational footprint. Overkill for a single job type.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)**. It is the documented NestJS path, and the processing job needs exactly what it ships: attempts with backoff, `jobId` deduplication for idempotent enqueue, worker concurrency, and a job scheduler (used by TD-12). The one cost is one extra container, which is the queue box the architecture diagram already reserves. Option B is the natural fallback if an extra container must be avoided, since application code would not change. Its newness argues against making it the default for the core pipeline.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-04: Upload Protocol for Files up to 10 GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10 GB upload must not tie up the API, and the plan ("Pontos de Atenção") requires resuming after a dropped connection. The protocol defines the handshake on both sides: what the backend exposes and how the browser splits and sends the file. On the frontend, the Strict BFF rule (`next-frontend-config-base/TD-03`) routes every API call through Next.js Route Handlers. That TD already notes that large payloads would need presigned object-storage URLs rather than the backend URL. S3 multipart limits: parts from 5 MiB to 5 GiB (the last part may be smaller) and at most 10,000 parts.

**Options:**

### Option A: S3 multipart upload with presigned part URLs, browser → storage directly
- The API creates the multipart upload and the draft video, signs `UploadPart` URLs for the part numbers requested, and completes or aborts the upload. The browser `PUT`s each slice straight to storage and collects the `ETag`s.
- **Backend impact:** Only small JSON requests. No file bytes pass through Nest or Next. Resuming relies on `ListParts` plus re-signing any missing parts.
- **Frontend impact:** It slices the `File`, runs parallel `PUT`s and tracks `ETag`s. The storage CORS policy must allow `PUT` from the frontend origin and expose `ETag`.
- **Cons:** The protocol is custom, with three or four API calls to design and test. The browser needs a reachable storage host (TD-05).

### Option B: tus resumable protocol through the API (`@tus/server` + `@tus/s3-store`)
- The browser uses `tus-js-client` against a tus endpoint in Nest, and the server streams the chunks into S3 multipart.
- **Backend impact:** A standard resumable protocol with off-the-shelf clients, but every byte of 10 GB flows through the API process: CPU, memory, sockets and timeouts.
- **Frontend impact:** A drop-in client. Under Strict BFF, the bytes would also flow through a Next Route Handler, a second hop for the full payload.
- **Cons:** It conflicts with "sem impacto na performance" and doubles the transfer path.

### Option C: Streamed `multipart/form-data` through the API to storage
- The API streams the request body (busboy) into `@aws-sdk/lib-storage` `Upload`.
- **Backend impact:** The simplest client: one request. But a single 10 GB request has no resume, and a dropped connection restarts from zero.
- **Frontend impact:** Trivial form post, but proxied through the BFF as well.
- **Cons:** No resume, which the plan requires. The API is occupied for the whole transfer.

**Recommendation:** **Option A (presigned S3 multipart, direct to storage)**. It is the only option where no video bytes cross the API or the BFF, which satisfies both "sem impacto na performance" and the Strict BFF rule: the browser still calls only Next routes for the control requests, and talks to storage only through the signed URLs. Resume comes from `ListParts` plus re-signing. The backend sets the part size and returns it in the init response. 64 MiB would be a reasonable value: a 10 GB file then needs about 160 parts, well inside the 5 MiB–5 GiB and 10,000-part limits. The backend enforces the 10 GB ceiling twice: it rejects declared sizes above it at init, and it checks the assembled object size before accepting `complete`. Part URLs are short-lived and re-signed on demand. Depends on TD-01 (S3 multipart support) and TD-05 (public endpoint for signing).

**Decision:** A (presigned S3 multipart, browser → storage directly)

---

## TD-05: Presigned URL Endpoint Topology (internal vs public storage host)

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Inside Compose, the API and worker reach storage at `http://storage:<port>` (root `CLAUDE.md`: always use service names). The browser cannot resolve `storage`: it reaches the host-mapped port (e.g., `http://localhost:<port>`). SigV4 signs the `Host` header, so a URL signed for `storage` cannot be rewritten to `localhost` afterwards. The decision touches the env schema, `.env.example`, Compose port mapping and S3 client construction, and it sets which host every presigned URL in TD-04 and TD-10 carries.

**Options:**

### Option A: Two endpoints — internal for operations, public for browser-facing presigning
- `S3_ENDPOINT=http://storage:<port>` for server-side calls (create/complete/abort multipart, `ListParts`, `HeadObject`, worker reads and writes). `S3_PUBLIC_ENDPOINT=http://localhost:<port>` is used only by a second client that presigns URLs handed to the browser. Presigning is computed locally, so the public client never needs to reach the host itself.
- **Pros:** Follows the service-name rule for every server-to-storage hop, and gives browser URLs a host the browser can reach. In production, `S3_PUBLIC_ENDPOINT` becomes the CDN or public S3 hostname without code changes.
- **Cons:** Two S3 clients to configure and inject. Developers must remember which one presigns for the browser and which presigns for the worker.

### Option B: One hostname resolvable from both containers and the host machine
- Use one endpoint everywhere (e.g., `http://storage:<port>`) and make it resolve on the developer machine too, by adding `127.0.0.1 storage` to the host's hosts file.
- **Pros:** One client, one env key.
- **Cons:** Requires manual changes on every developer machine, outside the repo. Fragile in WSL and CI. It also leaks a dev-only DNS hack into the setup docs.

### Option C: Proxy storage through the Next.js origin (rewrite `/storage/*` → storage)
- The browser uses same-origin URLs, and Next rewrites them to the storage service. That also removes the need for storage CORS.
- **Pros:** No CORS, and only one public origin.
- **Cons:** Every uploaded and streamed byte flows through the Next server, which defeats TD-04 (direct-to-storage) and TD-10. Signatures must be computed for the proxied host, which brings the same mismatch back.

**Recommendation:** **Option A (internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT`)**. It is the only option that keeps the Compose service-name rule for server traffic and still hands the browser reachable URLs without per-machine setup. The production story is a value change, not a code change. URLs the worker uses for its own reads (TD-07) are signed with the internal client.

**Decision:** A (internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT`)

---

## TD-06: Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the file is fully in storage. Something has to observe "upload finished" and publish the job. Depends on TD-03 (queue) and TD-04 (who completes the multipart upload).

**Options:**

### Option A: The API's `complete` endpoint publishes the job
- After `CompleteMultipartUpload` and the size check succeed, the service updates the video status and enqueues the job with `jobId = videoId`.
- **Pros:** One code path that the API controls, and easy to test end to end. Enqueue is idempotent via `jobId`. It works on any S3-compatible backend.
- **Cons:** If the API crashes after completing but before enqueueing, the video stays stuck. This needs a recovery path (the TD-12 sweep can cover it) or ordered writes.

### Option B: Storage bucket event notifications
- Storage emits `s3:ObjectCreated:CompleteMultipartUpload` to a webhook or queue, and a consumer maps the object key to a video and enqueues the job.
- **Pros:** It fires even if the client never calls `complete` on the API.
- **Cons:** Notification support and configuration differ per storage product (TD-01) and are hard to bootstrap in Compose and tests. The browser still has to call the API to finish the multipart upload anyway, because `CompleteMultipartUpload` needs the `ETag` list. It adds an extra hop and makes the contract depend on the storage vendor.

**Recommendation:** **Option A (API `complete` endpoint publishes the job)**. The client already has to call the API to complete the multipart upload, so that call is the natural trigger. A keeps everything inside the S3 API subset the project depends on (TD-01), while B ties the pipeline to vendor-specific notifications. The crash window is closed by deduplicating with `jobId` and by the scheduled sweep in TD-12.

**Decision:** A (API `complete` endpoint enqueues, `jobId = videoId`)

---

## TD-07: Video Worker Deployment and Codebase

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram shows a separate "Video Worker (FFmpeg)" container that reads and writes storage and updates the database. FFmpeg work is CPU-heavy and must not slow the API. The decision sets the Compose topology, the image (FFmpeg binaries) and where the worker code lives. It also decides how the worker reads a source of up to 10 GB.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- A `worker` entrypoint boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). It reuses the config, TypeORM entities and `StorageService`, and runs as its own Compose service from an image that adds `ffmpeg`/`ffprobe`. The API process only produces jobs.
- **Pros:** One codebase, so entities, config schema and storage client are shared rather than duplicated. CPU-heavy work stays out of the API container. It scales on its own (more replicas, concurrency setting). The `nestjs-best-practices` guidance on graceful shutdown applies directly.
- **Cons:** Two entrypoints and a second Dockerfile or image stage to keep in step. Module wiring must keep HTTP-only providers out of the worker context.

### Option B: Processor inside the API process
- Register the `@Processor` in the API's `AppModule`, so the same container runs both.
- **Pros:** Simplest setup, with no new container or image.
- **Cons:** ffmpeg and ffprobe compete with request handling for CPU and memory, which contradicts "sem impacto na performance" and the diagram. The API image would need FFmpeg, and API and processing cannot scale apart.

### Option C: Separate subproject (`video-worker/`)
- An independent package with its own `package.json`, built around the queue library and FFmpeg.
- **Pros:** Strongest isolation. Could use another runtime later.
- **Cons:** Duplicates entities, migrations awareness, config validation and the storage client, or forces a shared-package setup in the monorepo that does not exist today. A new subproject means extra lint, test and CI surface.

**Recommendation:** **Option A (same codebase, separate entrypoint and container)**. It isolates the CPU-heavy work as the architecture requires without duplicating the domain model across two packages. The worker reads the source through a presigned GET signed with the internal endpoint (TD-05), passed straight to `ffprobe`/`ffmpeg` as an HTTP input. Both tools use HTTP range reads, so metadata extraction and a seek-based thumbnail grab never download all 10 GB to local disk. FFmpeg is called through `node:child_process` (`spawn`, argument array, no shell), because `fluent-ffmpeg` is deprecated on npm. Retries use queue attempts with exponential backoff. The terminal failure state is defined in TD-11.

**Decision:** A (same codebase, separate entrypoint and container)

---

## TD-08: Thumbnail Generation Strategy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must produce one thumbnail per video automatically. The frame-selection method sets CPU cost and how useful the image is. Format and dimensions become part of what later phases render: the management panel in Phase 04 and listings and the player in Phase 05.

**Options:**

### Option A: Fixed relative offset with fast input seek
- After ffprobe returns the duration, grab one frame at a fixed fraction (e.g., 10% of duration, clamped for very short videos) using `-ss` before `-i`, scale it, and encode it as JPEG.
- **Pros:** Cheap: it decodes about one GOP, which works well over HTTP range reads (TD-07). Deterministic and testable with a fixture video. Skips black intro frames in most content.
- **Cons:** Can land on a transition or a dark frame. No content awareness.

### Option B: FFmpeg `thumbnail` filter over a window
- Decode a window of frames (e.g., the first N seconds after an offset) and let the `thumbnail` filter pick the most representative one.
- **Pros:** Better frame quality on average, with fewer black or blurry picks.
- **Cons:** Decodes many frames, so CPU and bytes read grow with the window size. Less deterministic, which makes assertions harder.

### Option C: First frame
- Grab frame 0.
- **Pros:** Cheapest and simplest.
- **Cons:** Often black or a title card, so thumbnails look poor.

**Recommendation:** **Option A (fixed 10% offset, fast seek)**, output as a JPEG with 1280 px maximum width, aspect preserved. One cheap and deterministic frame read fits the "sem impacto" goal and the range-read approach in TD-07. JPEG renders everywhere with no format negotiation. Phase 04 introduces custom thumbnails, so an uploader unhappy with the automatic frame has a remedy, which makes B's extra CPU hard to justify now. The output key follows TD-02.

**Decision:** A (10% offset fast seek, JPEG ≤ 1280 px wide)

---

## TD-09: Unique Public Video ID for the Video URL

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The plan asks for "uma URL curta e única que nunca conflite com outro vídeo". Phase 05 will make unlisted videos reachable "apenas via link direto", so the identifier also must not be guessable or enumerable. The ID appears in API routes, the database (unique column) and future frontend routes (`/watch/{id}`). Internal primary keys across the schema are UUIDs (`users`, `channels`).

**Options:**

### Option A: Use the UUID primary key in the URL
- Expose `videos.id` (UUID v4) directly.
- **Pros:** Nothing to generate or index, no collision handling, unguessable.
- **Cons:** 36 characters is not "short", and the internal primary key leaks into public URLs.

### Option B: Random short public ID (11-char base64url) in its own unique column
- Generate 8 random bytes with `node:crypto`, encode them as 11 base64url characters (64-bit space), store them in `videos.public_id` with a unique index, and retry on the (astronomically rare) unique violation. The UUID primary key stays internal.
- **Pros:** Short, URL-safe, unguessable and non-sequential (suits unlisted). The database guarantees no conflicts. No dependency: `nanoid` 6 is ESM-only, which adds friction with the CommonJS/Jest setup.
- **Cons:** One extra column and index, plus a retry path to test.

### Option C: Encoded sequence (Sqids/Hashids over a bigint sequence)
- Map an auto-increment sequence to a short alphabet string.
- **Pros:** Shortest IDs, collision-free by construction.
- **Cons:** Reversible and ordered, so anyone who knows the encoding can enumerate videos, which breaks unlisted privacy (Phase 05). It needs a bigint sequence in addition to the UUID.

**Recommendation:** **Option B (random 11-char base64url `public_id`, unique index)**. It meets both requirements in the plan, short and never conflicting, and stays unguessable, which the unlisted visibility in Phases 04 and 05 depends on. The UUID primary key remains the internal reference for foreign keys and storage keys (TD-02). Every public route and the frontend use `public_id`.

**Decision:** B (random 11-char base64url `public_id`, unique index)

---

## TD-10: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, which means HTTP `Range` / `206 Partial Content` for `<video>` seeking, and users must be able to download the file. The diagram has the frontend streaming directly from object storage. Anonymous users can watch (Overview; Phase 05), so read access is public for playable videos. Under Strict BFF, the browser gets the media URL through a Next Route Handler.

**Options:**

### Option A: API issues short-lived presigned GET URLs (JSON), storage serves bytes
- A public endpoint (e.g., `GET /videos/{publicId}/stream`) returns `{ url, expiresAt }`, a presigned `GetObject` on the public endpoint (TD-05). Storage answers `Range` with `206` natively. Download uses the same mechanism with `ResponseContentDisposition: attachment; filename="..."`.
- **Backend impact:** Only signing, no bytes. Videos stay private in the bucket.
- **Frontend impact:** The BFF fetches the JSON and renders `<video src={url}>`. When the URL expires, it fetches a new one. Storage CORS must allow `GET` and `Range` from the frontend origin.
- **Cons:** The URL lifetime must cover a viewing session (hours, not minutes), or seeking after expiry fails until the frontend refreshes the URL.

### Option B: API proxies bytes with `Range` passthrough
- The API forwards the `Range` header to `GetObject` and pipes the body back with `206`, `Content-Range` and `Accept-Ranges`.
- **Backend impact:** Full control (auth per request, counters), but every streamed byte occupies the API, and the BFF too under Strict BFF.
- **Frontend impact:** A stable same-origin URL, no expiry handling.
- **Cons:** Throughput limited by the API and BFF processes, against the "sem impacto" goal and the diagram's frontend → storage path.

### Option C: Public-read bucket with direct object URLs
- Make the videos bucket anonymously readable, and let the API return a plain object URL.
- **Pros:** No signing, permanent URLs, CDN-friendly.
- **Cons:** Anyone who knows or guesses a key can read any object, including unprocessed or failed uploads. No hook remains for the unlisted rules of Phases 04 and 05.

**Recommendation:** **Option A (presigned GET via a JSON endpoint)**. Storage already implements `Range`/`206` correctly, so delivery stays off the API and BFF hot path, matching the diagram. The bucket stays private, so Phases 04 and 05 can add visibility rules at the signing endpoint without changing the transport. Returning JSON instead of a `302` keeps the BFF a plain Route Handler and makes expiry explicit for the frontend. The endpoint is `@Public()` and only signs for videos in the `ready` processing state (TD-11). Other states get a domain error.

**Decision:** A (presigned GET via JSON endpoint)

---

## TD-11: Video Status Model and Failure Handling

**Scope:** Cross-layer

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Phase 03 creates the video "como rascunho ao iniciar o upload" and moves it through upload and processing. Phase 04 adds "Fluxo de rascunho → publicação" and visibility (public/unlisted). The status shape is part of the database schema (enum type + migration), of the worker's update logic and of the API response the frontend will show in Phase 04's panel ("status"). Deciding it now avoids an enum rewrite in Phase 04.

**Options:**

### Option A: Single status enum covering upload and processing (`draft → processing → ready | failed`)
- `draft` means created and still uploading. `complete` moves the video to `processing`, and the worker sets `ready` or `failed`.
- **Pros:** One column, simple transitions.
- **Cons:** "Draft" is a publication concept (Phase 04), but here it would mean "upload not finished". Phase 04 would then need either a second meaning for `draft` or new enum values such as `published`, mixing two state machines in one column (e.g., a published video that fails reprocessing).

### Option B: Two orthogonal fields — processing status + publication status
- `processing_status`: `awaiting_upload → processing → ready | failed`, owned by the upload and worker pipeline. `publication_status`: `draft` (the only value in Phase 03), which Phase 04 extends with publishing and visibility.
- **Pros:** Each state machine has one owner. Meets the literal "pré-cadastro como rascunho" now, and Phase 04 extends publication without touching the pipeline enum.
- **Cons:** Two enum columns. Phase 03 ships a column with a single value.

### Option C: Single enum including publication (`uploading, processing, ready, failed, published`)
- One linear state machine through publication.
- **Pros:** One column, and the panel reads a single field.
- **Cons:** It assumes publication only happens after `ready` and never changes afterward. It cannot express "draft and ready" vs "published and ready" without more values, so it grows into a cross-product of the two machines.

**Recommendation:** **Option B (separate `processing_status` and `publication_status`)**. The two capabilities, "rascunho" (publication) and processing, are independent machines with different owners: the pipeline in Phase 03 and the user in Phase 04. Keeping them apart avoids reshaping the enum in Phase 04. Transitions are guarded in the service: `complete` is only accepted from `awaiting_upload`, and the worker only acts on `processing`, so a redelivered job is a no-op once the video is `ready`. When the job fails its final retry attempt (TD-03, TD-07), the worker sets `failed` with a short `failure_reason`. User-triggered reprocessing is out of scope.

**Decision:** B (`processing_status` + `publication_status`)

---

## TD-12: Abandoned Upload Cleanup

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** With TD-04, every init creates a draft row and an open multipart upload. Uploaded parts of an abandoned upload use storage space (up to 10 GB each) while staying invisible as objects, and the draft row stays in `awaiting_upload` forever. The plan's "Armazenamento" concern asks for cost planning from the start. The TD-06 crash window (completed but not enqueued) also needs a recovery path.

**Options:**

### Option A: Storage lifecycle rule (`AbortIncompleteMultipartUpload` after N days)
- Configure the videos bucket to abort incomplete multipart uploads automatically.
- **Pros:** No application code; storage enforces it.
- **Cons:** Support differs by product and is unverified for TD-01's choice. Database rows are never reconciled: drafts stay `awaiting_upload` forever. It does not cover the TD-06 crash window.

### Option B: Scheduled sweep job in the worker (queue job scheduler)
- A repeatable job (e.g., hourly) finds videos in `awaiting_upload` older than a threshold, calls `AbortMultipartUpload` and marks them `failed` (or deletes them). It also re-enqueues videos that were completed but never processed.
- **Pros:** Storage and database stay consistent, it works on any S3-compatible backend, and it closes the TD-06 gap. The queue already ships job schedulers (TD-03), so no extra infrastructure is needed.
- **Cons:** More code and tests. The threshold has to be chosen against the presigned part URL lifetime and realistic 10 GB upload times on slow links.

### Option C: Defer cleanup to a later phase
- **Pros:** Smallest Phase 03 scope.
- **Cons:** Orphaned parts pile up unseen from day one, against the storage-cost concern. The TD-06 crash window stays open.

**Recommendation:** **Option B (scheduled sweep job)**. It is the only option that keeps database and storage consistent and closes the completed-but-not-enqueued gap from TD-06, and it reuses the queue scheduler instead of relying on storage features of uncertain support. A 24 h threshold for `awaiting_upload` gives ample margin for slow 10 GB uploads while bounding orphaned storage. Option A can be added later as a second safety net if TD-01's backend supports it.

**Decision:** B (scheduled sweep job in the worker)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object storage service for Compose | B — RustFS 1.0 (pinned; S3 API only; fallback MinIO pinned) | B |
| TD-02 | Backend | Storage layout (buckets & keys) | B — separate `videos` / `thumbnails` buckets, UUID-derived keys | B |
| TD-03 | Backend | Background job queue | A — BullMQ + Redis via `@nestjs/bullmq` | A |
| TD-04 | Cross-layer | Upload protocol (10 GB) | A — presigned S3 multipart, browser → storage | A |
| TD-05 | Cross-layer | Presign endpoint topology | A — internal `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT` | A |
| TD-06 | Backend | Processing trigger | A — API `complete` endpoint enqueues (`jobId = videoId`) | A |
| TD-07 | Backend | Worker deployment & codebase | A — same codebase, separate entrypoint + container | A |
| TD-08 | Backend | Thumbnail generation | A — 10% offset fast seek, JPEG ≤ 1280 px wide | A |
| TD-09 | Cross-layer | Unique public video ID | B — random 11-char base64url `public_id` | B |
| TD-10 | Cross-layer | Streaming & download delivery | A — presigned GET via JSON endpoint | A |
| TD-11 | Cross-layer | Video status model | B — `processing_status` + `publication_status` | B |
| TD-12 | Backend | Abandoned upload cleanup | B — scheduled sweep job in the worker | B |

**Dependencies:** TD-04 → TD-01, TD-05 · TD-06 → TD-03, TD-04 · TD-07 → TD-03, TD-05 · TD-08 → TD-07, TD-02 · TD-10 → TD-05, TD-11 · TD-12 → TD-03, TD-04, TD-06.

**Not a TD here (resolved by best practices or inherited patterns):** endpoint ownership authorization (JWT `sub` → the user's single channel, checked in the service; the global guard is inherited from `phase-02-auth/TD-02`); queue job options such as attempts and backoff values; the Redis/Valkey image choice; migration and entity shape beyond the status columns; FFmpeg argument details.

## Sources

- MinIO Community status: [InfoQ — MinIO S3 API alternatives (Dec 2025)](https://infoq.com/news/2025/12/minio-s3-api-alternatives/), [MinIO maintenance mode explained](https://alexandre-vazquez.com/minio-maintenance-mode-s3-open-source-alternatives/), [MinIO container images gone? (DevPro)](https://devpro.fr/minio-container-images-gone-best-alternatives-2025/)
- RustFS 1.0 GA: [Linuxiac](https://linuxiac.com/rustfs-1-0-s3-compatible-object-storage-reaches-ga/), [aicybr](https://aicybr.com/blog/rustfs-1-0-ga-s3-object-storage)
- SeaweedFS S3 API: [SeaweedFS wiki — Amazon S3 API](https://github.com/chrislusf/seaweedfs/wiki/Amazon-S3-API)
- BullMQ PostgreSQL backend and v6 changelog: [docs.bullmq.io/guide/postgresql](https://docs.bullmq.io/guide/postgresql), [docs.bullmq.io/changelog](https://docs.bullmq.io/changelog); `@nestjs/bullmq` API via context7 (`/nestjs/bull`)
- AWS SDK v3 custom endpoint / presigner: context7 (`/aws/aws-sdk-js-v3`); S3 `UploadPart` limits: [AWS S3 API — UploadPart](https://docs.amazonaws.cn/AmazonS3/latest/API/API_UploadPart.html)

---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-14
scope_description: "Video upload and processing on top of the given S3-compatible object storage (MinIO locally): storage layout, background job queue, 10GB direct-to-storage upload protocol, presigned-URL endpoint topology, processing trigger, video worker deployment, thumbnail generation, unique public video ID, streaming/download delivery, video status lifecycle, and abandoned-upload cleanup."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns every TD below: new Compose services (object storage, queue backend, video worker), S3 client and presigning, the `videos` table linked to `channels`, upload/stream/download endpoints, the job producer and the FFmpeg worker.
- `next-frontend/` — no open decision. Phase 03 is a backend phase: it has no screen bullet, and the video UI is out of scope (management panel in Phase 04, player page in Phase 05). The `Cross-layer` TDs below (TD-03, TD-04, TD-08, TD-09, TD-10) only set the API contracts a future client will consume. They follow the inherited Strict BFF rule (`next-frontend-config-base/TD-03`), which already anticipates presigned object-storage URLs as the path for large payloads. No frontend code is part of this phase.

**Given / inherited constraints (not reopened):**

- **Object storage is S3-compatible, with MinIO running locally in Docker Compose** (architecture diagram: "Object Storage — S3 or MinIO"). Production would use S3. The backend talks to it only through the S3 API (`@aws-sdk/client-s3` v3 with `endpoint` + `forcePathStyle: true`), so swapping MinIO for S3 changes configuration, not code. This document decides how storage is used (layout, presigning, delivery), not which product. _Risk note:_ MinIO stopped publishing Community images in October 2025 and archived the community repository in February 2026. The Compose image must therefore be pinned to an exact release tag, and the infra SI must prove the S3 features this phase relies on (presigned multipart, presigned GET with `Range`, bucket CORS) in an integration test against the running container.
- Global `JwtAuthGuard` + `@Public()` opt-out (`phase-02-auth/TD-02`).
- Domain error envelope via `DomainExceptionFilter` (`phase-02-auth/TD-07`).
- class-validator DTOs (`phase-02-auth/TD-06`).
- Namespaced `registerAs` config + Joi env schema (`phase-01-configuracao-base/TD-01..TD-04`).
- One channel per user (`channels.user_id` unique).
- Docker Compose service names as hosts (root `CLAUDE.md`).

**Installed versions checked:** NestJS 11, TypeORM 0.3.28, `pg` 8.20, Node 25.6 (container), Jest 30. Candidate libraries checked against the npm registry on 2026-11-14:

- `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` 3.1169.0
- `bullmq` 6.7.6
- `@nestjs/bullmq` 12.0.2 (peer `@nestjs/common` ^11 and `bullmq` ^6)
- `pg-boss` 12.38.2
- `nanoid` 6.0.2
- `fluent-ffmpeg` 2.1.3, marked **deprecated** on npm

---

## TD-01: Storage Layout — Buckets and Object Key Scheme

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The API writes keys (when it starts the multipart upload), the worker reads the source and writes the thumbnail, and the delivery endpoints presign reads. All three must agree on bucket names and key shapes, and the bucket names also appear in env/config and in the Compose bootstrap that creates them in MinIO. The project plan asks for storage growth and cost to be planned from the start.

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

## TD-02: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The diagram leaves the message queue as "TBD". This is the main open stack choice of the phase. The API publishes a processing job after the upload completes, and the worker consumes it. The job runs ffprobe and ffmpeg, so retries, backoff, concurrency and deduplication matter. The `nestjs-best-practices` skill (`micro-use-queues`) points to `@nestjs/bullmq`. BullMQ 6 (2026-07-30) added pluggable backends, including PostgreSQL.

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

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)**. It is the documented NestJS path, and the processing job needs exactly what it ships: attempts with backoff, `jobId` deduplication for idempotent enqueue, worker concurrency, and a job scheduler (used by TD-11). The one cost is one extra container, which is the queue box the architecture diagram already reserves. Option B is the natural fallback if an extra container must be avoided, since application code would not change. Its newness argues against making it the default for the core pipeline.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-03: Upload Protocol for Files up to 10 GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10 GB upload must not tie up the API, and the plan ("Pontos de Atenção") requires resuming after a dropped connection. The protocol defines the handshake on both sides: what the backend exposes and how a client splits and sends the file. On the frontend, the Strict BFF rule (`next-frontend-config-base/TD-03`) routes every API call through Next.js Route Handlers. That TD already notes that large payloads would need presigned object-storage URLs rather than the backend URL. S3 multipart limits: parts from 5 MiB to 5 GiB (the last part may be smaller) and at most 10,000 parts.

**Options:**

### Option A: S3 multipart upload with presigned part URLs, client → MinIO directly
- The API creates the multipart upload and the draft video, signs `UploadPart` URLs for the part numbers requested, and completes or aborts the upload. The client `PUT`s each slice straight to storage and collects the `ETag`s.
- **Backend impact:** Only small JSON requests. No file bytes pass through Nest (or a BFF). Resuming relies on `ListParts` plus re-signing any missing parts.
- **Frontend impact:** A future client slices the `File`, runs parallel `PUT`s and tracks `ETag`s. The bucket CORS policy must allow `PUT` from the frontend origin and expose `ETag`.
- **Cons:** The protocol is custom, with three or four API calls to design and test. Clients need a reachable storage host (TD-04).

### Option B: tus resumable protocol through the API (`@tus/server` + `@tus/s3-store`)
- The client uses `tus-js-client` against a tus endpoint in Nest, and the server streams the chunks into S3 multipart.
- **Backend impact:** A standard resumable protocol with off-the-shelf clients, but every byte of 10 GB flows through the API process: CPU, memory, sockets and timeouts.
- **Frontend impact:** A drop-in client. Under Strict BFF, the bytes would also flow through a Next Route Handler, a second hop for the full payload.
- **Cons:** It conflicts with "sem impacto na performance" and doubles the transfer path.

### Option C: Streamed `multipart/form-data` through the API to storage
- The API streams the request body (busboy) into `@aws-sdk/lib-storage` `Upload`.
- **Backend impact:** The simplest client: one request. But a single 10 GB request has no resume, and a dropped connection restarts from zero.
- **Frontend impact:** Trivial form post, but proxied through the BFF as well.
- **Cons:** No resume, which the plan requires. The API is occupied for the whole transfer: the file passes through the API, which is exactly what must be avoided.

**Recommendation:** **Option A (presigned S3 multipart, direct to storage)**. It is the only option where no video bytes cross the API (or a BFF), so it satisfies "sem impacto na performance" and fits the Strict BFF rule. Resume comes from `ListParts` plus re-signing. The backend sets the part size and returns it in the init response. 64 MiB would be a reasonable value: a 10 GB file then needs about 160 parts, well inside the 5 MiB–5 GiB and 10,000-part limits. The backend enforces the 10 GB ceiling twice: it rejects declared sizes above it at init, and it checks the assembled object size before accepting `complete`. Part URLs are short-lived and re-signed on demand. Depends on TD-04 (public endpoint for signing).

**Decision:** A (presigned S3 multipart, client → storage directly)

---

## TD-04: Presigned URL Endpoint Topology (internal vs public storage host)

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Inside Compose, the API and worker reach MinIO at `http://minio:9000` (root `CLAUDE.md`: always use service names). A client outside the Compose network cannot resolve `minio`: it reaches the host-mapped port (e.g., `http://localhost:9000`). SigV4 signs the `Host` header, so a URL signed for `minio` cannot be rewritten to `localhost` afterwards. The decision touches the env schema, `.env.example`, Compose port mapping and S3 client construction, and it sets which host every presigned URL in TD-03 and TD-09 carries.

**Options:**

### Option A: Two endpoints — internal for operations, public for client-facing presigning
- `S3_ENDPOINT=http://minio:9000` for server-side calls (create/complete/abort multipart, `ListParts`, `HeadObject`, worker reads and writes). `S3_PUBLIC_ENDPOINT=http://localhost:9000` is used only by a second client that presigns URLs handed to external clients. Presigning is computed locally, so the public client never needs to reach the host itself.
- **Pros:** Follows the service-name rule for every server-to-storage hop, and gives client URLs a reachable host. In production, `S3_PUBLIC_ENDPOINT` becomes the CDN or public S3 hostname without code changes.
- **Cons:** Two S3 clients to configure and inject. Developers must remember which one presigns for external clients and which presigns for the worker.

### Option B: One hostname resolvable from both containers and the host machine
- Use `http://minio:9000` everywhere and make it resolve on the developer machine too, by adding `127.0.0.1 minio` to the host's hosts file.
- **Pros:** One client, one env key.
- **Cons:** Requires manual changes on every developer machine, outside the repo. Fragile in WSL and CI. It also leaks a dev-only DNS hack into the setup docs.

### Option C: Proxy storage through an application origin (rewrite `/storage/*` → MinIO)
- Clients use same-origin URLs, and the API or Next rewrites them to MinIO. That also removes the need for bucket CORS.
- **Pros:** No CORS, and only one public origin.
- **Cons:** Every uploaded and streamed byte flows through the proxy process, which defeats TD-03 (direct-to-storage) and TD-09. Signatures must be computed for the proxied host, which brings the same mismatch back.

**Recommendation:** **Option A (internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT`)**. It is the only option that keeps the Compose service-name rule for server traffic and still hands clients reachable URLs without per-machine setup. The production story (S3 or a CDN host) is a value change, not a code change. URLs the worker uses for its own reads (TD-06) are signed with the internal client.

**Decision:** A (internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT`)

---

## TD-05: Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the file is fully in storage. Something has to observe "upload finished" and publish the job. Depends on TD-02 (queue) and TD-03 (who completes the multipart upload).

**Options:**

### Option A: The API's `complete` endpoint publishes the job
- After `CompleteMultipartUpload` and the size check succeed, the service moves the video to `processing` and enqueues the job with `jobId = videoId`.
- **Pros:** One code path that the API controls, and easy to test end to end. Enqueue is idempotent via `jobId`. It works identically on MinIO and S3.
- **Cons:** If the API crashes after completing but before enqueueing, the video stays stuck. This needs a recovery path (the TD-11 sweep covers it) or ordered writes.

### Option B: MinIO bucket event notifications
- MinIO emits `s3:ObjectCreated:CompleteMultipartUpload` to a configured target (webhook, AMQP, Redis), and a consumer maps the object key to a video and enqueues the job.
- **Pros:** It fires even if the client never calls `complete` on the API.
- **Cons:** Notification targets are configured differently in MinIO and in S3 (EventBridge/SQS/SNS), and they are hard to bootstrap in Compose and tests. The client still has to call the API to finish the multipart upload anyway, because `CompleteMultipartUpload` needs the `ETag` list. It adds an extra hop and makes the contract depend on the storage vendor.

**Recommendation:** **Option A (API `complete` endpoint publishes the job)**. The client already has to call the API to complete the multipart upload, so that call is the natural trigger. A stays inside the plain S3 API that both MinIO and production S3 share, while B ties the pipeline to vendor-specific notification setup. The crash window is closed by deduplicating with `jobId` and by the scheduled sweep in TD-11.

**Decision:** A (API `complete` endpoint enqueues, `jobId = videoId`)

---

## TD-06: Video Worker Deployment and Codebase

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram shows a separate "Video Worker (FFmpeg)" container that reads and writes storage and updates the database. FFmpeg work is CPU-heavy and must not slow the API. The decision sets the Compose topology, the image (FFmpeg binaries) and where the worker code lives. It also decides how the worker reads a source of up to 10 GB to extract metadata (ffprobe) and a thumbnail (ffmpeg).

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- A `worker` entrypoint boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). It reuses the config, TypeORM entities and storage service, and runs as its own Compose service from an image that adds `ffmpeg`/`ffprobe`. The API process only produces jobs.
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

**Recommendation:** **Option A (same codebase, separate entrypoint and container)**. It isolates the CPU-heavy work as the architecture requires without duplicating the domain model across two packages. The worker reads the source through a presigned GET signed with the internal endpoint (TD-04), passed straight to `ffprobe`/`ffmpeg` as an HTTP input. Both tools use HTTP range reads, so metadata extraction and a seek-based thumbnail grab never download all 10 GB to local disk. FFmpeg is called through `node:child_process` (`spawn`, argument array, no shell), because `fluent-ffmpeg` is deprecated on npm. Retries use queue attempts with exponential backoff. The terminal failure state is defined in TD-10.

**Decision:** A (same codebase, separate entrypoint and container)

---

## TD-07: Thumbnail Generation Strategy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must produce one thumbnail per video automatically. The frame-selection method sets CPU cost and how useful the image is. Format and dimensions become part of what later phases render: the management panel in Phase 04 and listings and the player in Phase 05.

**Options:**

### Option A: Fixed relative offset with fast input seek
- After ffprobe returns the duration, grab one frame at a fixed fraction (e.g., 10% of duration, clamped for very short videos) using `-ss` before `-i`, scale it, and encode it as JPEG.
- **Pros:** Cheap: it decodes about one GOP, which works well over HTTP range reads (TD-06). Deterministic and testable with a fixture video. Skips black intro frames in most content.
- **Cons:** Can land on a transition or a dark frame. No content awareness.

### Option B: FFmpeg `thumbnail` filter over a window
- Decode a window of frames (e.g., the first N seconds after an offset) and let the `thumbnail` filter pick the most representative one.
- **Pros:** Better frame quality on average, with fewer black or blurry picks.
- **Cons:** Decodes many frames, so CPU and bytes read grow with the window size. Less deterministic, which makes assertions harder.

### Option C: First frame
- Grab frame 0.
- **Pros:** Cheapest and simplest.
- **Cons:** Often black or a title card, so thumbnails look poor.

**Recommendation:** **Option A (fixed 10% offset, fast seek)**, output as a JPEG with 1280 px maximum width, aspect preserved. One cheap and deterministic frame read fits the "sem impacto" goal and the range-read approach in TD-06. JPEG renders everywhere with no format negotiation. Phase 04 introduces custom thumbnails, so an uploader unhappy with the automatic frame has a remedy, which makes B's extra CPU hard to justify now. The output key follows TD-01.

**Decision:** A (10% offset fast seek, JPEG ≤ 1280 px wide)

---

## TD-08: Unique Public Video ID for the Video URL

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The plan asks for "uma URL curta e única que nunca conflite com outro vídeo". Phase 05 will make unlisted videos reachable "apenas via link direto", so the identifier also must not be guessable or enumerable. The ID appears in API routes, the database (unique column) and future frontend routes. Internal primary keys across the schema are UUIDs (`users`, `channels`).

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

**Recommendation:** **Option B (random 11-char base64url `public_id`, unique index)**. It meets both requirements in the plan, short and never conflicting, and stays unguessable, which the unlisted visibility in Phases 04 and 05 depends on. The UUID primary key remains the internal reference for foreign keys and storage keys (TD-01). Every public route uses `public_id`.

**Decision:** B (random 11-char base64url `public_id`, unique index)

---

## TD-09: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, which means HTTP `Range` / `206 Partial Content` for seeking, and users must be able to download the file. The diagram has the frontend streaming directly from object storage. Anonymous users can watch (Overview; Phase 05), so read access is public for playable videos.

**Options:**

### Option A: API issues short-lived presigned GET URLs (JSON), MinIO serves bytes
- A public endpoint (e.g., `GET /videos/{publicId}/stream`) returns `{ url, expiresAt }`, a presigned `GetObject` on the public endpoint (TD-04). MinIO answers `Range` with `206` natively. Download uses the same mechanism with `ResponseContentDisposition: attachment; filename="..."`.
- **Backend impact:** Only signing, no bytes. Videos stay private in the bucket.
- **Frontend impact:** A future client sets `<video src={url}>` and fetches a new URL when it expires. Bucket CORS must allow `GET` with `Range` from the frontend origin.
- **Cons:** The URL lifetime must cover a viewing session (hours, not minutes), or seeking after expiry fails until the client refreshes the URL.

### Option B: API proxies bytes with `Range` passthrough
- The API forwards the `Range` header to `GetObject` and pipes the body back with `206`, `Content-Range` and `Accept-Ranges`.
- **Backend impact:** Full control (auth per request, counters), but every streamed byte occupies the API, and a BFF too under Strict BFF.
- **Frontend impact:** A stable same-origin URL, no expiry handling.
- **Cons:** Throughput limited by the API process, against the "sem impacto" goal and the diagram's frontend → storage path.

### Option C: Public-read bucket with direct object URLs
- Make the videos bucket anonymously readable, and let the API return a plain object URL.
- **Pros:** No signing, permanent URLs, CDN-friendly.
- **Cons:** Anyone who knows or guesses a key can read any object, including unprocessed or failed uploads. No hook remains for the unlisted rules of Phases 04 and 05.

**Recommendation:** **Option A (presigned GET via a JSON endpoint)**. MinIO and S3 already implement `Range`/`206` correctly, so delivery stays off the API hot path, matching the diagram. The bucket stays private, so Phases 04 and 05 can add visibility rules at the signing endpoint without changing the transport. Returning JSON instead of a `302` keeps a future BFF a plain Route Handler and makes expiry explicit for the client. The endpoints are `@Public()` and only sign for videos with status `ready` (TD-10). Other states get a domain error.

**Decision:** A (presigned GET via JSON endpoint)

---

## TD-10: Video Status Lifecycle and Failure Handling

**Scope:** Cross-layer

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Phase 03 creates the video "como rascunho ao iniciar o upload" and moves it through upload and processing. The status cycle (rascunho → processando → pronto/erro) must be reflected in the database, and the failure outcome must be defined. The status shape is part of the database schema (enum type + migration), of the worker's update logic and of the API responses. Phase 04 later adds "Fluxo de rascunho → publicação" and visibility (public/unlisted).

**Options:**

### Option A: Single status enum `draft → processing → ready | failed`
- `draft` is set at pre-registration (upload init) and stays while the upload is in progress. `complete` moves the video to `processing`, and the worker sets `ready` or `failed`.
- **Pros:** One column that mirrors the lifecycle in the plan literally. Simple transitions, a single source of truth for the API and the worker.
- **Cons:** In Phase 04, `draft` must also coexist with publication. That phase has to add publication and visibility in fields of their own (e.g., visibility, `published_at`) instead of overloading this enum.

### Option B: Two orthogonal fields — processing status + publication status
- `processing_status` (`awaiting_upload → processing → ready | failed`) plus `publication_status` (`draft` now, extended in Phase 04).
- **Pros:** Each state machine has one owner, so Phase 04 never touches the pipeline enum.
- **Cons:** "Rascunho → processando → pronto/erro" no longer reads as one cycle in the database. Phase 03 ships a column with a single value.

### Option C: Single enum including publication (`draft, processing, ready, failed, published`)
- One linear state machine through publication.
- **Pros:** One column, and the panel reads a single field.
- **Cons:** It assumes publication only happens after `ready` and never changes afterward. It grows into a cross-product of processing and publication states.

**Recommendation:** **Option A (single enum `draft → processing → ready | failed`)**. It reflects the phase's lifecycle one-to-one in the database, which is what this phase must deliver, and keeps one source of truth for the API and the worker. The cost lands in Phase 04, which adds publication and visibility as separate fields rather than new values of this enum. Transitions are guarded in the service: `complete` is only accepted from `draft`, and the worker only acts on `processing`, so a redelivered job is a no-op once the video is `ready`. When the job fails its final retry attempt (TD-02, TD-06), the worker sets `failed` with a short `failure_reason`. User-triggered reprocessing is out of scope.

**Decision:** A (single enum `draft → processing → ready | failed`)

---

## TD-11: Abandoned Upload Cleanup

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** With TD-03, every init creates a `draft` row and an open multipart upload. Uploaded parts of an abandoned upload use storage space (up to 10 GB each) while staying invisible as objects, and the row stays `draft` forever. The plan's "Armazenamento" concern asks for cost planning from the start. The TD-05 crash window (completed but not enqueued) also needs a recovery path.

**Options:**

### Option A: Rely on storage-side expiry of incomplete multipart uploads
- MinIO expires stale incomplete multipart uploads on the server side, and S3 offers an `AbortIncompleteMultipartUpload` lifecycle rule.
- **Pros:** No application code; storage enforces it.
- **Cons:** Configured differently in MinIO and S3. Database rows are never reconciled: abandoned videos stay `draft` forever. It does not cover the TD-05 crash window.

### Option B: Scheduled sweep job in the worker (queue job scheduler)
- A repeatable job (e.g., hourly) finds `draft` videos with an open upload older than a threshold, calls `AbortMultipartUpload` and marks them `failed`. It also re-enqueues `processing` videos that have no job in the queue.
- **Pros:** Storage and database stay consistent, it behaves the same on MinIO and S3, and it closes the TD-05 gap. The queue already ships job schedulers (TD-02), so no extra infrastructure is needed.
- **Cons:** More code and tests. The threshold has to be chosen against the presigned part URL lifetime and realistic 10 GB upload times on slow links.

### Option C: Defer cleanup to a later phase
- **Pros:** Smallest Phase 03 scope.
- **Cons:** Orphaned parts pile up unseen from day one, against the storage-cost concern. The TD-05 crash window stays open.

**Recommendation:** **Option B (scheduled sweep job)**. It is the only option that keeps database and storage consistent and closes the completed-but-not-enqueued gap from TD-05, without depending on storage configuration that differs between MinIO and S3. A 24 h threshold for `draft` uploads gives ample margin for slow 10 GB uploads while bounding orphaned storage. Storage-side expiry (A) can stay on as a second safety net.

**Decision:** B (scheduled sweep job in the worker)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Storage layout (buckets & keys) | B — separate `videos` / `thumbnails` buckets, UUID-derived keys | B |
| TD-02 | Backend | Background job queue | A — BullMQ + Redis via `@nestjs/bullmq` | A |
| TD-03 | Cross-layer | Upload protocol (10 GB) | A — presigned S3 multipart, client → MinIO | A |
| TD-04 | Cross-layer | Presign endpoint topology | A — internal `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT` | A |
| TD-05 | Backend | Processing trigger | A — API `complete` endpoint enqueues (`jobId = videoId`) | A |
| TD-06 | Backend | Worker deployment & codebase | A — same codebase, separate entrypoint + container | A |
| TD-07 | Backend | Thumbnail generation | A — 10% offset fast seek, JPEG ≤ 1280 px wide | A |
| TD-08 | Cross-layer | Unique public video ID | B — random 11-char base64url `public_id` | B |
| TD-09 | Cross-layer | Streaming & download delivery | A — presigned GET via JSON endpoint | A |
| TD-10 | Cross-layer | Video status lifecycle | A — enum `draft → processing → ready \| failed` | A |
| TD-11 | Backend | Abandoned upload cleanup | B — scheduled sweep job in the worker | B |

**Dependencies:**

- TD-03 → TD-04
- TD-05 → TD-02, TD-03
- TD-06 → TD-02, TD-04
- TD-07 → TD-06, TD-01
- TD-09 → TD-04, TD-10
- TD-10 → TD-02, TD-06
- TD-11 → TD-02, TD-03, TD-05

**Not a TD here (given, or resolved by best practices and inherited patterns):**

- Choice of object storage product: MinIO, given (see constraints above).
- Endpoint ownership authorization: JWT `sub` → the user's single channel, checked in the service; the global guard is inherited from `phase-02-auth/TD-02`.
- Queue job options such as attempt counts and backoff values.
- The Redis/Valkey image choice.
- Entity shape beyond the status enum.
- FFmpeg argument details.

## Sources

- MinIO Community status: [InfoQ — MinIO S3 API alternatives (Dec 2025)](https://infoq.com/news/2025/12/minio-s3-api-alternatives/), [MinIO maintenance mode explained](https://alexandre-vazquez.com/minio-maintenance-mode-s3-open-source-alternatives/), [MinIO container images gone? (DevPro)](https://devpro.fr/minio-container-images-gone-best-alternatives-2025/)
- BullMQ PostgreSQL backend and v6 changelog: [docs.bullmq.io/guide/postgresql](https://docs.bullmq.io/guide/postgresql), [docs.bullmq.io/changelog](https://docs.bullmq.io/changelog); `@nestjs/bullmq` API via context7 (`/nestjs/bull`)
- AWS SDK v3 custom endpoint / presigner: context7 (`/aws/aws-sdk-js-v3`); S3 `UploadPart` limits: [AWS S3 API — UploadPart](https://docs.amazonaws.cn/AmazonS3/latest/API/API_UploadPart.html)

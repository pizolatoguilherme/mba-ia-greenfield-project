---
libs:
  "bullmq":
    version: "^6.7.6"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-14T10:04:00-03:00"
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-14T10:04:00-03:00"
  "ioredis":
    version: "^6.0.0"
    context7_id: "/redis/ioredis/v6.0.0"
    fetched_at: "2026-11-14T10:04:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1169.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-14T10:04:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1169.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-14T10:04:00-03:00"
  "ffmpeg / ffprobe":
    version: "Debian package in the worker image (exact version recorded when the worker Dockerfile is written)"
    context7_id: "/websites/ffmpeg_ffmpeg-all"
    fetched_at: "2026-11-14T10:04:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T10:03:29-03:00"
---

# Library References — Phase 03 (Upload e Processamento de Vídeos)

Distilled from Context7 on 2026-11-14 for the surfaces the decided TDs use. Versions are the latest checked on the npm registry on 2026-11-14 (`npm view`). Context7 did not have a snapshot for bullmq 6.7.6, so the closest one, `v6.5.3`, was used (same 6.x major).

### bullmq

Used by `phase-03-videos/TD-02` (queue), `TD-05` (idempotent enqueue), `TD-06` (retries) and `TD-11` (scheduler).

- **Deduplicated enqueue:** `queue.add(name, data, { jobId })`. Jobs that share a `jobId` are treated as duplicates and only the first is added. Caveat: if `removeOnComplete` / `removeOnFail` removes the job, a new job with the same id can be added again. → `jobId = videoId` per TD-05.
- **Retries:** `attempts: N` plus `backoff: { type: 'exponential', delay: ms }`. The wait between tries is 2^(attempts−1) × delay. An optional `jitter` spreads the retries. The terminal failure is the last attempt, and that is when TD-10 sets `failed`.
- **Workers:** concurrency is set through worker options. The `failed` / `completed` events are available on the Worker.
- **Redis connection:** workers need `maxRetriesPerRequest: null` on the ioredis connection. BullMQ sets this by default when it builds the connection, and only warns or throws when a user-provided ioredis instance overrides it.
- **BullMQ 6:** backends are pluggable. Redis clients (`ioredis` / `redis`) are optional peer dependencies, so the Redis backend needs `ioredis` installed explicitly. That is why `ioredis` is in TD-02 Libraries.
- **Repeatable work:** use the job scheduler API (`upsertJobScheduler`) for the hourly sweep in TD-11.

### @nestjs/bullmq

Used by `phase-03-videos/TD-02` and `TD-06` (worker on the same codebase with a separate entrypoint).

- **Root config:** `BullModule.forRootAsync({ inject: [ConfigService], useFactory: (config) => ({ connection: config.get(...) }) })`. This fits the inherited `registerAs` + `ConfigType` convention: inject the namespaced config key.
- **Queues:** `BullModule.registerQueue({ name, ... })` registers each queue (DI token `BullQueue_${name}`), and producers use `@InjectQueue(name)`. In tests, `getQueueToken(name)` resolves the Queue.
- **Consumers:** `@Processor(name, workerOptions?)` on a class that `extends WorkerHost` and implements `async process(job: Job)`. Throwing from `process` fails the job, which is then retried per its options. `this.worker` is only available after module init (`onApplicationBootstrap`), not in the constructor.
- **Events:** `@OnWorkerEvent('failed' | 'completed' | ...)` handlers bind to the processor's Worker.
- **Compatibility:** peer `@nestjs/common` / `@nestjs/core` `^10 || ^11 || ^12`, `bullmq` `^3 – ^6`. The project runs NestJS 11.

### ioredis

Redis client for the BullMQ Redis backend (`phase-03-videos/TD-02`).

- **Connection:** `new Redis({ host, port, username?, password?, db? })`. With BullMQ, pass `{ host, port }` connection options and let BullMQ create the client. The host is the Compose service name (root `CLAUDE.md`).
- **`maxRetriesPerRequest`:** defaults to 20, and `null` makes commands wait until the connection is back. BullMQ requires `null` for workers.

### @aws-sdk/client-s3

Used by `phase-03-videos/TD-01`, `TD-03`, `TD-04`, `TD-06`, `TD-09` and `TD-11`.

- **MinIO client:** `new S3Client({ endpoint, forcePathStyle: true, region, credentials })`. `forcePathStyle` puts the bucket in the path (`host/bucket/key`). TD-04 uses two instances: an internal one (`S3_ENDPOINT`) for operations and a public one (`S3_PUBLIC_ENDPOINT`) only for browser-facing presigning.
- **Multipart:**
  - `CreateMultipartUploadCommand` returns an `UploadId`.
  - `ListPartsCommand` supports resume.
  - `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`. `PartNumber` ranges from 1 to 10,000. Parts must be consecutive when additional checksums are used.
  - `AbortMultipartUploadCommand` is used by the TD-11 sweep.
- **Size check before `complete` (TD-03):** `HeadObjectCommand` returns `ContentLength`. Bucket CORS (`PUT`/`GET` with `Range`, exposing `ETag`) is configured with `PutBucketCorsCommand` or at bootstrap.
- **Range reads:** `GetObjectCommand` accepts `Range` and the `Response*` overrides (`ResponseContentDisposition`, `ResponseContentType`).

### @aws-sdk/s3-request-presigner

Used by `phase-03-videos/TD-03` (part URLs), `TD-06` (worker read URL) and `TD-09` (stream/download URLs).

- **API:** `getSignedUrl(client, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })` for part `PUT`s. `getSignedUrl(client, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="..."' }), { expiresIn })` for downloads. Streaming uses the same call without `ResponseContentDisposition`.
- **`expiresIn`:** in seconds, default 900, maximum 604,800 (7 days, SigV4 `MAX_PRESIGNED_TTL`). Decided values are 3,600 s for part URLs (`video-upload-delivery-limits/TD-02`) and 21,600 s for GET URLs (`video-upload-delivery-limits/TD-03`).
- **Signing headers:** `signableHeaders` / `unhoistableHeaders` force extra headers into the signature, for example `content-type`. Leave them unset unless the contract requires those headers on the client's request.
- **No network call:** presigning is computed locally, so the public-endpoint client never needs to reach its own host (TD-04).

### ffmpeg / ffprobe

Used by `phase-03-videos/TD-06` (metadata) and `TD-07` (thumbnail). Called through `node:child_process` `spawn` with an argument array, no shell. `fluent-ffmpeg` is deprecated on npm.

- **Metadata (TD-06 Revision):** `ffprobe -v error -print_format json -show_format -show_streams <url>` gives `format.duration`, `format.bit_rate`, `format.format_name` and per-stream `codec_type` / `codec_name` / `width` / `height`. These map to `duration_seconds`, `bitrate`, `container`, `video_codec`, `audio_codec`, `width` and `height`, and a trimmed copy goes to the `metadata` jsonb.
- **Thumbnail (TD-07):**
  - `-ss <pos>` placed **before** `-i` seeks the input to the closest seek point, so it does not decode everything up to `pos`.
  - `-frames:v 1` writes a single image.
  - `-vf scale=w=min(1280\,iw):h=-2` caps the width at 1280 px while preserving aspect ratio, with `-n` keeping the other dimension divisible.
  - Writing JPEG: `-f image2 out.jpg`, or `-f image2pipe -c:v mjpeg pipe:1` to stream it to the S3 upload.
- **HTTP input (TD-06):** the HTTP protocol supports range requests (`seekable`, plus `multiple_requests` / `request_size` for servers that throttle). A presigned GET URL can be passed directly as the input, so neither tool downloads the whole file.

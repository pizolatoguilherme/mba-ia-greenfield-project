# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec minio mc ready local` — expect `The cluster 'local' is ready` (the Compose healthcheck uses the same command; `docker compose ps` shows `healthy`)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker application context started`. The worker has no HTTP port.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video worker process (same image and codebase as the API, entrypoint `src/worker/main.ts`); runs `npm run start:worker:dev`, no published ports. Consumes the `video-processing` and `video-maintenance` queues
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — S3-compatible object storage (pinned Chainguard image), API `9000`, console `9001`; buckets `videos` and `thumbnails` are created by the app on startup
- `redis` — Redis 8 (BullMQ backend), port `6379`
- `mailpit` — SMTP sink for development e-mails, UI on port `8025`

The image installs FFmpeg from Debian (`ffmpeg`/`ffprobe` **5.1.9-0+deb12u1**), used by the worker. After changing `Dockerfile.dev`, rebuild with `docker compose build nestjs-api video-worker`.

### Storage endpoints — the one exception to the host rule

`S3_ENDPOINT=http://minio:9000` is the internal endpoint (API and worker, Compose service name). `S3_PUBLIC_ENDPOINT` is the endpoint baked into presigned URLs handed to browsers, so it must be reachable from the client: `http://localhost:9000` in local development. It is the only host variable that is not a Compose service name. Tests that fetch presigned URLs from inside the container override it to `http://minio:9000`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis and MinIO are ready
docker compose exec redis redis-cli ping
docker compose exec minio mc ready local

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Videos Module

Upload, processing and delivery of videos (Phase 03). Video bytes never pass through the API: clients upload and stream through presigned URLs straight to/from object storage.

- `src/videos/` — `VideosModule`: `videos.controller.ts`, `videos.service.ts`, DTOs in `dto/`, `Video` entity in `entities/video.entity.ts` (`ManyToOne` to `Channel`, FK `channel_id`; migration `src/database/migrations/1794671778699-CreateVideos.ts`).
- `src/storage/` — `StorageModule` / `StorageService` (AWS SDK S3 v3 against MinIO, internal and public clients) and `storage-keys.ts`.
- `src/worker/` — worker process: `processing/` (`process-video` consumer), `media/` (`ffprobe.ts`, `thumbnail.ts`, `probe-mapper.ts`), `maintenance/` (hourly sweep).

### Endpoints

| Method | Path | Auth | Success |
|---|---|---|---|
| `POST` | `/videos` | JWT | `201` — creates the `draft` row and opens the multipart upload |
| `POST` | `/videos/:publicId/upload/part-urls` | JWT, owner, `draft` | `200` — presigned PUT URLs for the requested parts |
| `GET` | `/videos/:publicId/upload/parts` | JWT, owner, `draft` | `200` — parts already uploaded (resume) |
| `POST` | `/videos/:publicId/upload/complete` | JWT, owner, `draft` | `202` — completes the multipart upload, sets `processing`, enqueues `process-video` |
| `GET` | `/videos/:publicId` | `@Public()` | `200` — video metadata (no internal ids or storage keys) |
| `GET` | `/videos/:publicId/stream` | `@Public()`, `ready` | `200` — presigned GET URL; storage serves HTTP range requests (`206`) |
| `GET` | `/videos/:publicId/download` | `@Public()`, `ready` | `200` — presigned GET URL with `Content-Disposition: attachment` |

`publicId` is the unique 11-char base64url id of the video URL (`public-id.util.ts`, unique column `public_id`). Domain errors: `VIDEO_NOT_FOUND` 404, `VIDEO_ACCESS_DENIED` 403, `VIDEO_NOT_DRAFT` / `VIDEO_NOT_READY` 409, `INVALID_PART_NUMBER` / `INVALID_UPLOAD_PARTS` 400, `VIDEO_TOO_LARGE` 413 (`src/common/exceptions/domain.exception.ts`). Request examples in `api.http`.

### Status lifecycle

`draft → processing → ready | failed` (`VideoStatus` enum). `failure_reason` values: `size_exceeded` (completed object above 10 GiB), `upload_abandoned` (sweep), `unreadable_media` (ffprobe cannot read it / no video stream, no retry), `processing_error` (last retry exhausted). Status updates are conditional on the current status, so re-delivered jobs are no-ops.

### Storage, queues and limits

- Buckets `videos` and `thumbnails`; keys derive only from the video UUID: `{id}/source` and `{id}/auto.jpg` (`storage-keys.ts`).
- Upload limits (`videos.constants.ts`): max `10737418240` bytes (10 GiB); content types `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`.
- Env (`src/config/storage.config.ts`): `UPLOAD_PART_SIZE_BYTES` (default 16 MiB), `UPLOAD_PART_URL_TTL_SECONDS` (3600), `DELIVERY_URL_TTL_SECONDS` (21600), `UPLOAD_ABANDON_AFTER_HOURS` (24). Redis: `REDIS_HOST=redis`, `REDIS_PORT`.
- Queue `video-processing`, job `process-video` (`videos.queue.ts`): `jobId = videoId`, 3 attempts, exponential backoff from 30 s.
- Queue `video-maintenance`, job `sweep-abandoned-uploads` (`video-maintenance.queue.ts`): job scheduler every hour; fails drafts idle beyond `UPLOAD_ABANDON_AFTER_HOURS` (aborting the multipart upload) and re-enqueues videos stuck in `processing`.

## Video Worker

- `npm run start:worker:dev` — worker in watch mode. It compiles to `dist-worker/` (via `tsconfig.worker.json`), separate from the API's `dist/`, because the API watcher deletes `dist/` on every restart (`deleteOutDir`). The `video-worker` container runs this script.
- `npm run start:worker:prod` — runs `dist/worker/main` from a regular `nest build`.
- The worker reads the source video through a presigned GET on the internal endpoint and pipes `ffprobe`/`ffmpeg` over HTTP range requests; it never writes the source to local disk.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Integration and e2e tests for videos run against the **real** `minio` and `redis` services (storage multipart, presigned URLs, queues), not mocks — both must be `healthy` before running the suite. Stop the dev worker while running the suite (`docker compose stop video-worker`, then `docker compose start video-worker`): it consumes the same queues and database as the tests and would process their jobs.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `transform` + `transformIgnorePatterns` for `@nestjs/bullmq` / `@nestjs/bull-shared` — both packages ship ESM only; the dedicated `ts-jest` rule compiles them to CommonJS for Jest. The runtime (Node 25) loads them natively.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

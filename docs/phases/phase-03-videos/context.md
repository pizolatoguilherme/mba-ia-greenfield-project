---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-14T07:55:58-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T10:03:29-03:00"
  docs/decisions/technical-decisions-video-upload-delivery-limits.md: "2026-11-14T09:54:48-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-14T07:56:05-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-14T07:56:05-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-14T07:56:05-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-11-14T07:56:05-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-14T07:56:05-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-14T07:56:05-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-14T07:56:05-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-14T10:04:29-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-14T07:55:58-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

> Depende de: Fase 01, Fase 02

Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named explicitly in the Phase 03 section of `docs/project-plan.md`._

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — depende de Fase 01.
- **Phase 04:** Gerenciamento de Vídeos e Canal — depende de Fase 02, Fase 03.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Storage Layout — Buckets and Object Key Scheme | decided | B (separate videos / thumbnails buckets, UUID-derived keys) | — |
| phase-03-videos/TD-02 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | bullmq@^6.7.6, @nestjs/bullmq@^12.0.2, ioredis@^6.0.0 |
| phase-03-videos/TD-03 | phase | Cross-layer | Upload Protocol for Files up to 10 GB | decided | A (presigned S3 multipart, client → storage directly) | @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0 |
|     └─ Last revision: 2026-11-14 — Upload-init contract: the request carries `filename`, `size`, `contentType` and… | | | | | | |
| phase-03-videos/TD-04 | phase | Cross-layer | Presigned URL Endpoint Topology (internal vs public host) | decided | A (internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT`) | — |
|     └─ Last revision: 2026-11-14 — Storage integration tests run against the real MinIO service in Compose… | | | | | | |
| phase-03-videos/TD-05 | phase | Backend | Processing Trigger | decided | A (API `complete` endpoint enqueues, `jobId = videoId`) | — |
| phase-03-videos/TD-06 | phase | Backend | Video Worker Deployment and Codebase | decided | A (same codebase, separate entrypoint and container) | ffmpeg / ffprobe (system binary, Debian package in the worker image) |
|     └─ Last revision: 2026-11-14 — Persisted metadata from ffprobe: typed columns `duration_seconds`, `width`,… | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Thumbnail Generation Strategy | decided | A (10% offset fast seek, JPEG ≤ 1280 px wide) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Unique Public Video ID for the Video URL | decided | B (random 11-char base64url `public_id`, unique index) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Streaming and Download Delivery | decided | A (presigned GET via JSON endpoint) | @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0 |
| phase-03-videos/TD-10 | phase | Cross-layer | Video Status Lifecycle and Failure Handling | decided | A (single enum `draft → processing → ready \| failed`) | — |
| phase-03-videos/TD-11 | phase | Backend | Abandoned Upload Cleanup | decided | B (scheduled sweep job in the worker) | — |
|     └─ Last revision: 2026-11-14 — The 24 h threshold is measured from the video's last upload activity… | | | | | | |
| video-upload-delivery-limits/TD-01 | ad-hoc | Cross-layer | Multipart Part Size | decided | A (fixed 16 MiB) | — |
| video-upload-delivery-limits/TD-02 | ad-hoc | Cross-layer | Presigned Part-URL Lifetime | decided | B (1 hour) | — |
| video-upload-delivery-limits/TD-03 | ad-hoc | Cross-layer | Presigned Stream/Download GET-URL Lifetime | decided | B (6 hours) | — |
| video-upload-delivery-limits/TD-04 | ad-hoc | Backend | Abandoned-Upload Cleanup Threshold | decided | B (24 h of inactivity, tracked by `last_activity_at`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])
- video-upload-delivery-limits — `docs/decisions/technical-decisions-video-upload-delivery-limits.md` (scope_type: ad-hoc, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-06 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-11, video-upload-delivery-limits/TD-01, video-upload-delivery-limits/TD-02, video-upload-delivery-limits/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-10, phase-03-videos/TD-11, video-upload-delivery-limits/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-01, phase-03-videos/TD-06, phase-03-videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04, phase-03-videos/TD-09, video-upload-delivery-limits/TD-03 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04, phase-03-videos/TD-09, video-upload-delivery-limits/TD-03 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Separate buckets for videos and thumbnails. Storage cost is an explicit concern in the plan, and source videos (up to 10 GB) and thumbnails (tens of KB) have opposite access and retention profiles. Keeping them apart lets a lifecycle or tier policy target sources alone. The extra env key and bootstrap step cost little. Keys are derived from the internal video UUID, never from the user-supplied filename, so uploads cannot collide or traverse paths. Phase 04's custom thumbnails can live in the same thumbnails bucket under a different key.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** BullMQ + Redis via `@nestjs/bullmq`. It is the documented NestJS path, and the processing job needs exactly what it ships: attempts with backoff, `jobId` deduplication for idempotent enqueue, worker concurrency, and a job scheduler (used by TD-11). The one cost is one extra container, which is the queue box the architecture diagram already reserves. Option B is the natural fallback if an extra container must be avoided, since application code would not change. Its newness argues against making it the default for the core pipeline.
**Libraries:** bullmq@^6.7.6, @nestjs/bullmq@^12.0.2, ioredis@^6.0.0

### phase-03-videos/TD-03

**Recommendation:** Presigned S3 multipart, direct to storage. It is the only option where no video bytes cross the API (or a BFF), so it satisfies "sem impacto na performance" and fits the Strict BFF rule. Resume comes from `ListParts` plus re-signing. The backend sets the part size and returns it in the init response. 64 MiB would be a reasonable value: a 10 GB file then needs about 160 parts, well inside the 5 MiB–5 GiB and 10,000-part limits. The backend enforces the 10 GB ceiling twice: it rejects declared sizes above it at init, and it checks the assembled object size before accepting `complete`. Part URLs are short-lived and re-signed on demand. Depends on TD-04 (public endpoint for signing).
**Libraries:** @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0

**Revisions:**
- 2026-11-14 — Part size and part-URL lifetime are fixed by `video-upload-delivery-limits/TD-01` (16 MiB, ≤ 640 parts for 10 GiB) and `video-upload-delivery-limits/TD-02` (1 h); the "64 MiB" figure in the Recommendation above was indicative only. Rationale: Parâmetros fixados em doc de limites dedicado (resolves `phase-03-videos/validation.md` IC-2).
- 2026-11-14 — Upload-init contract: the request carries `filename`, `size`, `contentType` and a **required** `title`; the draft row persists all four. `contentType` must be in the allowlist `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`, otherwise init is rejected; ffprobe in the worker remains the final check (an unreadable file ends `failed` per TD-10). Rationale: Pré-cadastro precisa de contrato de init definido (resolves `phase-03-videos/validation.md` AMB-1).

### phase-03-videos/TD-04

**Recommendation:** Internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT`. It is the only option that keeps the Compose service-name rule for server traffic and still hands clients reachable URLs without per-machine setup. The production story (S3 or a CDN host) is a value change, not a code change. URLs the worker uses for its own reads (TD-06) are signed with the internal client.
**Libraries:** —

**Revisions:**
- 2026-11-14 — Storage integration tests run against the real MinIO service in Compose (internal `S3_ENDPOINT`), covering presigned multipart, presigned GET with `Range`/`206` and bucket CORS; this is a deliberate deviation from the local-filesystem storage strategy in `testing-guide-nestjs-project` → `references/external-systems.md`. Rationale: o fluxo pré-assinado só é exercitado contra S3 real (resolves `phase-03-videos/validation.md` IC-1).

### phase-03-videos/TD-05

**Recommendation:** API `complete` endpoint publishes the job. The client already has to call the API to complete the multipart upload, so that call is the natural trigger. A stays inside the plain S3 API that both MinIO and production S3 share, while B ties the pipeline to vendor-specific notification setup. The crash window is closed by deduplicating with `jobId` and by the scheduled sweep in TD-11.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Same codebase, separate entrypoint and container. It isolates the CPU-heavy work as the architecture requires without duplicating the domain model across two packages. The worker reads the source through a presigned GET signed with the internal endpoint (TD-04), passed straight to `ffprobe`/`ffmpeg` as an HTTP input. Both tools use HTTP range reads, so metadata extraction and a seek-based thumbnail grab never download all 10 GB to local disk. FFmpeg is called through `node:child_process` (`spawn`, argument array, no shell), because `fluent-ffmpeg` is deprecated on npm. Retries use queue attempts with exponential backoff. The terminal failure state is defined in TD-10.
**Libraries:** ffmpeg / ffprobe (system binary, Debian package in the worker image)

**Revisions:**
- 2026-11-14 — Persisted metadata from ffprobe: typed columns `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `container`, plus a `metadata` `jsonb` column holding a raw ffprobe summary for future use. Rationale: "metadados" precisava de lista e formato definidos (resolves `phase-03-videos/validation.md` AMB-2).

### phase-03-videos/TD-07

**Recommendation:** Fixed 10% offset, fast seek, output as a JPEG with 1280 px maximum width, aspect preserved. One cheap and deterministic frame read fits the "sem impacto" goal and the range-read approach in TD-06. JPEG renders everywhere with no format negotiation. Phase 04 introduces custom thumbnails, so an uploader unhappy with the automatic frame has a remedy, which makes B's extra CPU hard to justify now. The output key follows TD-01.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Random 11-char base64url `public_id`, unique index. It meets both requirements in the plan, short and never conflicting, and stays unguessable, which the unlisted visibility in Phases 04 and 05 depends on. The UUID primary key remains the internal reference for foreign keys and storage keys (TD-01). Every public route uses `public_id`.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Presigned GET via a JSON endpoint. MinIO and S3 already implement `Range`/`206` correctly, so delivery stays off the API hot path, matching the diagram. The bucket stays private, so Phases 04 and 05 can add visibility rules at the signing endpoint without changing the transport. Returning JSON instead of a `302` keeps a future BFF a plain Route Handler and makes expiry explicit for the client. The endpoints are `@Public()` and only sign for videos with status `ready` (TD-10). Other states get a domain error.
**Libraries:** @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0

### phase-03-videos/TD-10

**Recommendation:** Single enum `draft → processing → ready | failed`. It reflects the phase's lifecycle one-to-one in the database, which is what this phase must deliver, and keeps one source of truth for the API and the worker. The cost lands in Phase 04, which adds publication and visibility as separate fields rather than new values of this enum. Transitions are guarded in the service: `complete` is only accepted from `draft`, and the worker only acts on `processing`, so a redelivered job is a no-op once the video is `ready`. When the job fails its final retry attempt (TD-02, TD-06), the worker sets `failed` with a short `failure_reason`. User-triggered reprocessing is out of scope.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Scheduled sweep job. It is the only option that keeps database and storage consistent and closes the completed-but-not-enqueued gap from TD-05, without depending on storage configuration that differs between MinIO and S3. A 24 h threshold for `draft` uploads gives ample margin for slow 10 GB uploads while bounding orphaned storage. Storage-side expiry (A) can stay on as a second safety net.
**Libraries:** —

**Revisions:**
- 2026-11-14 — The 24 h threshold is measured from the video's last upload activity (`last_activity_at`, updated on each part-URL signing and on `complete`), not from creation, per `video-upload-delivery-limits/TD-04`; hourly sweep cadence unchanged. Rationale: Parâmetros fixados em doc de limites dedicado (resolves `phase-03-videos/validation.md` IC-2).

### video-upload-delivery-limits/TD-01

**Recommendation:** Fixed 16 MiB. The plan explicitly asks for resuming after connection failures, and a 16 MiB part keeps the cost of a failure small even on a 1 Mbps link. The 640-part maximum is far from the 10,000 limit. The extra signatures are cheap because presigning is a local computation (`phase-03-videos/TD-04`). Option C solves a part-count problem that a fixed 10 GB ceiling never creates.
**Libraries:** —

### video-upload-delivery-limits/TD-02

**Recommendation:** 1 hour. TD-03 already relies on on-demand re-signing, so the TTL only has to cover one batch on a slow link. An hour does that with margin while keeping exposure narrow. 15 minutes forces frequent refreshes on the slow links the resume requirement targets. 24 hours trades a bloated init response for no gain over re-signing.
**Libraries:** —

### video-upload-delivery-limits/TD-03

**Recommendation:** 6 hours. It keeps playback and a resumed 10 GiB download on modest links working without the refresh path, so `expiresAt` becomes a safety net rather than a requirement. A leaked link also stays bounded to the same day, which preserves the unlisted model of the later phases. One value for both stream and download keeps a single config key.
**Libraries:** —

### video-upload-delivery-limits/TD-04

**Recommendation:** 24 h of inactivity, tracked by `last_activity_at`. It confirms the 24 h figure from `phase-03-videos/TD-11` while measuring it from the last activity, so slow-but-active uploads survive and abandoned ones are reclaimed within a day. The added column is cheap compared with either killing real uploads (A) or holding orphaned gigabytes for a week (C). The hourly sweep cadence from TD-11 stays unchanged.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome without a per-render `/auth/me` round-trip. Option C is rejected: it solves a problem (server-side revocation) the project does not have.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions. (2) **Aligned with shadcn's canonical form primitive** — `npx shadcn@latest add form` produces react-hook-form wrappers. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms. Option B is rejected for impedance with shadcn's primitive; Option C for per-field boilerplate and loss of client-side feedback.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** for Route-Handlers-as-functions. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking. If the team later wants progressive enhancement for specific forms, the migration A→B is per-form.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it. The `router.refresh()` requirement after mid-session mutations is a small price. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint. (2) **Single integration pattern across both flows** — "RSC owns the token, Client Component owns the input". (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level. Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Ambos (runtime UI + `openapi.json` exportado) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Apenas em dev/staging (via env flag) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Zod 4. Three converging reasons: (1) type-inference matches the FE's strict-TS culture — `lib/env.ts` exports a typed `env` object with no `as` casts; (2) Zod is the de-facto schema language for App Router; (3) direct enablement of TD-02 (`@t3-oss/env-nextjs`). Backend parity with Joi is not load-bearing: env schemas are not shared FE↔BE.
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** `@t3-oss/env-nextjs` — the only option that combines type-level `NEXT_PUBLIC_` prefix enforcement, runtime Proxy-based leak detection, and single-file consumer ergonomics. The marginal cost over B is one ~3KB dep.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** Strict BFF — single server-only `API_URL`. Aligned with the BFF testing strategy documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS and public exposure of the backend URL. Adding a public key later is non-breaking, while removing one is breaking. The concrete dev value of `API_URL` (Docker networking) is a separate infra decision not resolved there. _(full text: source doc)_
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** `openapi-typescript` + `openapi-fetch`. Strict BFF makes a generated SDK valueless on the client (only Route Handlers call Nest, via `fetch`); types-first matches the rest of the FE foundation; MSW typing is solved by the same `paths` symbol. The types + thin-client pair is recommended over types alone. _(full text: source doc)_
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** Committed local copy at `next-frontend/openapi.json` + repo-root sync script. Preserves compose-stack independence; drift is eliminated structurally when paired with TD-03's CI freshness check; the committed file is visible in PR review alongside the backend change.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** Committed + CI freshness check covering `openapi.json` and `types.gen.ts` — the only option that makes contract drift both visible (PR diffs) and impossible to merge accidentally (CI fail). Apply the same script-and-check pattern to any future generated artifact.
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** Single `lib/api/contracts.ts` with explicit aliases — handles pass-through and reshape with one mechanism, gives a single grep target for the BFF shape, and decouples Component imports from App Router file paths. `lib/api/contracts.ts` is the only file that imports `paths` from `types.gen.ts`.
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Hand-written MSW handlers, typed via `paths` — determinism over auto-generation; one type chain "spec ↔ handler ↔ assertion"; manual cost is negligible at the current endpoint count. Can be superseded by a generator plugin later without touching `paths` import sites.
**Libraries:** —

### next-frontend-msw-foundation/TD-01

**Recommendation:** Per-domain modules under `mocks/handlers/<domain>.ts` + barrel `mocks/handlers/index.ts` — MSW's own best practice; domain ownership tracks the codebase (auth, videos, channels); append-only growth with minimal merge conflicts. _(full text: source doc)_
**Libraries:** —

### next-frontend-msw-foundation/TD-02

**Recommendation:** Test-only `setupServer` at the foundation; the browser worker is deferred until a dedicated FE-offline-dev capability appears in the plan. Extending to the browser worker later is additive. _(full text: source doc)_
**Libraries:** —

### next-frontend-msw-foundation/TD-03

**Recommendation:** Hand-written deterministic defaults as the baseline + opt-in seeded faker scoped to bulk-collection builders only (per-fixture `faker.seed(N)`); `@faker-js/faker` installed only when the first bulk builder is authored. _(full text: source doc)_
**Libraries:** —

### next-frontend-msw-foundation/TD-04

**Recommendation:** Universal handler set loaded into `setupServer` + per-test `server.use(...)` overrides + `onUnhandledRequest: "error"` — the canonical MSW v2 model; unhandled requests fail loudly, keeping each phase's tests inside its scope. _(full text: source doc)_
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 3 and then rerun /plan-context 3 to activate UI checks._

> Note: the Step 0.5 UI signal fired on a substring match ("arq**ui**vos" in "Serviço de armazenamento de arquivos"), not on a screen bullet. Phase 03 has no `Tela`/`Página` bullet; the user chose option (b) deferred on 2026-11-14.

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

Source: `testing-guide-nestjs-project` Skill, §3 Feature Implementation Checklist.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

Guide entries relevant to the artifact types this phase introduces (recorded as found; no assessment here):

- `artifacts/future-types.md` → **Queue Consumers / Processors**: processor with business logic → Unit (mock deps) + Integration (real DB/storage); processor with only external system calls → Integration (real systems). Also covers **Scheduled Tasks (Cron)** and **Config Validation**.
- `references/external-systems.md` → **Message Queue — Real (Docker)**: real broker in Compose; publisher tests assert the job is enqueued with correct data (BullMQ example with `getQueueToken('video-processing')`).
- `references/external-systems.md` → **Object Storage — Local Filesystem**: strategy text reads "Local filesystem storage in development and tests. S3 in production", via a `StorageService` abstraction with a local adapter in tests.
- Module compilation tests list `BullModule.registerQueue()` among configured imports to cover.

### next-frontend

_Deferred subproject for this phase — no frontend code in Phase 03; testing requirements not consumed here._

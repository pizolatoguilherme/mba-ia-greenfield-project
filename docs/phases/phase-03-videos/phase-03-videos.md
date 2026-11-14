---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T10:05:05-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-14T10:04:29-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T10:28:20-03:00"
  docs/decisions/technical-decisions-video-upload-delivery-limits.md: "2026-11-14T09:54:48-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-14T07:56:05-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-14T07:56:05-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-14T07:56:05-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-11-14T07:56:05-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB sem impacto na performance, com pré-cadastro automático como rascunho, serviço de armazenamento (vídeos e thumbnails), processamento em segundo plano via filas (extração de duração e metadados e geração automática de thumbnail), URL única por vídeo, reprodução via streaming e download pelo usuário — com o ciclo de status `draft → processing → ready | failed` refletido no banco.

---

## Step Implementations

### SI-03.1 — Infra: MinIO, Redis e configuração de storage/fila

**Description:** Sobe os serviços de armazenamento (MinIO) e de fila (Redis) no Compose e expõe a configuração validada que todas as SIs seguintes consomem.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` os serviços `minio` (imagem com tag exata fixada, porque o MinIO Community foi arquivado; portas 9000/9001; volume nomeado; healthcheck) e `redis` (imagem com tag exata; healthcheck `redis-cli ping`); `nestjs-api` passa a depender de ambos com `condition: service_healthy` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Instalar no container `@aws-sdk/client-s3@^3.1169.0`, `@aws-sdk/s3-request-presigner@^3.1169.0`, `bullmq@^6.7.6`, `@nestjs/bullmq@^12.0.2` e `ioredis@^6.0.0` — `ioredis` explícito porque no BullMQ 6 o cliente Redis é peer opcional (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
3. Estender `src/config/env.validation.ts` e `.env.example` com `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_VIDEOS_BUCKET`, `S3_THUMBNAILS_BUCKET`, `REDIS_HOST=redis`, `REDIS_PORT`, `UPLOAD_PART_SIZE_BYTES=16777216`, `UPLOAD_PART_URL_TTL_SECONDS=3600`, `DELIVERY_URL_TTL_SECONDS=21600`, `UPLOAD_ABANDON_AFTER_HOURS=24` — hosts sempre como nome de serviço do Compose, exceto o endpoint público de presign (per `phase-03-videos/TD-04`, `video-upload-delivery-limits/TD-01`, `TD-02`, `TD-03`, `TD-04`, `phase-01-configuracao-base/TD-02`)
4. Criar `src/config/storage.config.ts` (endpoints, credenciais, buckets, part size, TTLs, limite de inatividade) e `src/config/queue.config.ts` (host/porta do Redis) com `registerAs`, e registrá-los no `ConfigModule.forRoot({ load })` (per `phase-01-configuracao-base/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Integration: novas chaves obrigatórias, defaults e rejeição de valores inválidos | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `minio` e `redis` como `healthy` junto de `db` e `nestjs-api`
- `docker compose exec redis redis-cli ping` retorna `PONG`
- Boot da aplicação sem `S3_ENDPOINT` ou `REDIS_HOST` falha na validação de env, nomeando a chave ausente
- `.env.example` documenta todas as chaves novas, com `minio`/`redis` como hosts internos e `localhost` apenas em `S3_PUBLIC_ENDPOINT`

---

### SI-03.2 — StorageService (adapter S3) e compatibilidade do MinIO

**Description:** Encapsula todo o acesso a storage num `StorageModule` com cliente interno e cliente público, cria os buckets e prova contra o MinIO real que multipart pré-assinado, `Range`/`206` e CORS funcionam na tag fixada.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client` (`forcePathStyle: true`): o interno em `S3_ENDPOINT`, para operações e para URLs que o worker lê, e o público em `S3_PUBLIC_ENDPOINT`, só para presign voltado ao cliente (per `phase-03-videos/TD-04`)
2. Implementar em `StorageService`: `createMultipartUpload`, `signUploadPart` (`UploadPartCommand`, `expiresIn` = TTL de parte), `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `deleteObject`, `putObject` e `signGetObject` (`GetObjectCommand` com `ResponseContentDisposition` opcional e escolha do cliente interno ou público) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`)
3. No `onModuleInit`, garantir os buckets `S3_VIDEOS_BUCKET` e `S3_THUMBNAILS_BUCKET` (privados) e aplicar CORS (`PUT`/`GET`, header `Range`, `ExposeHeaders: ETag`) via `PutBucketCorsCommand`. Se a tag fixada do MinIO não aceitar CORS por bucket, usar `MINIO_API_CORS_ALLOW_ORIGIN` no Compose, e o teste de compatibilidade decide qual caminho fica (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
4. Montar as chaves de objeto num helper puro `src/storage/storage-keys.ts`: `{id}/source` no bucket de vídeos e `{id}/auto.jpg` no de thumbnails, nunca derivadas do `filename` (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration contra o MinIO real: multipart via URLs pré-assinadas (`PUT` + `complete`), `ListParts`, `GetObject` pré-assinado com `Range` → `206`, preflight CORS expondo `ETag`, abort. Nos testes o endpoint público aponta para `http://minio:9000`, porque o fetch roda dentro do container | `src/storage/storage.service.integration-spec.ts` |
| `storage-keys.ts` | Unit: formato das chaves e independência do `filename` | `src/storage/storage-keys.spec.ts` |

**Dependencies:** SI-03.1 — MinIO no Compose, SDK instalado e `storage.config.ts`

**Acceptance criteria:**

- Após o boot, os buckets de vídeos e de thumbnails existem no MinIO e não aceitam leitura anônima
- Partes enviadas por `PUT` às URLs de `signUploadPart` e completadas por `completeMultipartUpload` resultam num único objeto com o tamanho somado das partes
- `GET` numa URL de `signGetObject` com `Range: bytes=0-1023` retorna `206` com 1024 bytes
- Preflight `OPTIONS` de uma origem permitida retorna `Access-Control-Allow-Origin` e expõe `ETag`
- URLs assinadas pelo cliente público têm o host de `S3_PUBLIC_ENDPOINT`, e as do cliente interno o de `S3_ENDPOINT`

---

### SI-03.3 — Entidade Video e migration CreateVideos

**Description:** Cria a tabela `videos` com o ciclo de status, os metadados e o `public_id` único definidos no Data Model.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todos os campos, tipos e constraints de `### Data Model → Video`, incluindo o enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`), `bigint` para `size`/`bitrate` e `jsonb` para `metadata` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-06`, `video-upload-delivery-limits/TD-04`)
2. Adicionar `@OneToMany(() => Video, ...)` em `Channel` e `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` em `Video`; índices: unique em `public_id`, `channel_id`, e composto (`status`, `last_activity_at`) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-11`)
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com `randomBytes(8).toString('base64url')`, 11 caracteres (per `phase-03-videos/TD-08`)
4. Gerar `src/database/migrations/{timestamp}-CreateVideos.ts` com `npm run migration:generate` no container e revisar o SQL (tipo `videos_status_enum`, FK para `channels`, índices)
5. Incluir `videos` em `MANAGED_TABLES`, `videos_status_enum` em `MANAGED_ENUM_TYPES`, e a entidade e a migration nova em `src/database/migrations.integration-spec.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`status = draft`, `last_activity_at`), unique de `public_id`, FK de `channel_id`, enum rejeitando valor inválido, colunas de metadados nulas | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: `CreateVideos` aplica e reverte sobre as anteriores | `src/database/migrations.integration-spec.ts` |
| `public-id.util.ts` | Unit: 11 caracteres no alfabeto base64url, valores distintos | `src/videos/public-id.util.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria `videos` e `videos_status_enum`, e `migration:revert` remove ambos
- Inserir um vídeo só com os campos obrigatórios persiste `status = 'draft'` e `last_activity_at` preenchido
- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique
- Inserir um vídeo com `channel_id` inexistente viola a FK
- `generatePublicId()` retorna 11 caracteres de `[A-Za-z0-9_-]`

---

### SI-03.4 — Endpoint POST /videos (pré-cadastro e início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (vídeo criado no canal do usuário autenticado)

**Description:** Ao iniciar o upload, cria o vídeo como `draft` e abre o multipart no storage, devolvendo o tamanho de parte que o cliente deve usar. Nenhum byte de vídeo passa pela API.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule`), registrar em `AppModule` e adicionar `findByUserId(userId)` ao `ChannelsService` — a busca do canal fica no módulo dono
2. Criar `src/videos/dto/create-video.dto.ts` conforme `#### Validation Rules — videos` (`title`, `filename`, `size` ≤ 10737418240, `contentType` em `@IsIn` com as 4 MIME types) (per `phase-03-videos/TD-03`, `phase-02-auth/TD-06`)
3. Criar `src/videos/upload-parts.util.ts` — `computePartCount(size, partSize)` = `ceil(size / partSize)` (per `video-upload-delivery-limits/TD-01`)
4. Implementar `VideosService.initiateUpload(userId, dto)`: resolve o canal, gera `id` (`randomUUID`) e `public_id` (nova tentativa em colisão do unique), chama `createMultipartUpload` na chave `{id}/source` e persiste o `draft` com `upload_id`, `title`, `filename`, `size` e `content_type` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
5. Criar `src/videos/videos.controller.ts` com `POST /videos` → `201` `{ publicId, title, status, partSize, partCount }`, com decorators OpenAPI e envelope de erro (per `### API Contracts → POST /videos`, `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Integration (DB + MinIO real): linha `draft` com `upload_id`, multipart aberto (`ListParts` vazio), `public_id` com 11 caracteres | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário | `src/channels/channels.service.integration-spec.ts` |
| `upload-parts.util.ts` | Unit: limites (1 byte, múltiplo exato de 16 MiB, 10 GiB → 640) | `src/videos/upload-parts.util.spec.ts` |
| `VideosModule` | Unit: compilação do módulo com imports configurados | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`

**Acceptance criteria:**

- `POST /videos` autenticado com `{ title, filename, size: 1073741824, contentType: "video/mp4" }` retorna `201` com `status: "draft"`, `partSize: 16777216`, `partCount: 64` e `publicId` de 11 caracteres
- Após o `201`, existe uma linha em `videos` com `status = 'draft'`, `channel_id` do canal do usuário e os 4 campos de init persistidos
- `POST /videos` com `contentType: "video/avi"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `size: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `title` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem access token retorna `401`

---

### SI-03.5 — Endpoint POST /videos/:publicId/upload/part-urls

**Route:** POST /videos/:publicId/upload/part-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-part-urls.plan.md`
**Authorization:** Owner

**Description:** Assina sob demanda as URLs de `PUT` das partes pedidas e registra atividade no upload. É o mecanismo de re-assinatura que permite retomar o envio.

**Technical actions:**

1. Adicionar a `src/common/exceptions/domain.exception.ts`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoAccessDeniedException` (`VIDEO_ACCESS_DENIED`, 403), `VideoNotDraftException` (`VIDEO_NOT_DRAFT`, 409) e `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400) (per `### Error Catalog`, `phase-02-auth/TD-07`)
2. Implementar `VideosService.findOwnedDraft(publicId, userId)`, reutilizado pelas SIs de upload: lança `VIDEO_NOT_FOUND`, `VIDEO_ACCESS_DENIED` (canal de outro usuário) ou `VIDEO_NOT_DRAFT` (per `### Authorization Matrix`, `phase-03-videos/TD-10`)
3. Criar `src/videos/dto/sign-part-urls.dto.ts` (`partNumbers`: 1–100 inteiros únicos ≥ 1) e implementar `VideosService.signPartUrls`: rejeita número > `partCount` com `INVALID_PART_NUMBER`, assina cada parte com o cliente público (`expiresIn` 3600 s), atualiza `last_activity_at` e devolve `expiresAt` (per `phase-03-videos/TD-03`, `video-upload-delivery-limits/TD-02`, `video-upload-delivery-limits/TD-04`)
4. Expor `POST /videos/:publicId/upload/part-urls` → `200` `{ parts: [{ partNumber, url }], expiresAt }` no `VideosController`, com decorators OpenAPI (per `### API Contracts → POST /videos/:publicId/upload/part-urls`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedDraft` | Unit (repositório mockado com `MockedMethods<T>`): ramos not found, outro dono, fora de `draft` | `src/videos/videos.service.spec.ts` |
| `VideosService.signPartUrls` | Integration (DB + MinIO real): URL aceita `PUT` de uma parte, `last_activity_at` avança, `INVALID_PART_NUMBER` acima do `partCount` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — `VideosModule`, `VideosController` e vídeo em `draft`

**Acceptance criteria:**

- O dono, com `{ partNumbers: [1, 2] }`, recebe `200` com 2 URLs no host de `S3_PUBLIC_ENDPOINT` e `expiresAt` cerca de 1 h à frente
- `PUT` de 16 MiB numa URL devolvida retorna `200` do storage com header `ETag`
- Após a chamada, `last_activity_at` do vídeo é posterior ao valor anterior
- `partNumbers` com número maior que o `partCount` retorna `400` com `error: "INVALID_PART_NUMBER"`
- Outro usuário autenticado recebe `403` com `error: "VIDEO_ACCESS_DENIED"`
- Um `publicId` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_DRAFT"`

---

### SI-03.6 — Endpoint GET /videos/:publicId/upload/parts (retomada)

**Route:** GET /videos/:publicId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner

**Description:** Lista as partes que já estão no storage, para o cliente retomar o upload depois de uma falha de conexão sem reenviar o que já foi.

**Technical actions:**

1. Implementar `VideosService.listUploadedParts(publicId, userId)`: usa `findOwnedDraft`, chama `listParts` (paginando internamente até o fim) e mapeia para `{ partNumber, etag, size }` em ordem crescente (per `phase-03-videos/TD-03`)
2. Expor `GET /videos/:publicId/upload/parts` → `200` `{ parts }` no `VideosController`, com decorators OpenAPI (per `### API Contracts → GET /videos/:publicId/upload/parts`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.listUploadedParts` | Integration (DB + MinIO real): após enviar as partes 1 e 3, a lista retorna exatamente essas duas, com `etag` e `size` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `findOwnedDraft` e exceções de vídeo

**Acceptance criteria:**

- Logo após o `POST /videos`, o dono recebe `200` com `parts: []`
- Após `PUT` das partes 1 e 3, o dono recebe `200` com as partes 1 e 3 (com `etag` e `size`), sem a 2
- Outro usuário autenticado recebe `403` com `error: "VIDEO_ACCESS_DENIED"`
- Um vídeo fora de `draft` retorna `409` com `error: "VIDEO_NOT_DRAFT"`

---

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete e enfileiramento

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Fecha o multipart, confere o tamanho montado, move o vídeo para `processing` e publica o job de processamento de forma idempotente.

**Technical actions:**

1. Registrar `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })` no `AppModule`, `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule`, e fixar nomes de fila e job em `src/videos/videos.queue.ts` (`VIDEO_PROCESSING_QUEUE`, `PROCESS_VIDEO_JOB`) (per `phase-03-videos/TD-02`, `### Events/Messages → video-processing → process-video`)
2. Adicionar `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400) e `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 413) em `domain.exception.ts` (per `### Error Catalog`)
3. Criar `src/videos/dto/complete-upload.dto.ts` (`parts`: 1–10000 itens `{ partNumber, etag }`, `partNumber` único) (per `#### Validation Rules — videos`)
4. Implementar `VideosService.completeUpload`, nesta ordem:
   - `findOwnedDraft`, depois ordena as partes e chama `completeMultipartUpload`; rejeição do storage (parte inválida ou ETag divergente) vira `INVALID_UPLOAD_PARTS`
   - `headObject`: com `ContentLength` > 10 GiB, `deleteObject` + `status = failed` / `failure_reason = size_exceeded` + `VIDEO_TOO_LARGE`
   - Senão grava `status = processing` e `last_activity_at = now()`, e só então `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 30000 } })`

   (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
5. Expor `POST /videos/:publicId/upload/complete` → `202` `{ publicId, status }` no `VideosController`, com decorators OpenAPI (per `### API Contracts → POST /videos/:publicId/upload/complete`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): objeto montado, `status = processing`, job na fila `video-processing` com `jobId = videoId` (via `getQueueToken`); chamada repetida não cria segundo job | `src/videos/videos.service.integration-spec.ts` |
| `VideosService.completeUpload` | Unit (storage/fila mockados): ramo > 10 GiB (apaga o objeto, marca `failed`, lança `VIDEO_TOO_LARGE`), mapeamento de erro do storage para `INVALID_UPLOAD_PARTS`, ordem "persistir antes de enfileirar" | `src/videos/videos.service.spec.ts` |
| `VideosModule` | Unit: compilação com `BullModule.registerQueue` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.5 — `findOwnedDraft`; SI-03.1 — Redis e `queue.config.ts`

**Acceptance criteria:**

- O dono, com as partes enviadas e seus `etag`s, recebe `202` com `status: "processing"`
- Após o `202`, o objeto `{id}/source` existe no bucket de vídeos e a fila `video-processing` contém um job `process-video` com `jobId` igual ao `id` do vídeo e payload `{ videoId }`
- Um segundo `complete` no mesmo vídeo retorna `409` com `error: "VIDEO_NOT_DRAFT"` e não cria outro job
- Um `etag` que não corresponde à parte enviada retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua `draft`
- Um objeto montado maior que 10 GiB retorna `413` com `error: "VIDEO_TOO_LARGE"`, o objeto é removido e o vídeo fica `failed` com `failure_reason = 'size_exceeded'`
- Outro usuário autenticado recebe `403` com `error: "VIDEO_ACCESS_DENIED"`

---

### SI-03.8 — Infra: Video Worker (entrypoint, container e FFmpeg)

**Description:** Cria o processo do worker no mesmo codebase, com entrypoint e container próprios e FFmpeg instalado, isolando o trabalho pesado da API.

**Technical actions:**

1. Instalar o pacote Debian `ffmpeg` (traz `ffmpeg` e `ffprobe`) no `Dockerfile.dev`, compartilhado pela API e pelo worker para que os testes de integração do worker rodem no container `nestjs-api`; registrar a versão instalada (`ffmpeg -version`) para o CLAUDE.md da SI-03.15 (per `phase-03-videos/TD-06`)
2. Criar `src/worker/worker.module.ts` com `ConfigModule` (mesmo `load`/`validationSchema`), `TypeOrmModule.forRootAsync` (mesma factory `databaseConfig`), `BullModule.forRootAsync` (`queueConfig`) e `StorageModule`, e `src/worker/main.ts` com `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (per `phase-03-videos/TD-06`, `phase-01-configuracao-base/TD-03`)
3. Adicionar scripts `start:worker:dev` e `start:worker:prod` (`node dist/worker/main`) ao `package.json`. O build de dev do worker usa diretório de saída próprio, para não apagar nem disputar o `dist/` do watcher da API
4. Adicionar o serviço `video-worker` ao `compose.yaml` (mesmo build e volume da API, `command: npm run start:worker:dev`, sem portas publicadas, `depends_on` `db`/`redis`/`minio` healthy) (per `phase-03-videos/TD-06`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — Redis, MinIO e configs; SI-03.2 — `StorageModule`

**Acceptance criteria:**

- `docker compose ps` mostra `video-worker` em execução e `docker compose logs video-worker` registra o contexto da aplicação inicializado, sem servidor HTTP
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec video-worker ffmpeg -version` retornam a versão instalada
- Com o worker rodando, `npm run start:dev` da API continua compilando e servindo normalmente, sem conflito de `dist/`

---

### SI-03.9 — Processor de vídeo: extração de duração e metadados

**Description:** Consome `process-video`, extrai duração e metadados com `ffprobe` lendo o objeto por HTTP range (sem baixar o arquivo inteiro) e aplica as transições de status e falha.

**Technical actions:**

1. Criar `src/worker/media/ffprobe.ts` — `probeMedia(url)` via `spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url])` (array de argumentos, sem shell); saída diferente de 0 ou JSON inválido lança `UnreadableMediaError` (per `phase-03-videos/TD-06`)
2. Criar `src/worker/media/probe-mapper.ts` — função pura de `format`/`streams` para `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `container` + `metadata` resumido; sem stream de vídeo, lança `UnreadableMediaError` (per `phase-03-videos/TD-06` Revision 2026-11-14)
3. Criar `src/worker/processing/video-processing.processor.ts` (`@Processor('video-processing')`, `extends WorkerHost`), registrado no `WorkerModule` com `registerQueue`:
   - carrega o vídeo pelo `videoId`; se não estiver em `processing`, retorna sem efeito
   - assina um GET com o cliente interno, roda `probeMedia`, persiste os metadados e grava `status = ready`

   (per `phase-03-videos/TD-04`, `phase-03-videos/TD-10`)
4. Tratar as falhas:
   - `UnreadableMediaError` grava `failed` / `unreadable_media` e relança como `UnrecoverableError` (sem retry)
   - `@OnWorkerEvent('failed')` na última tentativa (`attemptsMade >= opts.attempts`) grava `failed` / `processing_error` se o vídeo ainda estiver em `processing`

   (per `phase-03-videos/TD-02`, `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `probe-mapper.ts` | Unit: vídeo com áudio, vídeo sem áudio, sem stream de vídeo, campos numéricos como string | `src/worker/media/probe-mapper.spec.ts` |
| `ffprobe.ts` | Integration (ffprobe real + MinIO real): fixture curta gerada com `ffmpeg -f lavfi testsrc` e lida por URL pré-assinada; arquivo não-vídeo lança `UnreadableMediaError` | `src/worker/media/ffprobe.integration-spec.ts` |
| `VideoProcessingProcessor` | Integration (DB + MinIO reais, `process(job)` chamado direto): vídeo em `processing` vira `ready` com metadados; bytes inválidos viram `failed` / `unreadable_media` | `src/worker/processing/video-processing.processor.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit (deps mockadas): no-op fora de `processing`, evento `failed` na última tentativa e em tentativa intermediária | `src/worker/processing/video-processing.processor.spec.ts` |

**Dependencies:** SI-03.8 — `WorkerModule` e FFmpeg; SI-03.7 — job `process-video` e status `processing`

**Acceptance criteria:**

- Após o `complete` de um MP4 válido, o vídeo passa a `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `bitrate` e `container` preenchidos e `metadata` não nulo
- Um MP4 sem áudio fica `ready` com `audio_codec` nulo
- Um arquivo que não é vídeo (bytes aleatórios com `contentType` permitido) termina `failed` com `failure_reason = 'unreadable_media'`, sem novas tentativas
- Um job reentregue para um vídeo já `ready` não altera a linha
- O worker não grava o arquivo de origem em disco local durante o processamento

---

### SI-03.10 — Geração automática de thumbnail

**Description:** Extrai um frame a 10% da duração com seek rápido, gera um JPEG com no máximo 1280 px de largura e grava no bucket de thumbnails antes de marcar o vídeo como `ready`.

**Technical actions:**

1. Criar `src/worker/media/thumbnail.ts` — `extractThumbnail(url, offsetSeconds)` via `spawn('ffmpeg', ['-ss', offset, '-i', url, '-frames:v', '1', '-vf', 'scale=w=min(1280\\,iw):h=-2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'])`, com `-ss` antes de `-i` (seek rápido) e o stdout coletado num `Buffer` (per `phase-03-videos/TD-07`)
2. No `VideoProcessingProcessor`, depois de persistir os metadados: `offset = duration_seconds * 0.1`, extrai o frame, chama `putObject` no bucket de thumbnails na chave `{id}/auto.jpg` (`ContentType: image/jpeg`), grava `thumbnail_key` e só então `status = ready`. Falha na extração segue as regras de retry da SI-03.9 (per `phase-03-videos/TD-07`, `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `thumbnail.ts` | Integration (ffmpeg real): fixture 1920×1080 gera JPEG (magic bytes `FFD8`) com 1280 px de largura; fixture 640×360 mantém 640 px | `src/worker/media/thumbnail.integration-spec.ts` |
| `VideoProcessingProcessor` | Integration (DB + MinIO reais): após o processamento, `{id}/auto.jpg` existe no bucket de thumbnails e `thumbnail_key` está preenchido | `src/worker/processing/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.9 — processor e metadados (`duration_seconds`)

**Acceptance criteria:**

- Todo vídeo que chega a `ready` tem `thumbnail_key = '{id}/auto.jpg'` e o objeto existe no bucket de thumbnails com `Content-Type: image/jpeg`
- A thumbnail de uma fonte 1920×1080 tem 1280 px de largura e proporção preservada (720 px de altura)
- A thumbnail de uma fonte com menos de 1280 px de largura mantém a largura original
- Nenhum objeto é gravado no bucket de vídeos pelo worker

---

### SI-03.11 — Sweep agendado de uploads abandonados

**Description:** Job horário no worker que libera o storage de uploads `draft` parados há mais de 24 h e reenfileira vídeos presos em `processing`, mantendo banco e storage consistentes.

**Technical actions:**

1. Registrar `BullModule.registerQueue({ name: 'video-maintenance' })` no `WorkerModule` e, no `onApplicationBootstrap`, `upsertJobScheduler('sweep-abandoned-uploads', { every: 3600000 })`. As opções do job `process-video` (`attempts`, `backoff`) saem de `src/videos/videos.queue.ts`, compartilhadas com o producer da API (per `phase-03-videos/TD-11`, `### Events/Messages → video-maintenance → sweep-abandoned-uploads`)
2. Criar `src/worker/maintenance/video-sweep.service.ts` com dois métodos:
   - `failAbandonedUploads(now)`: vídeos `draft` com `last_activity_at < now - UPLOAD_ABANDON_AFTER_HOURS` recebem `abortMultipartUpload` (ignorando upload já inexistente) e `failed` / `upload_abandoned`
   - `requeueStuckProcessing()`: vídeos em `processing` recebem `queue.add('process-video', { videoId }, { jobId: videoId, ... })`

   (per `video-upload-delivery-limits/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-11`)
3. Criar `src/worker/maintenance/video-maintenance.processor.ts` (`@Processor('video-maintenance')`), que executa os dois passos e registra no log quantos vídeos foram afetados (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoSweepService` | Integration (DB + MinIO + Redis reais): `draft` parado há 25 h vira `failed` e o multipart é abortado; `draft` parado há 23 h fica intacto; `processing` sem job ganha job com `jobId = videoId`; `processing` com job existente não duplica | `src/worker/maintenance/video-sweep.service.integration-spec.ts` |
| Scheduler | Integration (Redis real): após o bootstrap, `getJobSchedulers()` contém `sweep-abandoned-uploads` com intervalo de 3600000 ms, e um segundo bootstrap não duplica | `src/worker/maintenance/video-maintenance.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.8 — `WorkerModule`; SI-03.7 — fila `video-processing` e opções compartilhadas do job

**Acceptance criteria:**

- Um vídeo `draft` com `last_activity_at` há mais de 24 h termina `failed` com `failure_reason = 'upload_abandoned'` após o sweep, e `ListParts` do seu `upload_id` não encontra mais o upload
- Um vídeo `draft` com atividade nas últimas 24 h não é alterado pelo sweep
- Um vídeo em `processing` cujo job sumiu da fila volta a ter um job `process-video` com `jobId` igual ao seu `id`
- Reiniciar o worker mantém um único scheduler `sweep-abandoned-uploads` na fila `video-maintenance`

---

### SI-03.12 — Endpoint GET /videos/:publicId (URL única do vídeo)

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Anonymous (`@Public()`)

**Description:** Resolve o vídeo pela sua URL única (`public_id`) e devolve status, metadados e a thumbnail assinada, permitindo acompanhar o processamento.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` com o mapeamento entidade → resposta de `### API Contracts → GET /videos/:publicId` (camelCase; `size`/`bitrate` `bigint` convertidos para number; `metadata`, `upload_id` e `channel_id` não expostos) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-06`)
2. Implementar `VideosService.findByPublicId(publicId)` (`VIDEO_NOT_FOUND` quando não existe) e a montagem de `thumbnail`: `signGetObject` no bucket de thumbnails com o cliente público e TTL de 21600 s quando `thumbnail_key` está preenchido, senão `null` (per `phase-03-videos/TD-09`, `video-upload-delivery-limits/TD-03`)
3. Expor `GET /videos/:publicId` com `@Public()` → `200` no `VideosController`, com decorators OpenAPI (per `### Authorization Matrix`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-response.dto.ts` | Unit: conversão de `bigint` (string do driver) em number, nulos de metadados, campos internos omitidos | `src/videos/dto/video-response.dto.spec.ts` |
| `VideosService.findByPublicId` | Integration (DB + MinIO reais): vídeo `ready` com thumbnail traz URL assinada válida; vídeo `draft` traz `thumbnail: null` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VIDEO_NOT_FOUND`; SI-03.3 — entidade com metadados e `thumbnail_key`

**Acceptance criteria:**

- `GET /videos/{publicId}` sem token retorna `200` com `publicId`, `title`, `status` e os campos de metadados do vídeo
- Para um vídeo `ready`, `thumbnail.url` responde `200` com `Content-Type: image/jpeg` e `thumbnail.expiresAt` fica cerca de 6 h à frente
- Para um vídeo `draft`, a resposta traz `status: "draft"`, metadados nulos e `thumbnail: null`
- Para um vídeo `failed`, a resposta traz `failureReason` preenchido
- A resposta não contém `id` interno, `upload_id`, `channel_id` nem `metadata`
- `GET /videos/inexistente` retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.13 — Endpoint GET /videos/:publicId/stream

**Route:** GET /videos/:publicId/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Anonymous (`@Public()`)

**Description:** Entrega uma URL pré-assinada para reprodução por streaming; o storage atende `Range`/`206` direto, sem o vídeo passar pela API.

**Technical actions:**

1. Adicionar `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) em `domain.exception.ts` (per `### Error Catalog`, `phase-03-videos/TD-09`)
2. Implementar `VideosService.signDelivery(publicId, mode)`, com `mode` `stream` ou `download` e reutilizado pela SI-03.14: `VIDEO_NOT_FOUND`/`VIDEO_NOT_READY` fora de `ready`, `signGetObject` em `{id}/source` com o cliente público e TTL de 21600 s, retornando `{ url, expiresAt }` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-04`, `video-upload-delivery-limits/TD-03`)
3. Expor `GET /videos/:publicId/stream` com `@Public()` → `200` `{ url, expiresAt }` no `VideosController`, com decorators OpenAPI (per `### API Contracts → GET /videos/:publicId/stream`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signDelivery` | Integration (DB + MinIO reais): vídeo `ready` → URL atende `Range: bytes=0-1023` com `206`; vídeo `processing` → `VIDEO_NOT_READY` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.12 — `findByPublicId`

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` sem token, para um vídeo `ready`, retorna `200` com `url` no host de `S3_PUBLIC_ENDPOINT` e `expiresAt` cerca de 6 h à frente
- `GET` na `url` devolvida com `Range: bytes=0-1023` retorna `206` com `Content-Range` e 1024 bytes
- Para um vídeo em `draft`, `processing` ou `failed`, retorna `409` com `error: "VIDEO_NOT_READY"`
- Para um `publicId` inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.14 — Endpoint GET /videos/:publicId/download

**Route:** GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Anonymous (`@Public()`)

**Description:** Entrega uma URL pré-assinada que faz o navegador baixar o arquivo com o nome original, também servida direto pelo storage.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` e usá-lo em `VideosService.signDelivery`, no modo `download`, para assinar com `ResponseContentDisposition: attachment; filename="{filename}"`, com o `filename` sanitizado (aspas, barras e caracteres de controle removidos; fallback ASCII com `filename*` UTF-8 quando necessário) (per `phase-03-videos/TD-09`)
2. Expor `GET /videos/:publicId/download` com `@Public()` → `200` `{ url, expiresAt }` no `VideosController`, com decorators OpenAPI (per `### API Contracts → GET /videos/:publicId/download`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Sanitização do `filename` | Unit: aspas, path traversal, acentos e nome vazio | `src/videos/content-disposition.util.spec.ts` |
| `VideosService.signDelivery` (download) | Integration (DB + MinIO reais): `GET` na URL retorna `Content-Disposition: attachment` com o nome sanitizado | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.13 — `signDelivery` e `VIDEO_NOT_READY`

**Acceptance criteria:**

- `GET /videos/{publicId}/download` sem token, para um vídeo `ready`, retorna `200` com `url` e `expiresAt` cerca de 6 h à frente
- `GET` na `url` devolvida retorna o arquivo completo com `Content-Disposition: attachment; filename="{filename original}"`
- Um `filename` com `"` ou `../` produz um `Content-Disposition` sem esses caracteres
- Para um vídeo fora de `ready`, retorna `409` com `error: "VIDEO_NOT_READY"`

---

### SI-03.15 — Documentação: CLAUDE.md e contrato OpenAPI

**Description:** Deixa CLAUDE.md, `.env.example` e `openapi.json` coerentes com a infraestrutura e os endpoints entregues na fase.

**Technical actions:**

1. Atualizar o `CLAUDE.md` da raiz: Message Queue (TBD) → BullMQ + Redis; Object Storage → MinIO local e S3 em produção; Video Worker no mesmo codebase com container próprio (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`)
2. Atualizar `nestjs-project/CLAUDE.md` com:
   - serviços `minio`, `redis` e `video-worker` e suas verificações de prontidão (`redis-cli ping`, health do MinIO)
   - a exceção de `S3_PUBLIC_ENDPOINT` à regra de hosts e a versão do FFmpeg instalada
   - o script `start:worker:dev` e o requisito de MinIO/Redis nos testes de integração (per `phase-03-videos/TD-04` Revision 2026-11-14)
3. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` no container e adicionar exemplos dos 7 endpoints em `nestjs-project/api.http` (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | Integration: o export regenerado contém os 7 endpoints de `/videos` e bate com o arquivo commitado | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.14 — todos os endpoints expostos; SI-03.10 e SI-03.11 — worker completo

**Acceptance criteria:**

- `nestjs-project/openapi.json` lista os 7 endpoints de `/videos` com os códigos de erro do Error Catalog
- O `CLAUDE.md` da raiz não descreve mais a fila como TBD, e o `nestjs-project/CLAUDE.md` documenta subir e verificar `minio`, `redis` e `video-worker`
- Seguindo só o `nestjs-project/CLAUDE.md`, um ambiente limpo sobe todos os serviços como `healthy`/`running`

---

### SI-03.16 (amendment of SI-03.1) — Cliente Redis fixado em ioredis ^5.11.1

**Description:** Registra a mudança retroativa da SI-03.1: o cliente Redis do BullMQ é `ioredis@^5.11.1`, e não `^6.0.0`, porque o `typeorm@0.3.28` declara peer opcional `ioredis@^5.0.4`; a opção A da TD-02 (BullMQ + Redis) não muda.

**Technical actions:**

1. Manter `ioredis@^5.11.1` em `nestjs-project/package.json` e no `package-lock.json` — instalado na SI-03.1 sem `--force`/`--legacy-peer-deps` (per `phase-03-videos/TD-02` Revision 2026-11-14)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — dependências instaladas

**Acceptance criteria:**

- `npm ls ioredis` no container lista `ioredis@5.x` como dependência direta e sob `bullmq`, sem `invalid` nem `ERESOLVE`
- `npm install` no container conclui sem conflito de peer dependency

---

## Technical Specifications

### Data Model

#### Video

Table `videos`. Timestamps follow the existing entity convention (`@CreateDateColumn` / `@UpdateDateColumn`, `timestamp`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — internal reference for FKs and storage keys *(per phase-03-videos/TD-08, TD-01)* |
| public_id | varchar(11) | unique, not null — random 11-char base64url from `node:crypto` *(per phase-03-videos/TD-08)* |
| channel_id | uuid | not null, FK → `channels.id` — the uploader's channel (user ↔ channel 1:1 from Phase 02) |
| title | varchar(100) | not null — required at init *(per phase-03-videos/TD-03 Revision 2026-11-14)* |
| filename | varchar(255) | not null — original client filename, metadata only, never used in storage keys *(per phase-03-videos/TD-03 Revision, TD-01)* |
| size | bigint | not null — declared size in bytes, ≤ 10 GiB *(per phase-03-videos/TD-03)* |
| content_type | varchar(50) | not null — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` *(per phase-03-videos/TD-03 Revision)* |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` *(per phase-03-videos/TD-10)* |
| failure_reason | varchar(255) | nullable — set only with `status = failed` *(per phase-03-videos/TD-10)* |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId` from `CreateMultipartUploadCommand` *(per phase-03-videos/TD-03)* |
| thumbnail_key | varchar(255) | nullable — object key in the thumbnails bucket, set when the worker stores the thumbnail *(per phase-03-videos/TD-01, TD-07)* |
| last_activity_at | timestamp | not null, default now() — updated on each part-URL signing and on `complete` *(per video-upload-delivery-limits/TD-04)* |
| duration_seconds | double precision | nullable — ffprobe `format.duration` *(per phase-03-videos/TD-06 Revision 2026-11-14)* |
| width | integer | nullable — first video stream *(per phase-03-videos/TD-06 Revision)* |
| height | integer | nullable — first video stream *(per phase-03-videos/TD-06 Revision)* |
| video_codec | varchar(50) | nullable — `codec_name` of the first video stream *(per phase-03-videos/TD-06 Revision)* |
| audio_codec | varchar(50) | nullable — `codec_name` of the first audio stream; stays null when there is no audio *(per phase-03-videos/TD-06 Revision)* |
| bitrate | bigint | nullable — ffprobe `format.bit_rate`, bits/s *(per phase-03-videos/TD-06 Revision)* |
| container | varchar(100) | nullable — ffprobe `format.format_name` *(per phase-03-videos/TD-06 Revision)* |
| metadata | jsonb | nullable — trimmed raw ffprobe summary (`format` + `streams`) for future use *(per phase-03-videos/TD-06 Revision)* |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), auto-updated |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id`.
**Indexes:** unique on `public_id`; index on `channel_id`; composite index on (`status`, `last_activity_at`) for the abandoned-upload sweep *(per phase-03-videos/TD-11, video-upload-delivery-limits/TD-04)*.

**Status transitions** *(per phase-03-videos/TD-10)* — guarded in the service; any other transition is rejected:

| From | To | Actor | When |
|------|----|-------|------|
| — | `draft` | API (`POST /videos`) | init creates the row and the multipart upload |
| `draft` | `processing` | API (`complete`) | multipart completed and assembled size ≤ 10 GiB |
| `draft` | `failed` | API (`complete`) | assembled object larger than 10 GiB (`failure_reason = size_exceeded`) |
| `draft` | `failed` | worker sweep | idle > 24 h since `last_activity_at` (`failure_reason = upload_abandoned`) |
| `processing` | `ready` | worker | metadata persisted and thumbnail stored |
| `processing` | `failed` | worker | unreadable input (`failure_reason = unreadable_media`, no retry) or final retry attempt failed (`failure_reason = processing_error`) |

**Storage keys** *(per phase-03-videos/TD-01 — UUID-derived, never from `filename`)*:

| Bucket | Key | Written by |
|--------|-----|------------|
| videos | `{id}/source` | client, via presigned multipart `PUT`s |
| thumbnails | `{id}/auto.jpg` | worker (TD-07); Phase 04 custom thumbnails use a different key in the same bucket |

### API Contracts

Wire format: JSON, camelCase field names as written in the TDs (`filename`, `size`, `contentType`, `title`, `partSize`, `url`, `expiresAt`). Every route identifies the video by its `public_id`, exposed as `publicId` *(per phase-03-videos/TD-08)*. Errors use the inherited envelope `{ statusCode, error, message }` *(per phase-02-auth/TD-07)*. No endpoint receives or returns video bytes *(per phase-03-videos/TD-03)*.

#### POST /videos (SI-03.4)

Pre-registers the video as `draft` and opens the multipart upload *(per phase-03-videos/TD-03, TD-10)*.

**Request headers:**
- Authorization: Bearer {access token}
- Content-Type: application/json

**Request body:**
- title: string, required — 1–100 characters after trim
- filename: string, required — 1–255 characters
- size: integer, required — bytes, 1 ≤ size ≤ 10737418240 (10 GiB)
- contentType: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`

**Response 201:**
- publicId: string (11-char base64url)
- title: string
- status: `draft`
- partSize: integer — 16777216 (16 MiB) *(per video-upload-delivery-limits/TD-01)*
- partCount: integer — `ceil(size / partSize)`, ≤ 640

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (missing field, size out of range, `contentType` outside the allowlist)
- 401 (inherited auth error): missing or invalid access token

---

#### POST /videos/:publicId/upload/part-urls (SI-03.5)

Signs `UploadPart` URLs for the requested part numbers with the public S3 client and bumps `last_activity_at` *(per phase-03-videos/TD-03, TD-04; video-upload-delivery-limits/TD-02, TD-04)*.

**Request headers:**
- Authorization: Bearer {access token}
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1–100 unique items, each 1 ≤ n ≤ `partCount`

**Response 200:**
- parts: `{ partNumber: integer, url: string }[]` — `PUT` URLs on `S3_PUBLIC_ENDPOINT`
- expiresAt: string (ISO-8601) — signing time + 1 h *(per video-upload-delivery-limits/TD-02)*

**Error responses:**
- 400 VALIDATION_ERROR: malformed `partNumbers`
- 400 INVALID_PART_NUMBER: a part number is greater than the video's `partCount`
- 401 (inherited auth error)
- 403 VIDEO_ACCESS_DENIED: the video belongs to another user's channel
- 404 VIDEO_NOT_FOUND: unknown `publicId`
- 409 VIDEO_NOT_DRAFT: video is not in `draft`

---

#### GET /videos/:publicId/upload/parts (SI-03.6)

Lists the parts already stored, for resume after a failure (`ListPartsCommand`) *(per phase-03-videos/TD-03)*.

**Request headers:**
- Authorization: Bearer {access token}

**Response 200:**
- parts: `{ partNumber: integer, etag: string, size: integer }[]` — ascending by `partNumber`

**Error responses:**
- 401 (inherited auth error)
- 403 VIDEO_ACCESS_DENIED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Completes the multipart upload, checks the assembled size, moves the video to `processing` and enqueues the processing job with `jobId = videoId` *(per phase-03-videos/TD-03, TD-05, TD-10)*.

**Request headers:**
- Authorization: Bearer {access token}
- Content-Type: application/json

**Request body:**
- parts: `{ partNumber: integer, etag: string }[]`, required — 1–10000 items; `partNumber` ≥ 1, unique; `etag` non-empty. Sorted ascending by the service before `CompleteMultipartUploadCommand`.

**Response 202:**
- publicId: string
- status: `processing`

**Error responses:**
- 400 VALIDATION_ERROR: malformed `parts`
- 400 INVALID_UPLOAD_PARTS: storage rejects the part list (unknown part, ETag mismatch, part too small)
- 401 (inherited auth error)
- 403 VIDEO_ACCESS_DENIED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT: `complete` is only accepted from `draft` *(per phase-03-videos/TD-10)*
- 413 VIDEO_TOO_LARGE: assembled object (`HeadObjectCommand` `ContentLength`) larger than 10 GiB; the object is deleted and the video set to `failed` *(per phase-03-videos/TD-03)*

---

#### GET /videos/:publicId (SI-03.12)

Returns the video record addressed by its unique URL *(per phase-03-videos/TD-08)*. `@Public()`, in line with the delivery endpoints *(per phase-03-videos/TD-09)*; visibility rules arrive in Phases 04/05.

**Response 200:**
- publicId: string
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- failureReason: string | null
- filename: string
- size: integer
- contentType: string
- durationSeconds: number | null
- width: integer | null
- height: integer | null
- videoCodec: string | null
- audioCodec: string | null
- bitrate: integer | null
- container: string | null
- thumbnail: `{ url: string, expiresAt: string }` | null — presigned GET on the thumbnails bucket, 6 h TTL, present only when `thumbnail_key` is set *(per phase-03-videos/TD-09, video-upload-delivery-limits/TD-03)*
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId/stream (SI-03.13)

Presigned GET for playback; storage serves `Range`/`206` directly *(per phase-03-videos/TD-09)*. `@Public()`.

**Response 200:**
- url: string — presigned `GetObject` on `S3_PUBLIC_ENDPOINT` *(per phase-03-videos/TD-04)*
- expiresAt: string (ISO-8601) — signing time + 6 h *(per video-upload-delivery-limits/TD-03)*

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: status is not `ready` *(per phase-03-videos/TD-09)*

---

#### GET /videos/:publicId/download (SI-03.14)

Same as `/stream`, signed with `ResponseContentDisposition: attachment; filename="{filename}"` *(per phase-03-videos/TD-09)*. `@Public()`.

**Response 200:**
- url: string
- expiresAt: string (ISO-8601) — signing time + 6 h *(per video-upload-delivery-limits/TD-03)*

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — videos

- `title`: required, string, trimmed, 1–100 characters
- `filename`: required, string, 1–255 characters
- `size`: required, integer, 1 ≤ size ≤ 10737418240
- `contentType`: required, `@IsIn(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'])`
- `partNumbers`: required array, 1–100 unique integers ≥ 1 (upper bound `partCount` checked in the service → `INVALID_PART_NUMBER`)
- `parts`: required array, 1–10000 items; each `partNumber` integer ≥ 1 (unique), `etag` non-empty string
- `:publicId`: not validated by pipe; any value that matches no row yields `VIDEO_NOT_FOUND`

### Authorization Matrix

Owner = the authenticated user whose channel (`channels.user_id`) owns the video. Public endpoints use `@Public()` per the inherited opt-out of the global `JwtAuthGuard`.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (video created on the caller's channel) | — |
| POST /videos/:publicId/upload/part-urls | ✗ | ✗ (403) | ✓ |
| GET /videos/:publicId/upload/parts | ✗ | ✗ (403) | ✓ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ (403) | ✓ |
| GET /videos/:publicId | ✓ | ✓ | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ |

### Error Catalog

Inherited envelope `{ statusCode, error, message }` *(per phase-02-auth/TD-07)*; new codes are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`. Body validation keeps the inherited `VALIDATION_ERROR` (400).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` não corresponde a nenhum vídeo |
| VIDEO_ACCESS_DENIED | 403 | Endpoint de upload chamado por usuário que não é dono do canal do vídeo |
| VIDEO_NOT_DRAFT | 409 | Assinar partes, listar partes ou `complete` com o vídeo fora de `draft` (TD-10) |
| VIDEO_NOT_READY | 409 | `stream`/`download` com o vídeo fora de `ready` (TD-09) |
| INVALID_PART_NUMBER | 400 | `partNumbers` contém número maior que o `partCount` do vídeo |
| INVALID_UPLOAD_PARTS | 400 | O storage rejeita a lista de partes no `CompleteMultipartUpload` |
| VIDEO_TOO_LARGE | 413 | Objeto montado maior que 10 GiB no `complete` (TD-03) |

`failure_reason` values persisted on `failed` videos (not HTTP errors, exposed as `failureReason`):

| failure_reason | Set by | Trigger |
|----------------|--------|---------|
| size_exceeded | API `complete` | Objeto montado > 10 GiB |
| upload_abandoned | worker sweep | `draft` sem atividade há mais de 24 h (`last_activity_at`) |
| unreadable_media | worker | ffprobe falha ou não encontra stream de vídeo (sem retry) |
| processing_error | worker | Última tentativa do job falhou (TD-02, TD-06) |

### Events/Messages

Queues on BullMQ + Redis via `@nestjs/bullmq` *(per phase-03-videos/TD-02)*. Producers live in the API; consumers run in the worker process — same codebase, separate entrypoint (`createApplicationContext`) and container *(per phase-03-videos/TD-06)*.

#### video-processing → process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` on `POST /videos/:publicId/upload/complete`, `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 30000 } })` (per `phase-03-videos/TD-05`, `TD-02`); re-enqueued by the sweep for videos stuck in `processing` (per `phase-03-videos/TD-11`)
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')`, `extends WorkerHost`) in the worker (per `phase-03-videos/TD-06`)
**Trigger:** the video moved from `draft` to `processing` after a successful `complete`.
**Processing:** no-op unless status is `processing` *(TD-10)* → presigned GET with the internal client *(TD-04)* → `ffprobe -v error -print_format json -show_format -show_streams <url>` → persist metadata columns + `metadata` jsonb *(TD-06 Revision)* → `ffmpeg -ss <10% of duration> -i <url> -frames:v 1 -vf scale=w=min(1280\,iw):h=-2` JPEG → `PutObject` to thumbnails `{id}/auto.jpg` *(TD-07, TD-01)* → `status = ready`. An unreadable input or no video stream throws BullMQ `UnrecoverableError` and sets `failed` / `unreadable_media` without retry; the `failed` worker event on the final attempt sets `failed` / `processing_error` *(TD-10)*.
**Delivery semantics:** at-least-once; duplicates absorbed by `jobId = videoId` deduplication and the `processing`-only guard (per `phase-03-videos/TD-05`, `TD-10`)

#### video-maintenance → sweep-abandoned-uploads

**Payload:**

```json
{}
```

**Producer:** job scheduler registered by the worker at bootstrap, `upsertJobScheduler('sweep-abandoned-uploads', { every: 3600000 })` (per `phase-03-videos/TD-11`)
**Consumer:** `VideoMaintenanceProcessor` (`@Processor('video-maintenance')`) in the worker (per `phase-03-videos/TD-11`)
**Trigger:** hourly.
**Processing:** (1) `draft` videos with `last_activity_at` older than 24 h → `AbortMultipartUploadCommand` + `status = failed` / `upload_abandoned` *(per video-upload-delivery-limits/TD-04)*; (2) `processing` videos → `queue.add` on `video-processing` with `jobId = videoId`, a no-op while the original job still exists, closing the completed-but-not-enqueued gap *(per phase-03-videos/TD-05, TD-11)*.
**Delivery semantics:** at-least-once; every step is idempotent (aborting an already-aborted upload and re-adding an existing `jobId` are harmless) (per `phase-03-videos/TD-11`)

---

## Dependency Map

```
SI-03.1 (root) — MinIO, Redis e configs
├── SI-03.2 — depends on SI-03.1 (MinIO e storage.config.ts antes do StorageService)
│   ├── SI-03.4 — depends on SI-03.2 + SI-03.3 (storage e entidade antes do init)
│   │   └── SI-03.5 — depends on SI-03.4 (VideosModule/Controller e vídeo draft)
│   │       ├── SI-03.6 — depends on SI-03.5 (findOwnedDraft)
│   │       ├── SI-03.7 — depends on SI-03.5 + SI-03.1 (findOwnedDraft e Redis)
│   │       │   ├── SI-03.9 — depends on SI-03.8 + SI-03.7 (worker e job process-video)
│   │       │   │   └── SI-03.10 — depends on SI-03.9 (metadados antes da thumbnail)
│   │       │   └── SI-03.11 — depends on SI-03.8 + SI-03.7 (worker e fila video-processing)
│   │       └── SI-03.12 — depends on SI-03.5 + SI-03.3 (VIDEO_NOT_FOUND e entidade)
│   │           └── SI-03.13 — depends on SI-03.12 (findByPublicId)
│   │               └── SI-03.14 — depends on SI-03.13 (signDelivery)
│   └── SI-03.8 — depends on SI-03.1 + SI-03.2 (Redis/MinIO/configs e StorageModule)
SI-03.3 (root, independent) — entidade Video e migration
SI-03.15 — depends on SI-03.14 + SI-03.10 + SI-03.11 (documenta endpoints e worker completos)
SI-03.16 — depends on SI-03.1 (amendment: ioredis ^5.11.1 per TD-02 Revision 2026-11-14)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: MinIO, Redis e configuração de storage/fila
- [ ] SI-03.2 — StorageService (adapter S3) e compatibilidade do MinIO
- [ ] SI-03.3 — Entidade Video e migration CreateVideos
- [ ] SI-03.4 — Endpoint POST /videos (pré-cadastro e início do upload)
- [ ] SI-03.5 — Endpoint POST /videos/:publicId/upload/part-urls
- [ ] SI-03.6 — Endpoint GET /videos/:publicId/upload/parts (retomada)
- [ ] SI-03.7 — Endpoint POST /videos/:publicId/upload/complete e enfileiramento
- [ ] SI-03.8 — Infra: Video Worker (entrypoint, container e FFmpeg)
- [ ] SI-03.9 — Processor de vídeo: extração de duração e metadados
- [ ] SI-03.10 — Geração automática de thumbnail
- [ ] SI-03.11 — Sweep agendado de uploads abandonados
- [ ] SI-03.12 — Endpoint GET /videos/:publicId (URL única do vídeo)
- [ ] SI-03.13 — Endpoint GET /videos/:publicId/stream
- [ ] SI-03.14 — Endpoint GET /videos/:publicId/download
- [ ] SI-03.15 — Documentação: CLAUDE.md e contrato OpenAPI
- [ ] SI-03.16 (amendment of SI-03.1) — Cliente Redis fixado em ioredis ^5.11.1

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)

# phase-03-videos — Progress

**Status:** completed
**SIs:** 16/16 completed

### SI-03.1 — Infra: MinIO, Redis e configuração de storage/fila
- **Status:** completed
- **Tests:** 13 passing (`src/config/env.validation.integration-spec.ts`)
- **Observations:**
  - **Imagem MinIO:** `minio/minio` não existe mais no Docker Hub e a Quay exige autenticação (MinIO Community arquivado). Usada `cgr.dev/chainguard/minio` (build do código-fonte oficial, `RELEASE.2026-11-12T01-15-23Z`), fixada por digest `sha256:0f9fda72…` porque o tier free só publica `latest`. Healthcheck via `mc ready local` (a imagem não tem curl/wget).
  - **ioredis:** instalado `^5.11.1` em vez do `^6.0.0` da TD-02 — `typeorm@0.3.28` declara peer opcional `ioredis@^5.0.4` e o npm recusa o 6 (ERESOLVE); `bullmq@6.7.6` aceita `>=5.0.0`. Decisão do usuário; pendente `/decide` para registrar Revision na TD-02.
  - Redis fixado em `redis:8.8.4-alpine`.
  - `.env` local (ignorado pelo git) recebeu as mesmas chaves do `.env.example`.
  - Fora de escopo: `SWAGGER_ENABLED` existe no schema Joi mas não está no `.env.example`.

### SI-03.2 — StorageService (adapter S3) e compatibilidade do MinIO
- **Status:** completed
- **Tests:** 19 passing (`src/storage/storage-keys.spec.ts`, `src/storage/storage.service.integration-spec.ts`)
- **Observations:**
  - **CORS no MinIO:** `PutBucketCors` retorna `NotImplemented` na tag fixada; o caminho que ficou é o global `MINIO_API_CORS_ALLOW_ORIGIN=*` no `compose.yaml`. O `StorageService` ainda tenta o CORS por bucket (S3 de produção suporta) e só registra log quando recebe `NotImplemented`. O teste de compatibilidade cobre preflight e `ETag` exposto em `PUT` cross-origin.
  - `storage-keys.ts` rejeita ids que não sejam UUID, para nenhum `filename` chegar a uma chave.
  - `StorageModule` ainda não é importado pelo `AppModule`; passa a ser via `VideosModule` na SI-03.4 (os buckets são criados no `onModuleInit`).

### SI-03.3 — Entidade Video e migration CreateVideos
- **Status:** completed
- **Tests:** 12 passing (`src/videos/entities/video.entity.integration-spec.ts`, `src/database/migrations.integration-spec.ts`, `src/videos/public-id.util.spec.ts`)
- **Observations:**
  - Migration gerada: `1794671778699-CreateVideos.ts` (enum `videos_status_enum`, FK para `channels`, unique em `public_id`, índices em `channel_id` e em (`status`, `last_activity_at`)); aplicada no banco de dev com `migration:run`.
  - `size` e `bitrate` (`bigint`) usam um transformer para `number`: o Postgres devolve string, e todos os valores (≤ 10 GiB, bitrates) cabem em `Number.MAX_SAFE_INTEGER`.
  - `cleanAllTables` (`src/test/create-test-data-source.ts`) passou a apagar `videos` antes de `channels`, só quando a tabela existe, para não quebrar as outras suítes por FK.
  - Warnings não fatais no run: `DeprecationWarning` do `pg` (client.query concorrente) e `--localstorage-file` sem path válido; preexistentes, fora de escopo.
  - **Correção feita durante a SI-03.4:** a relação `Channel.videos` quebrava as suítes antigas que montam DataSource sem `Video` (`Entity metadata for Channel#videos was not found`); elas não estavam no conjunto de testes desta SI. `Video` foi adicionado ao `ALL_ENTITIES` de 10 specs de `src/auth`, `src/channels` e `src/users`.

### SI-03.4 — Endpoint POST /videos (pré-cadastro e início do upload)
- **Status:** completed
- **Tests:** 15 passing (`src/videos/upload-parts.util.spec.ts`, `src/videos/videos.module.spec.ts`, `src/videos/videos.service.integration-spec.ts`, `src/channels/channels.service.integration-spec.ts` (+2 de `findByUserId`), `test/videos-create.e2e-spec.ts` (5 cenários do spec)); regressão de `src/auth`, `src/channels`, `src/users` e migrations verde (133 testes unit + integração)
- **Observations:**
  - `initiateUpload` abre o multipart antes de gravar a linha; se o insert falhar (fora colisão de `public_id`), o multipart é abortado. Colisão de `public_id` tenta de novo até 5 vezes, mantendo o mesmo `id`/`upload_id`.
  - Usuário sem canal lança `Error` genérico (500): o Phase 02 garante canal 1:1 no cadastro e o Error Catalog não tem código para esse caso.
  - O detector de unique violation do `pg` foi replicado em `videos.service.ts` (mesma lógica do privado em `channels.service.ts`); extrair para um helper comum fica como refatoração fora de escopo.
  - Constantes de domínio em `src/videos/videos.constants.ts` (teto de 10 GiB e allowlist de MIME types); tipo de resposta em `src/videos/videos.types.ts`.
  - O E2E cria o usuário confirmado direto no repositório (hash `argon2`) e o canal pelo `ChannelsService`, e faz login via `POST /auth/login`.

### SI-03.5 — Endpoint POST /videos/:publicId/upload/part-urls
- **Status:** completed
- **Tests:** 16 passing (`src/videos/videos.service.spec.ts` (7, `findOwnedDraft`), `src/videos/videos.service.integration-spec.ts` (+3, `signPartUrls`), `test/videos-upload-part-urls.e2e-spec.ts` (6 cenários do spec)); `test/videos-create.e2e-spec.ts` reexecutado verde após a extração do helper
- **Observations:**
  - `findOwnedDraft` checa existência → dono → status, nessa ordem; um vídeo de outro canal fora de `draft` responde `403`, não `409`.
  - `last_activity_at` é atualizado com `now()` do banco (mesma fonte do default da coluna), não com o relógio do container da API.
  - `partCount` não é persistido: é recalculado de `size` e `UPLOAD_PART_SIZE_BYTES`. Mudar o part size com uploads em andamento mudaria o limite de partes desses uploads.
  - Novo `test/videos-e2e.helpers.ts` (bootstrap do app como no `main.ts`, limpeza com throttler e usuário confirmado + login) para os E2E de vídeos; `test/videos-create.e2e-spec.ts` (SI-03.4) passou a usá-lo.
  - O unit test segue `.claude/rules/nestjs-testing.md` (`Test.createTestingModule` + `getRepositoryToken`), com `MockedMethods<Repository<Video>>`.

### SI-03.6 — Endpoint GET /videos/:publicId/upload/parts (retomada)
- **Status:** completed
- **Tests:** 5 passing (`src/videos/videos.service.integration-spec.ts` (+1, `listUploadedParts`; suíte com 7 verde), `test/videos-upload-parts.e2e-spec.ts` (4 cenários do spec))
- **Observations:**
  - A paginação e a ordenação de `ListParts` já estavam no `StorageService.listParts` (SI-03.2); o service só aplica `findOwnedDraft` e projeta `{ partNumber, etag, size }`.
  - O `etag` devolvido é o mesmo valor (com aspas) do header `ETag` do `PUT`, verificado no integration e no E2E; o cliente pode repassá-lo direto ao `complete`.

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete e enfileiramento
- **Status:** completed
- **Tests:** 14 passing (`src/videos/videos.service.spec.ts` (+7, `completeUpload`), `src/videos/videos.service.integration-spec.ts` (+2, MinIO + Redis reais), `src/videos/videos.module.spec.ts` (fila registrada), `test/videos-upload-complete.e2e-spec.ts` (4 cenários do spec)); as 3 suítes de `src/videos` somam 24 verdes
- **Observations:**
  - **Jest × ESM:** `@nestjs/bullmq@12.0.2` e `@nestjs/bull-shared@12.0.2` são ESM-only (`"type": "module"`). O runtime real carrega sem problema (Node 25 suporta `require` de ESM, verificado no container), mas o runtime CommonJS do Jest não. Correção só na config de teste, sem mexer na TD-02: em `package.json` (`jest`) e `test/jest-e2e.json`, regra de `transform` dedicada que compila esses dois pacotes com `ts-jest` (`allowJs`, `module: commonjs`) e exceção em `transformIgnorePatterns`. Tentativa 1 do fix loop.
  - Erros do storage mapeados para `INVALID_UPLOAD_PARTS`: `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`. Outros erros (ex.: `NoSuchUpload`) sobem como estão (500).
  - O ramo > 10 GiB (AC #5) é coberto só pelo unit test, como previsto no spec; o limite exato de 10 GiB é aceito.
  - Os testes de integração e E2E limpam a fila `video-processing` com `obliterate({ force: true })` antes de cada caso; ela é compartilhada com o Redis de dev.
  - A ordem "gravar `processing` → enfileirar" deixa uma janela: se o `queue.add` falhar, o vídeo fica em `processing` sem job. O sweep da SI-03.11 (TD-11) reenfileira esses casos.

### SI-03.8 — Infra: Video Worker (entrypoint, container e FFmpeg)
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verificados manualmente: `ffprobe`/`ffmpeg` 5.1.9-0+deb12u1 nos containers `nestjs-api` e `video-worker`; log do worker "Video worker application context started" sem porta HTTP; `npm run build` da API com o worker em watch não reiniciou o worker nem tocou `dist-worker/`. Smoke de regressão do `AppModule`: `test/app.e2e-spec.ts` + `test/videos-create.e2e-spec.ts` verdes (6)
- **Observations:**
  - **Versão do FFmpeg para o CLAUDE.md (SI-03.15):** `ffmpeg version 5.1.9-0+deb12u1` (pacote Debian bookworm da imagem `node:25.6.0-slim`).
  - Build de dev do worker isolado em `dist-worker/` via `tsconfig.worker.json` (`outDir` e `tsBuildInfoFile` próprios), com `nest start --watch --path tsconfig.worker.json --entryFile worker/main`. Motivo: o `deleteOutDir: true` do `nest-cli.json` apaga o `dist/` inteiro a cada restart do watcher da API. `dist-worker` foi adicionado ao `.gitignore` e aos `exclude` de `tsconfig.json`/`tsconfig.build.json`. O `start:worker:prod` usa o `dist/worker/main` do `nest build` normal.
  - Para não duplicar a config, `ConfigModule.forRoot`, `TypeOrmModule.forRootAsync` e `BullModule.forRootAsync` saíram do `AppModule` para `src/config/root-modules.ts`, importado pelo `AppModule` e pelo `WorkerModule`. O comportamento do `AppModule` não mudou.
  - O critério "API `start:dev` continua compilando" foi verificado com `npm run build` (mesmo compilador e `deleteOutDir`), sem subir o servidor, conforme a regra do `nestjs-project/CLAUDE.md`.
  - Os containers `nestjs-api` e `video-worker` foram recriados com a imagem nova (`docker compose build` + `up -d`).

### SI-03.9 — Processor de vídeo: extração de duração e metadados
- **Status:** completed
- **Tests:** 18 passing (`src/worker/media/probe-mapper.spec.ts`, `src/worker/media/ffprobe.integration-spec.ts`, `src/worker/processing/video-processing.processor.integration-spec.ts`, `src/worker/processing/video-processing.processor.spec.ts`)
- **Observations:**
  - Fixtures de vídeo geradas no teste com `ffmpeg -f lavfi testsrc` (+ `sine` para áudio), 320x240 H.264/AAC, via helper `src/test/video-fixtures.ts` (só teste; escreve em diretório temporário).
  - O `WorkerModule` registra `TypeOrmModule.forFeature([Video, Channel, User])`: o `Video` referencia `Channel`, que referencia `User`, e o `autoLoadEntities` só carrega entidades registradas.
  - O `update` final usa `QueryDeepPartialEntity<Video>` por cast: o tipo parcial profundo do TypeORM não aceita `Record<string, unknown>` na coluna `jsonb`.
  - Falha ao executar o `ffprobe` (ex.: binário ausente) é tratada como erro de infraestrutura e entra no retry; só saída ≠ 0, JSON inválido ou ausência de stream de vídeo viram `unreadable_media`.
  - Todas as transições usam `update` condicionado a `status = processing`, então reentregas e eventos tardios não sobrescrevem `ready`/`failed`.
  - **Risco para a verificação final:** o `video-worker` do Compose agora consome a fila `video-processing` do mesmo Redis e banco dos testes. Os E2E/integração da SI-03.7 enfileiram jobs reais, e o worker de dev pode processá-los durante o teste (status muda para `failed`, contagem da fila cai). Mitigação a decidir: parar o `video-worker` ao rodar a suíte, ou isolar a fila dos testes (ex.: `prefix` próprio).

### SI-03.10 — Geração automática de thumbnail
- **Status:** completed
- **Tests:** 15 passing (`src/worker/media/thumbnail.integration-spec.ts` (2), `src/worker/processing/video-processing.processor.integration-spec.ts` (+1, suíte com 6), `src/worker/processing/video-processing.processor.spec.ts` (suíte com 7))
- **Observations:**
  - O processor agora grava os metadados (status ainda `processing`), extrai a thumbnail, faz `putObject` em `thumbnails/{id}/auto.jpg` e só então grava `thumbnail_key` + `ready`. Falha na extração lança `Error` comum e entra no retry da SI-03.9.
  - O JPEG sai do `ffmpeg` por `image2pipe` no stdout; nada é gravado em disco. Duração nula usa offset 0.
  - Largura e altura da thumbnail são verificadas lendo o segmento SOF do JPEG (`readJpegSize` em `src/test/video-fixtures.ts`), sem depender de outra ferramenta.
  - O helper de fixture ganhou o parâmetro `size` (padrão `320x240`) para as fontes 1920×1080 e 640×360.

### SI-03.11 — Sweep agendado de uploads abandonados
- **Status:** completed
- **Tests:** 6 passing (`src/worker/maintenance/video-sweep.service.integration-spec.ts` (5), `src/worker/maintenance/video-maintenance.scheduler.integration-spec.ts` (1))
- **Observations:**
  - `NoSuchUpload` no `abortMultipartUpload` é tratado no `VideoSweepService` (upload já abortado/concluído); o `StorageService` da SI-03.2 não foi alterado. Draft sem `upload_id` pula o abort.
  - As transições do sweep usam `update` condicionado ao status atual (`draft`), então rodadas concorrentes ou repetidas não alteram vídeos que mudaram de estado.
  - Nomes da fila de manutenção, do job e do intervalo em `src/worker/maintenance/video-maintenance.queue.ts`; as opções do `process-video` reutilizam `PROCESS_VIDEO_JOB_OPTIONS` de `src/videos/videos.queue.ts`, compartilhadas com o producer da API.
  - O `video-worker` de dev foi parado durante a execução dos testes desta SI e religado depois: ele consome as mesmas filas e o mesmo banco, e o `upsertJobScheduler` dispara o sweep na hora do registro.

### SI-03.12 — Endpoint GET /videos/:publicId (URL única do vídeo)
- **Status:** completed
- **Tests:** 11 passing (`src/videos/dto/video-response.dto.spec.ts` (4), `src/videos/videos.service.integration-spec.ts` (+3, `findByPublicId`; suíte com 12), `test/videos-get.e2e-spec.ts` (4 cenários do spec))
- **Observations:**
  - `VideoResponseDto.fromEntity` monta a resposta explicitamente, campo a campo, então campos internos (`id`, `upload_id`, `channel_id`, `metadata`, `thumbnail_key`) nunca saem; `size`/`bitrate` passam por `Number()` além do transformer da entidade.
  - Assinatura pública com TTL `DELIVERY_URL_TTL_SECONDS` centralizada em `VideosService.signPublicGet` (reaproveitada por stream/download nas SI-03.13/03.14).
  - Novo helper `seedVideo` em `test/videos-e2e.helpers.ts` semeia vídeos `ready`/`failed` direto no repositório + storage, como o spec prevê.
  - O `npx prettier --write test` reformatou `test/jest-e2e.json` (só formatação de arrays, sem mudança de conteúdo).

### SI-03.13 — Endpoint GET /videos/:publicId/stream
- **Status:** completed
- **Tests:** 5 passing (`src/videos/videos.service.integration-spec.ts` (+2, `signDelivery`; suíte com 14), `test/videos-stream.e2e-spec.ts` (3 cenários do spec))
- **Observations:**
  - `signDelivery(publicId, mode)` já recebe o `mode`; nesta SI só o `stream` existe e o parâmetro fica sem uso (com `eslint-disable` pontual) até a SI-03.14 adicionar o `Content-Disposition` do `download`.
  - O Range/206 é servido pelo MinIO direto na URL pública; o teste confirma `Content-Range: bytes 0-1023/8192` e 1024 bytes.

### SI-03.14 — Endpoint GET /videos/:publicId/download
- **Status:** completed
- **Tests:** 11 passing (`src/videos/content-disposition.util.spec.ts` (8), `src/videos/videos.service.integration-spec.ts` (+1, download; suíte com 15), `test/videos-download.e2e-spec.ts` (3 cenários do spec))
- **Observations:**
  - `sanitizeFilename` remove caracteres de controle, `"`, `\`, `/` e segmentos `..`/`.`; nome vazio cai para `video`. Nomes não-ASCII geram `filename` ASCII (acentos removidos, demais caracteres → `_`) + `filename*=UTF-8''…` (RFC 5987).
  - O subagente rodou o unit/integração e o E2E desta SI em paralelo (contra a instrução); ambos passaram. A suíte completa roda em sequência na verificação final.

### SI-03.15 — Documentação: CLAUDE.md e contrato OpenAPI
- **Status:** completed
- **Tests:** 2 passing (`src/openapi-export.integration-spec.ts`: +2, os 7 endpoints de `/videos` com os códigos do Error Catalog e igualdade com o `openapi.json` commitado; suíte com 11)
- **Observations:**
  - `CLAUDE.md` da raiz: fila = BullMQ + Redis; storage = MinIO local / S3 em produção via URLs pré-assinadas; Video Worker no mesmo codebase com container próprio.
  - `nestjs-project/CLAUDE.md`: serviços `minio`, `redis`, `video-worker` (e `mailpit`, que faltava) com verificações de prontidão; exceção do `S3_PUBLIC_ENDPOINT`; FFmpeg 5.1.9-0+deb12u1; seção "Video Worker" (`start:worker:dev`/`prod`, `dist-worker/`); requisito de MinIO/Redis reais nos testes e orientação de parar o `video-worker` durante a suíte; regra de `transform` do Jest para o `@nestjs/bullmq` ESM-only.
  - `api.http`: exemplos 10–16 cobrindo os 7 endpoints de vídeos.
  - **Fora de escopo (preexistente):** o `openapi:export` roda via `ts-node`, sem o plugin do `@nestjs/swagger`, então os schemas de DTO saem com `properties: {}` — igual aos DTOs da auth da Fase 02 já commitados. Corrigir exigiria gerar o `metadata.ts` (`PluginMetadataGenerator`) ou exportar a partir do build; fica como tarefa separada.

### SI-03.16 (amendment of SI-03.1) — Cliente Redis fixado em ioredis ^5.11.1
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verificados: `npm ls ioredis` mostra `ioredis@5.11.1` como dependência direta e `deduped` sob `bullmq@6.7.6` e `typeorm@0.3.28`, sem `invalid`; `npm install` no container sem `ERESOLVE` nem conflito de peer, e o diff do `package-lock.json` permaneceu o mesmo da SI-03.1 (+718/−4).
- **Observations:**
  - Nenhuma alteração de código nesta SI: o `ioredis@^5.11.1` já estava em `package.json` desde a SI-03.1 (registrado pela Revision da TD-02 de 2026-11-14).
  - O `npm install` reporta vulnerabilidades no `npm audit` (preexistentes, fora de escopo).

## Final verification (2026-11-14)

- `npm test -- --runInBand`: 40 suítes, 260 testes verdes (2ª rodada).
- `npm run test:e2e -- --runInBand`: 10 suítes, 81 testes verdes.
- `npx tsc --noEmit`: sem erros.
- `npm run lint`: 0 erros, 23 warnings `no-unsafe-argument` preexistentes em `src/auth/auth.service*.spec.ts` (regra configurada como warning).
- `npm run build`: sem erros (1ª rodada; só um arquivo de teste mudou depois).
- **Fix loop (tentativa 1):** a 1ª rodada falhou em `src/database/migrations.integration-spec.ts` com `deadlock detected`: o `beforeAll` fazia `DROP TABLE ... CASCADE` em paralelo (`Promise.all`), e a tabela `videos` (FK para `channels`) tornou a disputa de locks frequente. Os drops passaram a ser sequenciais; a suíte e a verificação completa ficaram verdes.
- O `video-worker` de dev foi parado durante a verificação e religado ao final.

- **Revisão dos critérios de aceite (2026-11-14, só docs):** `nestjs-project/CLAUDE.md` ganhou a seção `## Videos Module` (estrutura, 7 endpoints, ciclo de status, filas, storage e limites, tudo tirado do código); `library-refs.md` alinhado ao código: `ioredis ^5.11.1` (Revision da TD-02, revalidado no Context7 `/redis/ioredis/v5.11.1`) e FFmpeg `5.1.9-0+deb12u1`. `sources_mtime` de `context.md`, `phase-03-videos.md` e `validation.md` refrescados; `validation.md` segue `clean`.
- **Revisão das dicas finais (2026-11-14):** faltava um teste do caminho real fila → worker. Nova suíte `src/worker/processing/video-processing.queue.integration-spec.ts` (sem mocks): job em `video-processing` no Redis consumido por um Worker BullMQ real (`VideoProcessingProcessor`) → vídeo `ready` com thumbnail e duração; mídia ilegível → `failed` / `unreadable_media` em 1 tentativa. Passou 2× seguidas; suíte completa 41 suítes / 262 testes, e2e 10 / 81, `tsc` 0, lint 0 erros.

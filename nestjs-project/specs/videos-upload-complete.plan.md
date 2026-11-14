---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` fecha o multipart com a lista `{ partNumber, etag }`, confere o tamanho montado (teto de 10 GiB), move o vídeo de `draft` para `processing` e enfileira o job `process-video` na fila `video-processing` com `jobId = videoId` (enfileiramento idempotente). Responde `202`, porque o processamento é assíncrono.

## Test Scenarios

### 1. Completar upload e enfileirar processamento

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Antes de cada teste, a fila `video-processing` é esvaziada (`obliterate`) e um vídeo é criado via `POST /videos` (`size: 20971520`, `partCount: 2`), com as partes 1 (16 MiB) e 2 (4 MiB) enviadas por `PUT` às URLs de `part-urls`, guardando os `ETag`s.

#### 1.1. completa-e-move-para-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/complete como dono com `{ "parts": [{ "partNumber": 2, "etag": "<etag2>" }, { "partNumber": 1, "etag": "<etag1>" }] }` (fora de ordem de propósito)
    - expect: status `202` com `{ publicId, status: "processing" }`
  2. `HeadObject` em `{id}/source` no bucket de vídeos
    - expect: objeto existe com `ContentLength = 20971520`
  3. `queue.getJob(<id do vídeo>)` na fila `video-processing` (via `getQueueToken('video-processing')`)
    - expect: job com nome `process-video` e `data` igual a `{ videoId: <id> }`
    - expect: no banco, `status = 'processing'`

#### 1.2. segundo-complete-nao-cria-outro-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/complete como dono com as partes válidas
    - expect: status `202`
  2. Repetir a mesma chamada
    - expect: status `409` com `error: "VIDEO_NOT_DRAFT"`
    - expect: a fila `video-processing` contém exatamente 1 job

### 2. Rejeitar conclusão inválida

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Mesmo preparo do grupo 1; um segundo usuário confirmado é criado para o cenário de não dono.

#### 2.1. rejeita-etag-divergente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/complete como dono com `etag: "\"0000\""` na parte 1
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
    - expect: no banco o vídeo continua `status = 'draft'`
    - expect: a fila `video-processing` está vazia

#### 2.2. nega-acesso-a-outro-usuario

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/complete com o token do segundo usuário e as partes válidas
    - expect: status `403` com `error: "VIDEO_ACCESS_DENIED"`
    - expect: no banco o vídeo continua `draft`

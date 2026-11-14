---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId Test Plan

## Application Overview

`GET /videos/:publicId` resolve o vídeo pela URL única (`public_id`, 11 caracteres base64url) e devolve status, metadados extraídos e a thumbnail como URL pré-assinada (6 h) quando existir. É público (`@Public()`) e não expõe campos internos (`id`, `upload_id`, `channel_id`, `metadata`).

## Test Scenarios

### 1. Resolver vídeo pela URL única

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Vídeos em `ready`/`failed` são semeados direto no banco (repositório `Video`), com o objeto `{id}/source` (alguns KiB) e, quando indicado, `{id}/auto.jpg` gravados via `StorageService.putObject` — o worker não roda no E2E.

#### 1.1. retorna-video-ready-sem-token

**Covers AC:** #1, #2, #5
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Semear um vídeo `ready` com metadados (`duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `container`), `metadata` jsonb e `thumbnail_key = '{id}/auto.jpg'` com o JPEG gravado
  2. GET /videos/{publicId} sem header `Authorization`
    - expect: status `200` com `publicId`, `title`, `status: "ready"`, `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `bitrate` (number), `container`, `size` (number), `contentType`, `filename` e `createdAt`
    - expect: o body não contém as chaves `id`, `uploadId`/`upload_id`, `channelId`/`channel_id` nem `metadata`
    - expect: `thumbnail.expiresAt` entre 5h59 e 6h01 após a chamada
  3. `fetch(thumbnail.url)`
    - expect: status `200` com `Content-Type: image/jpeg`

#### 1.2. retorna-draft-sem-metadados

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Criar um vídeo via POST /videos e chamar GET /videos/{publicId} sem token
    - expect: status `200` com `status: "draft"`, `durationSeconds: null`, `width: null`, `videoCodec: null` e `thumbnail: null`

#### 1.3. retorna-failure-reason-de-video-failed

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Semear um vídeo `failed` com `failure_reason = 'unreadable_media'`
  2. GET /videos/{publicId} sem token
    - expect: status `200` com `status: "failed"` e `failureReason: "unreadable_media"`

#### 1.4. retorna-404-para-public-id-inexistente

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. GET /videos/inexistente sem token
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/:publicId/stream Test Plan

## Application Overview

`GET /videos/:publicId/stream` devolve `{ url, expiresAt }` com um GET pré-assinado (6 h, endpoint público) sobre o objeto de origem de um vídeo `ready`. O storage atende `Range`/`206` direto, então a reprodução não precisa do download completo e o vídeo não passa pela API. É público (`@Public()`); vídeos fora de `ready` não são assinados.

## Test Scenarios

### 1. Entregar URL de streaming

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Vídeos em `ready`/`failed` são semeados direto no banco (repositório `Video`), com o objeto `{id}/source` (alguns KiB) e, quando indicado, `{id}/auto.jpg` gravados via `StorageService.putObject` — o worker não roda no E2E. O objeto de origem semeado tem 8192 bytes.

#### 1.1. assina-url-de-video-ready

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Semear um vídeo `ready` com `{id}/source` gravado
  2. GET /videos/{publicId}/stream sem header `Authorization`
    - expect: status `200` com `url` no host de `S3_PUBLIC_ENDPOINT`
    - expect: `expiresAt` entre 5h59 e 6h01 após a chamada
  3. `fetch(url, { headers: { Range: 'bytes=0-1023' } })`
    - expect: status `206` com header `Content-Range: bytes 0-1023/8192` e corpo de 1024 bytes

#### 1.2. rejeita-video-fora-de-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Para cada status em `draft`, `processing` e `failed`, semear um vídeo e chamar GET /videos/{publicId}/stream sem token
    - expect: status `409` com `error: "VIDEO_NOT_READY"` nos três casos

#### 1.3. retorna-404-para-public-id-inexistente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. GET /videos/AAAAAAAAAAA/stream sem token
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

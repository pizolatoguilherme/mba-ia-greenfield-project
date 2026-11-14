---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/:publicId/download Test Plan

## Application Overview

`GET /videos/:publicId/download` devolve `{ url, expiresAt }` com um GET pré-assinado (6 h) assinado com `ResponseContentDisposition: attachment`, para o navegador baixar o arquivo com o nome original sanitizado. O arquivo é servido direto pelo storage. É público (`@Public()`) e só assina vídeos `ready`.

## Test Scenarios

### 1. Entregar URL de download

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Vídeos em `ready`/`failed` são semeados direto no banco (repositório `Video`), com o objeto `{id}/source` (alguns KiB) e, quando indicado, `{id}/auto.jpg` gravados via `StorageService.putObject` — o worker não roda no E2E.

#### 1.1. baixa-com-nome-original

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Semear um vídeo `ready` com `filename = 'meu-video.mp4'` e `{id}/source` de 8192 bytes
  2. GET /videos/{publicId}/download sem header `Authorization`
    - expect: status `200` com `url` e `expiresAt` entre 5h59 e 6h01 após a chamada
  3. `fetch(url)`
    - expect: status `200`, corpo com 8192 bytes e `Content-Disposition` contendo `attachment` e `filename="meu-video.mp4"`

#### 1.2. sanitiza-filename-malicioso

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Semear um vídeo `ready` com `filename = '../a"b.mp4'`
  2. GET /videos/{publicId}/download e `fetch(url)`
    - expect: `Content-Disposition` sem `"` dentro do nome e sem `../`

#### 1.3. rejeita-video-fora-de-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Semear um vídeo `processing` e chamar GET /videos/{publicId}/download sem token
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

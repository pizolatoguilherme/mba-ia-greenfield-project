---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:publicId/upload/part-urls Test Plan

## Application Overview

`POST /videos/:publicId/upload/part-urls` assina sob demanda as URLs de `PUT` das partes pedidas (TTL de 1 h) para um vídeo em `draft` do próprio usuário, e atualiza `last_activity_at`. É o mecanismo de re-assinatura usado para retomar uploads. Só o dono do canal pode chamar; o vídeo precisa estar em `draft`.

## Test Scenarios

### 1. Assinar URLs de partes para o dono

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Cada teste parte de um vídeo criado via `POST /videos` (`size: 33554432`, `partCount: 2`).

#### 1.1. assina-urls-e-aceita-put-da-parte

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/part-urls como dono com `{ "partNumbers": [1, 2] }`
    - expect: status `200`
    - expect: `parts` com 2 itens `{ partNumber, url }`, e cada `url` no host de `S3_PUBLIC_ENDPOINT`
    - expect: `expiresAt` entre 59 e 61 minutos após o instante da chamada
  2. `fetch(url, { method: 'PUT', body: <16 MiB> })` na URL da parte 1
    - expect: status `200` do storage, com header `ETag` presente

#### 1.2. atualiza-last-activity-at

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Ler `last_activity_at` do vídeo e esperar ao menos 1 s
  2. POST /videos/{publicId}/upload/part-urls como dono com `{ "partNumbers": [1] }`
    - expect: status `200`
    - expect: `last_activity_at` no banco é posterior ao valor lido no passo 1

#### 1.3. rejeita-parte-acima-do-part-count

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/part-urls como dono com `{ "partNumbers": [3] }`
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`

### 2. Restringir acesso e estado

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Cada teste parte de um vídeo criado via `POST /videos`; um segundo usuário confirmado é criado para os cenários de não dono.

#### 2.1. nega-acesso-a-outro-usuario

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/{publicId}/upload/part-urls com o token do segundo usuário e `{ "partNumbers": [1] }`
    - expect: status `403` com `error: "VIDEO_ACCESS_DENIED"`

#### 2.2. retorna-404-para-public-id-inexistente

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos/AAAAAAAAAAA/upload/part-urls como dono com `{ "partNumbers": [1] }`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 2.3. rejeita-video-fora-de-draft

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Atualizar no banco o `status` do vídeo para `processing`
  2. POST /videos/{publicId}/upload/part-urls como dono com `{ "partNumbers": [1] }`
    - expect: status `409` com `error: "VIDEO_NOT_DRAFT"`

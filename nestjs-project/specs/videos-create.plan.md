---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pré-cadastra o vídeo como `draft` no canal do usuário autenticado e abre o multipart upload no storage, devolvendo `publicId`, `partSize` (16 MiB) e `partCount`. O endpoint recebe apenas metadados (`title`, `filename`, `size`, `contentType`); nenhum byte de vídeo passa pela API. Valida o teto de 10 GiB e a allowlist de `contentType`.

## Test Scenarios

### 1. Pré-cadastrar vídeo como rascunho ao iniciar o upload

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container.

#### 1.1. cria-draft-com-parametros-de-upload

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "title": "Meu vídeo", "filename": "clip.mp4", "size": 1073741824, "contentType": "video/mp4" }`
    - expect: status `201`
    - expect: body com `status: "draft"`, `partSize: 16777216`, `partCount: 64`, `title: "Meu vídeo"`
    - expect: `publicId` casa `/^[A-Za-z0-9_-]{11}$/`
  2. Consultar `videos` pelo `public_id` devolvido
    - expect: uma linha com `status = 'draft'`, `channel_id` igual ao canal do usuário, `title`, `filename`, `size` e `content_type` iguais aos enviados, e `upload_id` preenchido

### 2. Rejeitar inicialização inválida

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container.

#### 2.1. rejeita-content-type-fora-da-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos autenticado com `contentType: "video/avi"` e demais campos válidos
    - expect: status `400` com `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha criada em `videos`

#### 2.2. rejeita-tamanho-acima-de-10-gib

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos autenticado com `size: 10737418241` e demais campos válidos
    - expect: status `400` com `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha criada em `videos`

#### 2.3. rejeita-sem-titulo

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos autenticado sem o campo `title`
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 2.4. rejeita-sem-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. POST /videos com body válido e sem header `Authorization`
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`

---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-parts.e2e-spec.ts
---

# GET /videos/:publicId/upload/parts Test Plan

## Application Overview

`GET /videos/:publicId/upload/parts` lista as partes já armazenadas de um upload em andamento (`ListParts`), para o cliente retomar após uma falha de conexão sem reenviar o que já foi. Só o dono pode consultar, e apenas com o vídeo em `draft`.

## Test Scenarios

### 1. Listar partes para retomada

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Cada teste parte de um vídeo criado via `POST /videos` com `size: 50331648` (`partCount: 3`).

#### 1.1. lista-vazia-logo-apos-init

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. GET /videos/{publicId}/upload/parts como dono
    - expect: status `200` com `{ "parts": [] }`

#### 1.2. lista-somente-partes-enviadas

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Assinar as partes 1 e 3 via POST /videos/{publicId}/upload/part-urls e fazer `PUT` de 16 MiB em cada URL
  2. GET /videos/{publicId}/upload/parts como dono
    - expect: status `200`
    - expect: `parts` com exatamente 2 itens, `partNumber` 1 e 3 em ordem crescente, cada um com `etag` igual ao `ETag` devolvido no `PUT` e `size: 16777216`

### 2. Restringir acesso e estado

**Setup:** `beforeAll` sobe `AppModule` via `Test.createTestingModule(...).compile()` reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` limpa o banco com `cleanAllTables`, cria um usuário confirmado com canal e obtém `access_token` via `POST /auth/login`. MinIO e Redis são os serviços reais do Compose; no ambiente de teste `S3_PUBLIC_ENDPOINT=http://minio:9000`, porque as URLs pré-assinadas são buscadas de dentro do container. Cada teste parte de um vídeo criado via `POST /videos`; um segundo usuário confirmado é criado para o cenário de não dono.

#### 2.1. nega-acesso-a-outro-usuario

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. GET /videos/{publicId}/upload/parts com o token do segundo usuário
    - expect: status `403` com `error: "VIDEO_ACCESS_DENIED"`

#### 2.2. rejeita-video-fora-de-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-14T13:20:07Z

**Steps:**
  1. Atualizar no banco o `status` do vídeo para `ready`
  2. GET /videos/{publicId}/upload/parts como dono
    - expect: status `409` com `error: "VIDEO_NOT_DRAFT"`

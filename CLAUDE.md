# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

FarmaJyV backend: a pharmacy management REST API. It runs as a single Firebase Cloud Function (`api`, region `us-central1`) that mounts an Express app. Firestore is the database, Firebase Auth issues tokens, and Cloud Storage holds uploaded invoice files. Firebase project id is `farma-jyv`. All code lives in [functions/](functions/); the repo root only holds Firebase config.

Note: user-facing strings and error messages are in Spanish. Match that when adding new ones.

See [GOALS.md](GOALS.md) for the product/functional goals and [MEMORY.md](MEMORY.md) for a persistent fact sheet (collections, endpoints, env vars, known pending work) — keep both updated when architecture or scope shifts.

## Commands

All commands run from [functions/](functions/):

```bash
npm run build          # tsc -> lib/
npm run build:watch    # tsc --watch
npm run lint           # ESLint (flat config disabled; uses .eslintrc.js)
npm run dev            # build + run lib/dev-server.js (plain Express on PORT, default 3000)
npm run serve          # build + firebase emulators:start (functions/firestore/auth + UI)
npm run deploy         # build + deploy functions, firestore rules/indexes, and storage rules
npm run migrate:roles  # build + run lib/scripts/migrate-roles.js
npm run logs           # firebase functions:log
```

Emulator ports: functions 5001, firestore 8080, auth 9099. There is no test runner configured — `firebase-functions-test` is installed but no test files or `test` script exist yet.

## Request lifecycle

Every request flows through the same layered path — respect these boundaries when adding features:

```
routes/*.routes.ts  ->  middleware (authenticate, requirePermission, validate)
  ->  services/*.service.ts  (business logic, Firestore transactions)
    ->  repositories/*.repository.ts  (raw Firestore reads/writes for one collection)
```

- **Routes** ([functions/src/routes/](functions/src/routes/)) are thin. Each file `router.use(authenticate)` at the top, then per-endpoint `requirePermission(area, level)` and `validate({ body/query/params })`. Handlers `try/catch` and forward errors via `next(error)`. All routes are mounted under `/v1` (see [app.ts](functions/src/app.ts) and [routes/index.ts](functions/src/routes/index.ts)).
- **Services** hold all business logic and orchestrate multiple repositories. Cross-collection writes (sales, inventory entries/exits) MUST use `firestore.runTransaction`. Services throw `AppError`s from [utils/errors.ts](functions/src/utils/errors.ts) (`notFound`, `badRequest`, `forbidden`, `unauthorized`, `conflict`) — never raw errors for expected failures.
- **Repositories** are the only place that touches Firestore collections directly. One file per collection; they return domain types from [types/index.ts](functions/src/types/index.ts) and stamp `createdAt`/`updatedAt` via `now()`.

Responses use the envelope `{ data, meta? }`. Errors are converted to `{ error: { code, message } }` by [middleware/error-handler.ts](functions/src/middleware/error-handler.ts).

Get Firestore via `db()` and timestamps via `now()` / `toTimestamp()` from [utils/firestore.ts](functions/src/utils/firestore.ts) — do not call `getFirestore()` directly. `admin.initializeApp()` happens once in [index.ts](functions/src/index.ts) / [dev-server.ts](functions/src/dev-server.ts).

## Auth & permissions

- `authenticate` verifies the Firebase ID token (`Authorization: Bearer <token>`), loads the user profile from the `users` collection, resolves the active role, and attaches `req.authUser` (uid, email, role summary, and full `permissions` array). Reject inactive users.
- Roles live in the `roles` collection. Permissions are `{ area, level }` where area ∈ [permissions.ts](functions/src/constants/permissions.ts) `ALL_PERMISSION_AREAS` and level is `read` | `write`. `write` implies `read`.
- The `admin` role slug bypasses all permission checks (`hasPermission` short-circuits). System roles (`admin`, `cashier`, `manager`, `doctor`) are defined in `SYSTEM_ROLE_DEFINITIONS` and cannot have their slug changed, be deactivated.
- Permissions are also mirrored into Firebase Auth custom claims via `syncUserClaims`. When a role's permissions change, `syncRoleUsersClaims` re-syncs every assigned user. Keep claims and the Firestore role in sync whenever you touch roles.
- Legacy migration: `authenticate` transparently migrates old string `role` fields to `roleId`. Seeding/migration is exposed via `POST /v1/internal/migrate-roles` (guarded by the `x-migrate-secret` header matching `MIGRATE_SECRET`) and the `migrate:roles` script.

## Domain specifics

- **Inventory is batch-based (FEFO).** Stock is tracked per `batches` document (product + lotNumber + expiryDate + quantity), not on the product. Sales allocate stock First-Expired-First-Out via `allocateFefo` in [utils/fefo.ts](functions/src/utils/fefo.ts). Every stock change writes a `stockMovements` audit record (`entry`, `exit_waste`, `exit_expiry`, `sale_adjustment`). See [services/inventory.service.ts](functions/src/services/inventory.service.ts) and [services/sales.service.ts](functions/src/services/sales.service.ts).
- **Inventory entries** are tied to an invoice (`invoiceId` → supplier). Recording an entry upserts batches (matching on product/lot/expiry), creates movements, and updates the product's `suppliers` array and `lastCostPriceBySupplier` map — all in one transaction.
- **Product search** is done in-memory across name/sku/barcode/activeIngredient/concentration via `matchesProductSearch` ([utils/product-search.ts](functions/src/utils/product-search.ts)). List endpoints fetch, then filter and `paginate()` in the service layer (Firestore isn't queried by search term).
- **Pagination** helpers (`parsePagination`, `paginate`, `buildListMeta`) are in [utils/pagination.ts](functions/src/utils/pagination.ts). List services return `{ items, meta }`.
- **File uploads** use `multer` (memory storage). The JSON body parser in [app.ts](functions/src/app.ts) is skipped for `multipart/form-data`. Invoice files go to Cloud Storage; see [middleware/upload.ts](functions/src/middleware/upload.ts), [services/uploads.service.ts](functions/src/services/uploads.service.ts), and [utils/storage.ts](functions/src/utils/storage.ts).

## Validation & types

- All input validation uses **Zod** schemas centralized in [schemas/index.ts](functions/src/schemas/index.ts), applied via the `validate` middleware which reassigns `req.body/query/params` with the parsed result.
- Domain types (`Product`, `Batch`, `Sale`, `Role`, etc.) live in [types/index.ts](functions/src/types/index.ts). Firestore timestamps are `firebase-admin` `Timestamp`. `req.authUser` is typed in [types/express.d.ts](functions/src/types/express.d.ts).

## Code style

Enforced by ESLint ([.eslintrc.js](functions/.eslintrc.js)): single quotes, **4-space indent**, max line length 100, unused vars error (prefix intentional ones with `_`). Run `npm run lint` before deploying.

## Environment variables

Set in [functions/.env](functions/.env) (not committed): `CORS_ORIGINS` (comma-separated allowlist; see [config/env.ts](functions/src/config/env.ts)) and `MIGRATE_SECRET` (guards the internal migration endpoint).

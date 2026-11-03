# 01 — Project layout and shared-code boundaries

These conventions describe how a Bambu NestJS + Prisma backend is organized **at the application-code level**. They say nothing about where or how the compiled app runs (container, serverless function, VM, Kubernetes pod…) — that is an infrastructure decision made elsewhere (see `bambu-terraform-aws` or the project's own deploy docs) and never changes the rules in this skill.

## Layout

Either shape below is valid — pick the one the repo already uses, don't migrate between them as a side effect of an unrelated task:

```
# Single-app shape
src/
  <domain>/               # one folder per business module (orders, invoices, users, …)
    dto/                  # request DTOs (rule 04)
    entities/             # response shapes for Swagger (rule 04)
    <domain>.controller.ts
    <action>.service.ts   # one service per action (rule 06)
    <domain>.module.ts
  common/                 # cross-cutting: guards/, filters/, decorators/, dto/, utils/, interfaces/, entities/, casl/
  config/                 # env.config.ts (rule 03)
  i18n/{en,es}/           # errors.json, messages.json, validation.json (rule 05)
  main.ts                 # bootstrap
  app.module.ts           # composition root: global modules, APP_GUARD, APP_FILTER
libs/                     # internal libraries, each a dynamic module (rule 02)
prisma/schema.prisma      # DB schema
```

```
# Multi-app / monorepo shape
apps/<service>/src/       # same internal shape as above, once per service
libs/                     # shared across apps, each a dynamic module (rule 02)
prisma/schema.prisma
```

Whichever shape is in use, the Prisma client is generated wherever the repo's `schema.prisma` `generator` block points it (commonly `generated/prisma/` or `node_modules/.prisma/client`) — never edit generated output, never relocate it as part of an unrelated change.

## Path aliases

Projects typically expose TypeScript path aliases (`@app/*`, `@config/*`, `@common/*`, `@shared/*`) in `tsconfig.json`. Always import through the alias that already exists in the repo rather than long relative paths that cross module boundaries; within the same module, relative imports (`./dto/create-order.dto`, `../billing/billing.module`) are correct. Don't invent a new alias scheme — match what's already there.

## Rules

1. **One folder per business domain.** New feature ⇒ new folder with its own `*.module.ts`, controller, per-action services, `dto/`, `entities/`.
2. **Shared/cross-cutting code lives in a `common/` (or `shared/`) folder**, grouped by kind (`guards/`, `filters/`, `decorators/`, `casl/`, `utils/`, `dto/`, `entities/`, `interfaces/`). Import it via its alias, don't copy helpers between domains.
3. **Never edit generated Prisma output.** It is regenerated from `schema.prisma`; treat it as read-only build output.
4. **Feature modules import only what they need.** App-wide concerns (i18n, throttler, event emitter, scheduling, global filter/guard) are composed once in the app's root module, not re-declared per feature.
5. **Don't introduce a second runtime-entry shape (e.g. a Lambda handler alongside `main.ts`) to solve a deployment problem.** If the project needs to run in a new environment, that's an infra-layer change — it should not require touching how feature modules are structured.

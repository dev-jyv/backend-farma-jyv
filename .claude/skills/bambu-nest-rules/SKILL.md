---
name: bambu-nest-rules
description: Infrastructure-agnostic conventions for a Bambu NestJS + Prisma backend. Load when writing, reviewing, or refactoring any code in such a repo — covers project layout and shared-code boundaries, dynamic-module libs, typed envs via a Zod config module, DTOs with i18n validation + Swagger, single-config i18n setup, the one-service-per-action pattern, service-layer error handling with i18n, PrismaService usage, thin controllers, resource+action authorization via an ability matrix (CASL), the global Prisma exception filter, and event-driven side effects. Says nothing about how or where the app is deployed — pair with an infra-specific skill (e.g. `bambu-terraform-aws`) for that.
---

# Bambu NestJS Backend — Project Rules

This skill captures **non-negotiable application-layer conventions** for a Bambu NestJS + Prisma backend. These rules override generic NestJS advice whenever they conflict. Always consult the matching rule file in `rules/` before writing code in that area.

## Scope: infrastructure-agnostic by design

Every rule here governs application code — module structure, DTOs, services, controllers, error handling, authorization, Prisma access. None of them assume a specific deployment target (container, serverless function, VM, Kubernetes…), a specific cloud, or a specific secrets-management product. Where a deployment detail would otherwise leak in (e.g. "where do secret values come from"), the rule says explicitly that it's out of scope and defers to the repo's own infra docs or a dedicated infra skill. If you find yourself about to write a rule that only makes sense for one hosting model, it belongs in that project's own skill, not here.

## When to load this skill

Load whenever you are:

- Adding or editing a feature module (whether under `src/<domain>/` or `apps/<service>/<domain>/`)
- Adding or editing a shared library under `libs/<lib>/`
- Writing a DTO, entity, service, controller, guard, or module in this repo
- Adding an environment variable
- Adding an authorization rule or protecting an endpoint
- Wiring a side effect (email, SMS, PDF, webhook…) off a domain event
- Reviewing a PR against a Bambu NestJS repo

Load it together with `bambu-nest-test` when touching tests, and with `prisma-client-api` when writing queries.

## Rule index

| # | Rule | File |
|---|------|------|
| 1 | Project layout, shared-code boundaries, generated Prisma output | `rules/01-project-structure.md` |
| 2 | Libs are dynamic modules (`forRoot`/`forRootAsync` + options token) | `rules/02-libs-dynamic-modules.md` |
| 3 | All env vars declared + validated in one Zod-backed config module | `rules/03-env-config.md` |
| 4 | DTOs carry both i18n validation keys **and** Swagger decorators | `rules/04-dtos-validation-swagger.md` |
| 5 | One `I18nModule.forRoot` per app; resolver + fallback language match repo convention | `rules/05-i18n-setup.md` |
| 6 | One service class **per action**; thin, single-concern, DI-only | `rules/06-service-per-action.md` |
| 7 | Services throw Nest exceptions with `i18n.t('errors.*', { lang })` | `rules/07-service-error-handling.md` |
| 8 | Use `PrismaService` from the internal Prisma lib — never a raw `PrismaClient` | `rules/08-prisma-usage.md` |
| 9 | Controllers are thin: route → auth decorator → Swagger → service call | `rules/09-thin-controllers.md` |
| 10 | Authorization is resource+action via `ABILITY_MATRIX` + `@RequireAbility` | `rules/10-authorization-ability-matrix.md` |
| 11 | Known Prisma errors are translated by a global `PrismaClientExceptionFilter` | `rules/11-exception-filters.md` |
| 12 | Post-commit side effects run off domain events, isolated per channel | `rules/12-event-driven-side-effects.md` |

## Quick reference — the twelve-line rulebook

```
1.  New code?          <domain>/ folder (app-local or shared lib). Import via the repo's existing aliases.
2.  New lib?           forRoot + forRootAsync + X_MODULE_OPTIONS token; index.ts re-exports; no process.env inside.
3.  New env var?       Add a Zod field to the config module, add to the destructured export, import the typed value.
4.  New input?         DTO with class-validator (message: 'validation.*') AND @ApiProperty on every field.
5.  New app-wide cfg?  i18n lives once per app (fallback + header match repo convention, see rule 5).
6.  New action?        One service class per action (XCreateService, XListService…), single concern, constructor DI.
7.  Service error?     const lang = I18nContext.current()?.lang; throw new <Http>(this.i18n.t('errors.*', { lang })).
8.  DB access?         inject PrismaService; use generated enums/types; $transaction for multi-step writes.
9.  Controller method? one line: return this.<action>.<method>(dto, user); + auth decorator + @Api* docs.
10. Protect endpoint?  @RequireAbility('action','Subject') (+ add the rule to ABILITY_MATRIX). Never hand-roll guards.
11. Prisma error?      let the global PrismaClientExceptionFilter map it (P2002→409, P2025→404, P2003→409).
12. Side effect?       emit after the tx commits; @OnEvent listener does the work, each channel isolated in try/catch.
```

## How to apply

- Open the relevant `rules/*.md` and follow the shown pattern verbatim, adapting only names/paths to match what already exists in the repo you're in.
- When a convention conflicts with a linter warning or a generic pattern, the convention wins — adjust the code, not the rule.
- When you find code that violates a rule, fix it in the same edit rather than copying the violation.
- Never let a deployment concern (how the app is hosted or configured at the infra layer) change how you apply these rules. If a task seems to require that, it belongs in a separate, infra-specific skill.

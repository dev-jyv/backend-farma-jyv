---
name: bambu-nest-test
description: Unit testing patterns for the Bambu NestJS monorepo. Load when writing or reviewing tests for DTOs, services, controllers, or modules. Covers plainToInstance + validate for DTOs, Test.createTestingModule with mocked PrismaService and I18nService for services, thin-controller assertions with toBe, and module DI wiring verification.
---

# Bambu Backend — Unit Testing Patterns

This skill captures the **canonical test patterns** established in this monorepo. These override generic Jest/NestJS advice whenever they conflict.

## When to load this skill

- Writing unit tests for a DTO, service, controller, or module under `apps/<service>/src/`
- Writing unit tests for a shared DTO or type under `libs/<lib>/src/`
- Reviewing existing tests for correctness, coverage gaps, or pattern violations
- Adding a new microservice and scaffolding its test suite from scratch

Always load together with `bambu-nest-rules` — the tests must mirror the implementation conventions.

## Rule index

| # | Rule | File |
|---|------|------|
| 1 | DTO tests use `plainToInstance` + `validate` and assert i18n keys | `rules/01-dto-testing.md` |
| 2 | Service tests mock `PrismaService` and `I18nService` via `Test.createTestingModule` | `rules/02-service-testing.md` |
| 3 | Controller tests mock the service, assert delegation and reference equality | `rules/03-controller-testing.md` |
| 4 | Module tests verify DI wiring by overriding `PrismaService` | `rules/04-module-testing.md` |

## Quick reference

```
1. DTO?         plainToInstance(Dto, plain) → validate() → assert constraints keys.
2. Service?     Test.createTestingModule + useValue mocks for PrismaService and I18nService.
3. Controller?  useValue mock for the service. Use toBe (reference) not toEqual.
4. Module?      Import the real module, overrideProvider(PrismaService).useValue(mock).
5. Always?      jest.clearAllMocks() in beforeEach. One describe per method.
6. Exceptions?  Assert the class (NotFoundException) AND the i18n key used (mockI18n.t).
7. No DB?       Never hit a real database in unit tests. Always mock PrismaService.
```

## Jest config requirements

`package.json` must have these entries for tests to resolve correctly:

```json
"jest": {
  "setupFiles": ["reflect-metadata"],
  "moduleNameMapper": {
    "^@app/prisma(|/.*)$": "<rootDir>/libs/prisma/src/$1",
    "^@app/shared(|/.*)$": "<rootDir>/libs/shared/src/$1",
    "^generated/prisma/client$": "<rootDir>/generated/prisma/client.ts"
  }
}
```

`tsconfig.json` must include `"types": ["jest", "node"]` so spec files resolve Jest globals in the editor.

## Running tests

```bash
# One file pattern
pnpm jest --testPathPattern="apps/staff/src/dto"

# Specific spec file
pnpm jest --testPathPattern="staff.service.spec"

# All tests
pnpm jest
```

# 04 — Module testing: DI wiring verification

Module tests verify that the NestJS dependency injection graph compiles correctly and that every provider is resolvable. The real module is imported and `PrismaService` is overridden to prevent database connection attempts.

## Canonical pattern

```ts
// apps/<service>/src/staff.module.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@app/prisma';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { StaffModule } from './staff.module';

const mockPrismaService = {
  staff: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('StaffModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [StaffModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('compiles the module without errors', () => {
    expect(module).toBeDefined();
  });

  it('resolves StaffController', () => {
    expect(module.get(StaffController)).toBeInstanceOf(StaffController);
  });

  it('resolves StaffService', () => {
    expect(module.get(StaffService)).toBeInstanceOf(StaffService);
  });
});
```

## What to verify

| Test | Why |
|---|---|
| Module compiles | Catches missing tokens, circular deps, bad imports |
| Controller is resolvable | Verifies it's registered in `controllers:` |
| Service is resolvable | Verifies it's registered in `providers:` |

## Why `beforeAll` not `beforeEach`

Module compilation is expensive. Use `beforeAll` + `afterAll` — compile once, close once. Individual method tests belong in the service/controller spec files.

## I18nModule and i18n files

`I18nModule.forRoot` loads translation files from `__dirname/i18n/`. With ts-jest, `__dirname` resolves to the **source** directory, so the i18n files created at `apps/<service>/src/i18n/` are found automatically. No override needed for `I18nService` in module tests.

## Rules

1. Use `beforeAll` / `afterAll` — compile once per suite, not once per test.
2. Always call `module.close()` in `afterAll` to release connections and event listeners.
3. Override `PrismaService` with a mock — never let it connect to a real database.
4. Import the **real** module (`StaffModule`) — do not recreate its providers manually; that defeats the purpose of the test.
5. Do not duplicate service/controller behavior tests here — assert only DI resolution.

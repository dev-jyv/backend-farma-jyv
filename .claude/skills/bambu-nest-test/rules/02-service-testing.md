# 02 — Service testing with Test.createTestingModule

Services are tested with `Test.createTestingModule`, mocking `PrismaService` and `I18nService` with plain objects of `jest.fn()`. Never hit a real database in unit tests.

## Canonical setup

```ts
// apps/<service>/src/staff.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '@app/prisma';
import { StaffService } from './staff.service';

const mockPrisma = {
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

const mockI18n = {
  t: jest.fn().mockReturnValue('i18n-message'),
};

describe('StaffService', () => {
  let service: StaffService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: I18nService, useValue: mockI18n },
      ],
    }).compile();

    service = module.get<StaffService>(StaffService);
    jest.clearAllMocks();
  });
});
```

## Per-method coverage

### Happy path
- Call the method with valid input
- Assert the return value is what Prisma returned (`toBe` for reference equality)
- Assert the correct Prisma method was called with `expect.objectContaining({...})`

### Not found
```ts
it('throws NotFoundException when record does not exist', async () => {
  mockPrisma.staff.findUnique.mockResolvedValue(null);
  await expect(service.findOne('id')).rejects.toThrow(NotFoundException);
});
```

### i18n key verification
```ts
it('uses i18n to build the not-found message', async () => {
  mockPrisma.staff.findUnique.mockResolvedValue(null);
  await expect(service.findOne('id')).rejects.toThrow();
  expect(mockI18n.t).toHaveBeenCalledWith(
    'errors.STAFF.NOT_FOUND',
    expect.anything(),
  );
});
```

### Conflict
```ts
it('throws ConflictException when email belongs to another record', async () => {
  mockPrisma.staff.findUnique
    .mockResolvedValueOnce({ id: 'current-id', email: 'old@example.com' })
    .mockResolvedValueOnce({ id: 'other-id' });
  await expect(service.update('current-id', { email: 'taken@example.com' }))
    .rejects.toThrow(ConflictException);
  expect(mockPrisma.staff.update).not.toHaveBeenCalled();
});
```

### Guard rails (side-effect free)
Assert that the "write" method (create/update/delete) was **not** called when an earlier guard throws.

### $transaction + findMany
`$transaction` receives already-called promise results, not the calls themselves. Inspect `mockPrisma.staff.findMany.mock.calls` directly:

```ts
// ✅ correct
expect(mockPrisma.staff.findMany).toHaveBeenCalledWith(
  expect.objectContaining({ where: { role: StaffRole.PM } }),
);

// ❌ wrong — $transaction receives undefined results, not call args
const [findManyCall] = mockPrisma.$transaction.mock.calls[0][0];
```

## Rules

1. `jest.clearAllMocks()` in `beforeEach` — each test starts clean.
2. One `describe` block per method.
3. Assert both the exception class **and** the i18n key for every thrown exception.
4. Assert that write methods are **not** called when a guard throws.
5. Use `toBe` (reference equality) when asserting the return value — the controller must not transform it.
6. Never mock `I18nContext` — the service calls `I18nContext.current()?.lang` internally; mocking `I18nService.t` is sufficient.

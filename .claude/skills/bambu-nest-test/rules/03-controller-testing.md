# 03 — Controller testing with a mocked service

Controllers in this monorepo are a thin delegation layer. Unit tests verify that each method calls the correct service method with the correct arguments and returns the result unchanged. Pipes (`ParseUUIDPipe`, `ValidationPipe`) are not tested here — they belong in e2e tests.

## Canonical setup

```ts
// apps/<service>/src/staff.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

const mockStaffService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

describe('StaffController', () => {
  let controller: StaffController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StaffController],
      providers: [{ provide: StaffService, useValue: mockStaffService }],
    }).compile();

    controller = module.get<StaffController>(StaffController);
    jest.clearAllMocks();
  });
});
```

## Per-method pattern

```ts
it('delegates to staffService.create and returns its result', async () => {
  const dto: CreateStaffDto = { firstName: 'Juan', ... };
  const result = { id: 'uuid', ...dto };
  mockStaffService.create.mockResolvedValue(result);

  expect(await controller.create(dto)).toBe(result);          // reference equality
  expect(mockStaffService.create).toHaveBeenCalledWith(dto);  // correct args
  expect(mockStaffService.create).toHaveBeenCalledTimes(1);   // called once
});
```

## Key assertions

| What | How |
|---|---|
| Return value propagates unchanged | `toBe(result)` — reference equality, not `toEqual` |
| Correct service method called | `toHaveBeenCalledWith(...)` |
| Called exactly once | `toHaveBeenCalledTimes(1)` |
| Filters forwarded in query | `expect.objectContaining({ role, search })` |

## Shared fixture

Define a `xxxFixture` object at the top of the file and reuse it across tests:

```ts
const staffFixture = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  firstName: 'Juan',
  ...
};
```

## Rules

1. Use `toBe` not `toEqual` for return value assertions — proves the controller does not clone or transform the result.
2. `jest.clearAllMocks()` in `beforeEach` — call counts must not bleed across tests.
3. Do not test `ParseUUIDPipe` or `ValidationPipe` here — those fire at the HTTP layer.
4. Do not import or instantiate real services — only `useValue` mocks.
5. One `describe` block per controller method.

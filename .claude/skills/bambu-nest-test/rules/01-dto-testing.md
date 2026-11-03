# 01 — DTO testing with plainToInstance + validate

Every DTO test uses `plainToInstance` from `class-transformer` to build the instance and `validate` from `class-validator` to run the decorators. Never instantiate the DTO with `new` directly — `@Type` and default values only apply through `plainToInstance`.

## Canonical pattern

```ts
// apps/<service>/src/dto/create-xxx.dto.spec.ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { StaffRole } from 'generated/prisma/client';
import { CreateStaffDto } from './create-staff.dto';

async function validateDto(plain: object) {
  return validate(plainToInstance(CreateStaffDto, plain));
}

describe('CreateStaffDto', () => {
  it('passes with a fully valid payload', async () => {
    const errors = await validateDto({
      firstName: 'Mario',
      lastName: 'Akel',
      email: 'rams@example.com',
      role: StaffRole.PM,
    });
    expect(errors).toHaveLength(0);
  });

  describe('email', () => {
    it('fails when not a valid email', async () => {
      const errors = await validateDto({ email: 'not-an-email' });
      const field = errors.find((e) => e.property === 'email');
      expect(field?.constraints).toMatchObject({
        isEmail: 'validation.GENERAL.IS_EMAIL',
      });
    });
  });
});
```

## What to test per field

For each **required** field, write at least:
- Missing field → error exists on that property
- Wrong type (e.g. number instead of string) → `isString: 'validation.GENERAL.IS_STRING'`
- Empty string on `@IsNotEmpty` → `isNotEmpty: 'validation.GENERAL.NOT_EMPTY'`

For **optional** fields (`@IsOptional`):
- Omitted → no error
- Present but wrong type → correct constraint key

For `@IsEnum` fields:
- Valid value → no error
- Each `Object.values(TheEnum)` passes in a loop
- Invalid string → `isEnum: 'validation.GENERAL.IS_ENUM'`

## Pagination DTOs

DTOs that extend `PaginationDto` also test `@Type(() => Number)` coercion and the helper methods:

```ts
it('converts string page to number via @Type', () => {
  const dto = plainToInstance(FindXxxQueryDto, { page: '3' });
  expect(dto.page).toBe(3);
});

it('calculates skip correctly', () => {
  const dto = plainToInstance(FindXxxQueryDto, { page: 2, limit: 10 });
  expect(dto.buildPagination()).toEqual({ skip: 10, take: 10 });
});

it('computes lastPage in buildMeta', () => {
  const dto = plainToInstance(FindXxxQueryDto, { page: 1, limit: 10 });
  expect(dto.buildMeta(55)).toMatchObject({ total: 55, lastPage: 6 });
});
```

## Rules

1. Always use `plainToInstance` — never `new Dto()` — so `@Type` and default values apply.
2. Never pass `{ transform: true }` to `validate()` — transformation belongs to `plainToInstance`.
3. Assert the exact i18n constraint key, not just that `errors.length > 0`.
4. One `describe` block per field.
5. File lives at `apps/<service>/src/dto/<name>.dto.spec.ts` (same directory as the DTO).

## Anti-patterns

```ts
// ❌ new bypasses @Type and defaults
const dto = new CreateStaffDto();

// ❌ only checking length, not the key
expect(errors.length).toBeGreaterThan(0);

// ❌ passing transform to validate — wrong API
validate(dto, { transform: true });
```

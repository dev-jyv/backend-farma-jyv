# 04 — DTOs: i18n validation + Swagger, together

Every inbound payload — `@Body()`, `@Query()`, `@Param()` (when compound) — is validated through a DTO class. A DTO carries **two** things on every field:

1. `class-validator` decorators, each with a `message:` pointing to a `validation.*` i18n key.
2. A Swagger decorator: `@ApiProperty(...)` (required) or `@ApiPropertyOptional(...)` (optional).

If the project exposes Swagger docs (most do), the Swagger layer is not optional — every DTO field must appear in the generated OpenAPI doc.

## Why

- The global `I18nValidationPipe` + `I18nValidationExceptionFilter` translate the `validation.*` keys at runtime from the request's language (rule 05).
- A missing `message:` leaks the raw class-validator default (English) into the response.
- A missing `@ApiProperty` leaves a hole in the generated OpenAPI doc.

## Canonical DTO

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength,
} from 'class-validator';

export class CreateResourceDto {
  @ApiProperty({ example: 'Monthly subscription', maxLength: 120 })
  @IsString({ message: 'validation.GENERAL.IS_STRING' })
  @IsNotEmpty({ message: 'validation.GENERAL.NOT_EMPTY' })
  @MaxLength(120, { message: 'validation.GENERAL.MAX_LENGTH' })
  name!: string;

  @ApiProperty({ example: 'monthly-subscription', description: 'Immutable slug' })
  @IsString({ message: 'validation.GENERAL.IS_STRING' })
  @IsNotEmpty({ message: 'validation.GENERAL.NOT_EMPTY' })
  @Matches(/^[a-z0-9-]+$/, { message: 'validation.RESOURCE.CODE_FORMAT' })
  code!: string;

  @ApiPropertyOptional({ example: 'Paused for maintenance' })
  @IsOptional()
  @IsString({ message: 'validation.GENERAL.IS_STRING' })
  @MaxLength(255, { message: 'validation.GENERAL.MAX_LENGTH' })
  disabledReason?: string;
}
```

- Required fields use definite assignment `!:`. Optional fields use `?:` **and** `@IsOptional()`.
- Order decorators as: `@Api*` first, then validators.

## Update DTOs

Use `PartialType` from `@nestjs/swagger` (it preserves the Swagger metadata), e.g. `export class UpdateResourceDto extends PartialType(CreateResourceDto) {}` — mirror the nearest existing `update-*.dto.ts`.

## Pagination DTO

List endpoints take (or extend) a shared `PaginationDto`:

```ts
import { PaginationDto } from '@common/dto/pagination.dto';

// use directly:
listResources(@Query() dto: PaginationDto) { ... }

// or extend to add filters:
export class FindResourcesDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4', { message: 'validation.GENERAL.IS_UUID' })
  ownerId?: string;
}
```

A shared `PaginationDto` should already provide `page`, `limit` (both via `@Type(() => Number)`), `buildPagination()` → `{ skip, take }`, and `buildMeta(total)`. Do not reinvent these per domain.

## Response entities

Response shapes live in `<domain>/entities/*.entity.ts` as classes with `@ApiProperty` on each field. Services return objects matching the entity; controllers reference it in `@ApiOkResponse({ type: XEntity })`.

## i18n validation keys

Keep a `GENERAL` bucket of reusable keys (`NOT_EMPTY`, `IS_STRING`, `IS_EMAIL`, `IS_UUID`, `IS_DEFINED`, `IS_ARRAY`, `ARRAY_MIN_SIZE`, `MIN_LENGTH`, `MAX_LENGTH`, `IS_ENUM`, `IS_BOOLEAN`, `IS_DATE`, `IS_INT`, `IS_NUMBER`, `IS_POSITIVE`, `MIN`, `MAX`) plus domain-specific buckets. If a key doesn't exist, add it to **every** supported language file under the matching bucket.

## Rules

1. Every inbound parameter goes through a DTO. **Never** `@Body('field')` / `@Query('field')` string extraction — it bypasses the pipe.
2. Every validator carries a `message:` in the `validation.*` namespace.
3. Every field carries `@ApiProperty` / `@ApiPropertyOptional`.
4. Re-export enums from the Prisma-generated client; validate them with `@IsEnum(TheEnum, { message: 'validation.GENERAL.IS_ENUM' })`. Do not duplicate enum unions by hand.
5. One DTO per file under `<domain>/dto/`.
6. For a single UUID path param, prefer `@Param('id', ParseUUIDPipe) id: string` in the controller (rule 09) over a bare untyped string.

## Reference

- `src/common/dto/pagination.dto.ts` (or your repo's equivalent)

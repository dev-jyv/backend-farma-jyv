# 07 — Services validate and throw with i18n

Business rules are enforced in services (rule 06). When a service refuses to proceed it throws a NestJS HTTP exception whose message is resolved through `I18nService.t(...)` against a key under `errors.*`, in the caller's language.

## Required pattern

```ts
import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { PrismaService } from '@app/prisma';

@Injectable()
export class ResourceCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
  ) {}

  async create(dto: CreateResourceDto) {
    const lang = I18nContext.current()?.lang;   // resolve ONCE at the top

    const existing = await this.prisma.resource.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw new ConflictException(
        this.i18n.t('errors.RESOURCE.CODE_ALREADY_IN_USE', { lang }),
      );
    }

    const owner = await this.prisma.owner.findUnique({ where: { id: dto.ownerId } });
    if (!owner) {
      throw new NotFoundException(this.i18n.t('errors.OWNER.NOT_FOUND', { lang }));
    }
    // ...
  }
}
```

Resolve `const lang = I18nContext.current()?.lang;` once at the start of the method and reuse it — don't inline `I18nContext.current()?.lang` at every throw site.

## Rules

1. **Inject `I18nService`** in every service that can fail. Grab `lang` from `I18nContext.current()?.lang`.
2. **Always pass `{ lang }`** as the second arg to `this.i18n.t(...)`. Without it the translation ignores the caller's language header and falls back to the default.
3. **Pick the correct HTTP exception:**
   - `BadRequestException` — semantically invalid input the DTO can't express (e.g. a date range where the end precedes the start).
   - `NotFoundException` — resource missing or hidden from the caller (prefer over `ForbiddenException` when leaking existence helps an attacker).
   - `ConflictException` — the requested state already holds / uniqueness clash you check explicitly.
   - `UnauthorizedException` — authentication failed.
   - `ForbiddenException` — authenticated but not permitted; usually already handled by the authorization layer (rule 10), so rarely thrown by hand.
4. **Reuse `errors.GENERAL.*`** for cross-domain messages (`NOT_FOUND`, `CONFLICT`, `INTERNAL`, `RELATED_RECORD`); domain-specific keys go under their own bucket (`errors.RESOURCE.*`, `errors.AUTH.*`).
5. **Success/info messages** use the `messages.*` namespace, returned as `{ message: this.i18n.t('messages.*', { lang }) }`.
6. **Never `throw new Error(...)`** for an expected business failure — a raw `Error` escapes the i18n filters and renders as a 500.
7. **Let the Prisma filter handle DB constraint errors** (rule 11). Only pre-check with an explicit `findUnique` + `ConflictException` when you want a *specific* domain message; otherwise a unique-constraint violation is already mapped centrally.
8. **Don't translate in the lib layer.** Libraries surface typed errors; the consuming service translates.

## Confirm the key exists

Before using a new `errors.*` key, confirm it is present in **every** supported language's `errors.json`. Add it to all of them under the matching bucket if missing.

## Anti-patterns

```ts
throw new NotFoundException('Resource not found');                 // ❌ hard-coded, untranslatable
throw new NotFoundException(this.i18n.t('errors.OWNER.NOT_FOUND')); // ❌ missing { lang }
if (!row) throw new Error('not found');                             // ❌ raw Error → 500
```

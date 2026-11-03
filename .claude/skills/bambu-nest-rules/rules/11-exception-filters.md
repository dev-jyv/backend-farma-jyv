# 11 — Global exception filters translate known errors

Errors are formatted centrally, not with scattered `try/catch`. Two global concerns are registered once:

- `I18nValidationExceptionFilter` — DTO validation failures (rule 05, in the bootstrap file).
- A `PrismaClientExceptionFilter` — known Prisma DB errors (registered via `APP_FILTER` in the root module).

## The Prisma filter

`@Catch(Prisma.PrismaClientKnownRequestError)` maps Prisma error codes to a coherent, i18n'd HTTP response so services don't repeat `error.code === 'P2002'` checks:

```ts
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly i18n: I18nService,
  ) {}

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const lang = I18nContext.current()?.lang;
    const mapped = this.map(exception.code);       // P2002/P2025/P2003 → {status, key, error}
    if (mapped.status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Unmapped Prisma error ${exception.code}: ${exception.message}`);
    }
    const message = this.i18n.t(mapped.messageKey, { lang });
    httpAdapter.reply(ctx.getResponse(), { statusCode: mapped.status, message, error: mapped.error }, mapped.status);
  }
}
```

Baseline mapping:

| Prisma code | Meaning | HTTP | i18n key |
|-------------|---------|------|----------|
| `P2002` | unique constraint violation | 409 | `errors.GENERAL.CONFLICT` |
| `P2025` | required record not found (update/delete) | 404 | `errors.GENERAL.NOT_FOUND` |
| `P2003` | foreign-key violation | 409 | `errors.GENERAL.RELATED_RECORD` |
| _default_ | anything else | 500 | `errors.GENERAL.INTERNAL` (logged) |

When a DB-level unique or FK constraint is the real integrity guarantee for a feature (rule 08), the `P2002`/`P2003` mapping is load-bearing — don't bypass it with best-effort app-level checks only.

## Registration (DI-backed, in the root module)

```ts
providers: [
  { provide: APP_FILTER, useClass: PrismaClientExceptionFilter },
],
```

Register via `APP_FILTER` (not `app.useGlobalFilters(new …())`) so the filter participates in DI and receives `I18nService` + `HttpAdapterHost`.

## Rules

1. **Let the global filter map Prisma errors.** Don't scatter `if (e.code === 'P2002')` in services — either rely on the filter, or (only for a specific domain message) pre-check with `findUnique` + a domain `ConflictException` (rule 07).
2. **Extend the `map(code)` switch** when you need to translate a new Prisma code — add a `case` and an `errors.GENERAL.*` (or domain) key in every supported language. Always keep the `default` → 500 branch so unmapped codes degrade gracefully and get logged once.
3. **Resolve messages via `this.i18n.t(key, { lang: I18nContext.current()?.lang })`.** Never inline a hard-coded string in the response body.
4. **Response shape is `{ statusCode, message, error }`.** Keep it consistent if you add another filter.
5. **Register global filters via `APP_FILTER`.** If you introduce a filter for another typed error source (e.g. a third-party SDK), give it its own `@Catch(SpecificError)` + a constants map + `APP_FILTER` entry — never `@Catch()` bare (it would swallow the validation filter too).
6. **Log once** at `logger.error(...)`; never `console.log`, and never log request bodies or secrets.

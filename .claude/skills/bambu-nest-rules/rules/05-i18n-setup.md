# 05 — i18n is configured once, in the root module

i18n is registered **once**, in the app's root module (`AppModule`, or each `apps/<service>/src/<service>.module.ts` in a multi-app layout), and the validation pipe + filter are registered once wherever that app bootstraps. There is no per-feature-module duplication.

## Module setup

```ts
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import * as path from 'path';

I18nModule.forRoot({
  fallbackLanguage: 'es',
  loaderOptions: {
    path: path.join(__dirname, '/i18n/'),
    watch: true,
  },
  resolvers: [new HeaderResolver(['x-custom-lang'])],
}),
```

`fallbackLanguage: 'es'` and the `x-custom-lang` header are Bambu's default convention for client-facing apps (most serve Spanish-speaking end users first). Treat them as the default, not a hard constant: if the repo you're in already defines a different fallback language or header name, match what's already there instead of "fixing" it — and if you're the one setting it up for a new project, use these defaults unless the product has stated otherwise. Whichever header is chosen, whitelist it in CORS `allowedHeaders` wherever CORS is configured.

`path` is `__dirname + '/i18n/'` so the compiled JSON sits next to the compiled output.

## Translation files

```
<app-root>/i18n/
├── en/  { errors.json, messages.json, validation.json }
└── es/  { errors.json, messages.json, validation.json }
```

Three buckets, always, in every supported language:

- `errors.json` — service exceptions (rule 07) and the Prisma filter (rule 11)
- `validation.json` — DTO validators (rule 04)
- `messages.json` — success/info messages returned by services

Every supported language directory must expose the **same keys**. A key present in only one language silently falls back to the configured `fallbackLanguage` at runtime.

## Bootstrap wiring

```ts
import { I18nValidationExceptionFilter, I18nValidationPipe } from 'nestjs-i18n';

app.useGlobalPipes(
  new I18nValidationPipe({
    whitelist: true,
    forbidUnknownValues: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
app.useGlobalFilters(
  new I18nValidationExceptionFilter({ detailedErrors: false }),
);
```

The four pipe options (`whitelist`, `forbidUnknownValues`, `forbidNonWhitelisted`, `transform`, all `true`) are **not negotiable** — `whitelist` + `transform` are what make the DTO the enforced contract, and `transform` is what makes `@Type(() => Number)` and `ParseUUIDPipe` behave. If the app has more than one bootstrap entry point for the same codebase (e.g. an HTTP entry and a worker/consumer entry), keep this configuration identical across every entry point that can throw a validation error.

## Rules

1. **Configure i18n once**, in the root module. Feature modules never call `I18nModule.forRoot(...)` again.
2. **Match the project's existing resolver and fallback language** rather than introducing a second one.
3. **Keep the pipe/filter configuration identical across every bootstrap entry point** that exists in the app.
4. **Every new error/message/validation key is added to every supported language file** under the matching bucket.

## Reference

- The app's root module — `I18nModule.forRoot(...)`
- The app's bootstrap file(s) — pipe + filter + CORS allowed headers

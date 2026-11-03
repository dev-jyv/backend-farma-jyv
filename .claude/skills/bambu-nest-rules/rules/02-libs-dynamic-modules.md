# 02 — Libs are dynamic modules

Every library under `libs/<name>/` that wraps an external client or carries any configuration (mail, SMS, file storage, PDF rendering, a payment provider, a database driver…) MUST be configurable via `forRoot(options)` and `forRootAsync(options)`, backed by an injected options token. Never read `process.env` or the app's env-config module inside a lib — the **app** passes config in.

## Why

- The lib stays decoupled from the app's env schema and from how/where that env is populated (`.env` file, injected by the orchestrator, pulled from a secrets manager at boot) — config flows in at composition time from the app's root or feature module.
- `forRootAsync` lets the factory pull values from the app's validated env config without the lib depending on it directly.
- Tests can construct the module with fixture options, no real credentials or network calls required.

## Required shape

```
libs/<name>/src/
  constants/<name>.constants.ts                  // export const X_MODULE_OPTIONS = 'X_MODULE_OPTIONS';
  interfaces/<name>-module-options.interface.ts  // sync + async option shapes
  interfaces/index.ts                            // barrel
  <name>.module.ts                               // forRoot + forRootAsync
  <name>.service.ts                              // @Inject(X_MODULE_OPTIONS)
  index.ts                                       // re-export module + service + interfaces
```

### Module (canonical pattern)

```ts
@Module({})
export class MailerModule {
  static forRoot(options: MailerModuleOptions): DynamicModule {
    return {
      global: true, // set global only when the service is used app-wide
      module: MailerModule,
      providers: [
        { provide: MAILER_MODULE_OPTIONS, useValue: options },
        MailerService,
      ],
      exports: [MailerService],
    };
  }

  static forRootAsync(options: MailerModuleAsyncOptions): DynamicModule {
    return {
      global: true,
      module: MailerModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: MAILER_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        MailerService,
      ],
      exports: [MailerService],
    };
  }
}
```

### Service injects the options token

```ts
@Injectable()
export class MailerService {
  constructor(
    @Inject(MAILER_MODULE_OPTIONS)
    private readonly options: MailerModuleOptions,
  ) {}
}
```

### Wiring from the app (factory reads validated env, rule 03)

```ts
MailerModule.forRootAsync({
  useFactory: () => ({
    host: SMTP_HOST,      // imported from the app's env-config module
    user: SMTP_USER,
    pass: SMTP_PASS,
  }),
}),
```

A lib that is registered **per feature module** instead of once in the app root (e.g. a database-access lib, see rule 08) still follows the same `forRoot`/`forRootAsync` shape — only the place it's imported differs.

## Rules

1. **`forRoot` + `forRootAsync` + `X_MODULE_OPTIONS` token** for any lib with config. A bare `@Module({ providers, exports })` is only acceptable for a service with zero configuration.
2. **`index.ts` re-exports** the module, the service, and the public interfaces (`export * from './...'`).
3. **No `process.env` and no env-config import inside `libs/`.** The app's factory supplies values.
4. **`global: true`** only for libs meant to be available everywhere without re-importing. Otherwise leave it module-local and import where needed.
5. **Options token is a string constant** in `constants/`, injected with `@Inject(...)`.
6. **Libs never import from the app layer** (`src/` or `apps/<service>/`) — no dependency from a library back into application code.

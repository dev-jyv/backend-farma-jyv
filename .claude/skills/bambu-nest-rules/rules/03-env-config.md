# 03 — Environment variables live in one typed config module

Every environment variable is declared, validated, and re-exported by a single config module (conventionally `config/env.config.ts`) using **Zod**. Consumers import the **typed** value, never `process.env`.

This rule is deliberately silent on *where the values come from* — a `.env` file locally, variables injected by whatever orchestrates the deployment, or a secrets manager/vault resolved before the process starts. All of that is an infra-layer concern. By the time `env.config.ts` runs, every value must already be reachable as `process.env.X`; this rule only governs what happens from that point forward.

## Why

- One Zod schema enforces presence + type before the app boots. Invalid env ⇒ `process.exit(1)` with a formatted error, caught at startup instead of at first use.
- Consumers get correctly-typed values (string, number, boolean, enum) without repeated coercion.
- Renames/removals surface as TypeScript errors across the whole app in one pass.

## Adding a variable (three steps)

1. Add a field to `EnvSchema`, always with `.describe(...)`:

   ```ts
   const EnvSchema = z.object({
     // ...
     MY_NEW_FLAG: z.coerce
       .number()
       .int()
       .positive()
       .default(60)
       .describe('Human-readable purpose and units'),
   });
   ```

2. Add it to the destructured `export const { ... } = data;` block at the bottom so it becomes importable.
3. Import the typed value where needed:

   ```ts
   import { MY_NEW_FLAG } from '@config/env.config';
   ```

## Zod idioms

- `z.string().min(1)` — required non-empty string
- `z.string().default('15m')` — required-with-default
- `z.string().optional()` — may be absent
- `z.url()` — URL format
- `z.coerce.number().int().positive()` — numeric env parsed + bounded
- `z.enum(['local', 'develop', 'qa', 'production'])` — closed set (`NODE_ENV`)
- `z.enum(['true', 'false']).transform((v) => v === 'true')` — boolean-from-string flag

## Validation at boot (do not change this shape)

```ts
const { success, error, data } = EnvSchema.safeParse(process.env);

if (!success) {
  logger.error('❌ Invalid environment variables:', error.format());
  process.exit(1);
}

export const { NODE_ENV, DB_HOST, JWT_SECRET, /* … */ } = data;
```

## Rules

1. **Never reference `process.env.X` outside the env-config module.** (The Zod `safeParse(process.env)` call is the single exception.) Use the typed export.
2. **Never coerce at the call site** (`Number(process.env.X)`). Declare `z.coerce.number()` in the schema.
3. **Declare an explicit `.default(...)`** when a fallback is correct; otherwise let the schema fail fast (no silent `?? 'x'`).
4. **Always add `.describe(...)`** — it documents intent and shows up in the boot error report.
5. **Keep DB config as discrete `DB_*` vars** (`DB_ENGINE`/`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USERNAME`/`DB_PASSWORD`) rather than a single assembled connection string; the connection string is built inside the Prisma wrapper service (rule 08).
6. **Wherever a value is actually a secret** (API keys, passwords, tokens), the schema still validates it as a normal typed field — the schema doesn't care whether the value arrived via `.env`, a platform's injected env vars, or a secrets manager resolved upstream of boot. Don't bypass the schema "because it's sensitive."

## Anti-patterns

```ts
// ❌ direct read
const hours = Number(process.env.REFUND_WINDOW_HOURS ?? 2);

// ✅ typed import
import { REFUND_WINDOW_HOURS } from '@config/env.config';
```

## Reference

- `config/env.config.ts` — source of truth

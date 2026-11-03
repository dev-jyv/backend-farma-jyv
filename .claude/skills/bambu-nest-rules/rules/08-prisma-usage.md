# 08 — PrismaService from the internal Prisma lib

Database access goes through a `PrismaService` injected from an internal `@app/prisma` (or `@app/prisma-pg`, etc. — match the repo's existing name) dynamic module, built on the pattern from rule 02. Never import `PrismaClient` directly from generated output in app code, and never `new` a client. Whether that service wraps the stock Prisma client or a driver adapter (e.g. for a specific Postgres driver) is an implementation detail of the lib — app code only ever sees `PrismaService`.

## Module registration

Decide once per project whether Prisma is registered globally in the app's root module, or per feature module — follow whatever the repo already does; don't mix both styles in the same codebase. A per-feature-module registration (useful when connection options can vary, e.g. read replicas) looks like:

```ts
// src/resources/resources.module.ts
import { PrismaModule } from '@app/prisma';
import {
  NODE_ENV, DB_ENGINE, DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD,
} from '@config/env.config';

@Module({
  imports: [
    PrismaModule.forRootAsync({
      useFactory: () => ({
        engine: DB_ENGINE,
        host: DB_HOST,
        port: DB_PORT,
        database: DB_NAME,
        username: DB_USERNAME,
        password: DB_PASSWORD,
        sslmode: NODE_ENV !== 'local', // TLS outside local dev, per your DB provider's requirements
      }),
    }),
    // other imports…
  ],
  controllers: [ResourceController],
  providers: [/* per-action services */],
})
export class ResourcesModule {}
```

Copy this block from the nearest existing module rather than retyping it.

## Service usage

```ts
import { PrismaService } from '@app/prisma';
import { Prisma } from 'generated/prisma/client';   // types
import { Platform } from 'generated/prisma/enums';   // enums

@Injectable()
export class ResourceCreateService {
  constructor(private readonly prisma: PrismaService) {}
}
```

## Rules

1. **Inject `PrismaService`.** Never `new PrismaClient()`, never pull the raw client into app code.
2. **Register the Prisma module exactly the way the repo already does** (globally once, or per feature module) — don't introduce a second pattern.
3. **Enums and types come from the Prisma-generated output** (path varies per repo — check `schema.prisma`'s `generator` block). Never edit generated output.
4. **Multi-step writes use `this.prisma.$transaction`** — the callback form when a later step depends on an earlier read/write, the array form for independent writes.
5. **Lean on DB constraints for correctness, not just app checks.** A uniqueness or integrity guarantee belongs at the DB level (`@@unique([...])`, FK constraints); a violation surfaces as a Prisma error mapped to the right HTTP status by the global filter (rule 11). Don't replace that with best-effort application-level checks only.
6. **Pagination uses the DTO helpers** (rule 04): `const { skip, take } = dto.buildPagination();` then `dto.buildMeta(total)` in the response.
7. **Fan-in list reads** run `Promise.all([findMany, count])` so a paginated list doesn't do sequential round-trips.
8. **Keep transactions short** and never `await` an external HTTP/SMTP/storage call inside a `$transaction` callback — that's what the post-commit event is for (rule 12).

## Transactions

```ts
await this.prisma.$transaction(async (tx) => {
  const resource = await tx.resource.create({ data });
  await tx.resourceDetail.createMany({ data: details });
  return resource;
});
```

## Reference

- `libs/prisma/src/prisma.service.ts` (or your repo's equivalent) — the wrapper + connection assembly

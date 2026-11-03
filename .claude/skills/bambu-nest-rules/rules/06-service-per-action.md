# 06 — One service class per action

The default structural convention for business logic: a business action gets its **own** `@Injectable()` service class — not a fat `XService` with `create/findAll/findOne/update/remove` methods crammed together.

## The pattern

For a resource `Resource`, the module wires one service per action, each with one public method:

```
resource-create.service.ts   → ResourceCreateService.create(dto)
resource-list.service.ts     → ResourceListService.list(dto)
resource-get.service.ts      → ResourceGetService.get(id)
resource-update.service.ts   → ResourceUpdateService.update(id, dto)
resource-delete.service.ts   → ResourceDeleteService.delete(id)
```

The controller injects them under intent-revealing names and delegates one line per route:

```ts
constructor(
  private readonly create: ResourceCreateService,
  private readonly list: ResourceListService,
  private readonly get: ResourceGetService,
  private readonly update: ResourceUpdateService,
  private readonly remove: ResourceDeleteService,
) {}
```

The module lists every one of these services as a provider.

## Why

- Each class has one reason to change and a small, obvious dependency set.
- Actions with heavy collaborators (pricing, inventory resolution, file generation, transactions) don't drag unrelated dependencies into sibling actions.
- Unit tests target one behavior per file (`<action>.service.spec.ts` sits next to it — see `bambu-nest-test`).

## Service shape

```ts
@Injectable()
export class ResourceCreateService {
  constructor(
    private readonly prisma: PrismaService,     // rule 08
    private readonly i18n: I18nService,          // rule 07
    private readonly someHelper: SomeHelperService, // collaborators via DI
  ) {}

  async create(dto: CreateResourceDto) {
    const lang = I18nContext.current()?.lang;
    // 1. validate preconditions → throw i18n exceptions (rule 07)
    // 2. mutate via this.prisma (rule 08)
    // 3. return the response object matching the entity (rule 04)
  }
}
```

## Naming

- File: `<resource>-<action>.service.ts` (kebab). Class: `Resource + Action + Service` (`ResourceUpdateService`).
- Public method: the plain verb (`create`, `list`, `get`, `update`, `delete`). Controllers reference it as `this.<injected>.<verb>(...)`.
- Cross-cutting resolvers/helpers that several actions share are their own services, imported where needed — not copied.

## Dependency injection rules

1. **Constructor injection only**, `private readonly` fields, `@Injectable()` classes. No property injection, no `new SomeService(...)`.
2. **One concern per service.** If a service accumulates more than ~5 collaborators, it's doing too much — split the action or extract a shared resolver.
3. **No `process.env` / no env-config import inside a lib** (rule 02); app services *may* import typed env values, but prefer receiving them as behavior, not reading config ad hoc.
4. **Avoid `forwardRef`.** A circular dependency means the shared piece belongs in a third, smaller service/module.
5. **Default (singleton) scope** everywhere. Do not use request scope unless you have a concrete reason tied to per-request state that can't be threaded through method arguments.
6. **Business rules live in services, never controllers** (rule 09) and never in the repository/lib layer.

## Anti-patterns

```ts
// ❌ Fat service with many actions
@Injectable()
export class ResourceService {
  create() {} list() {} get() {} update() {} delete() {}
}

// ❌ Manual instantiation / service locator
const svc = new ResourceCreateService(...);
constructor(private moduleRef: ModuleRef) {}
```

# 09 — Thin controllers

Controllers are the HTTP adapter, nothing else: route, auth decorator, Swagger docs, param DTOs, and a single delegating call to a per-action service (rule 06). No branching, no translation, no Prisma, no response shaping.

## What belongs in a controller

- `@ApiTags(...)` on the class, `@Controller('<prefix>')`.
- One method per endpoint: `@Get/@Post/@Patch/@Delete`, optional `@HttpCode(HttpStatus.*)`.
- An **auth decorator** (rule 10): `@RequireAbility('action', 'Subject')` or a platform-boundary decorator.
- **Swagger** decorators: `@ApiBearerAuth('access-token')`, `@ApiOperation`, `@ApiOkResponse`/`@ApiCreatedResponse`/`@ApiNoContentResponse` (`{ type: XEntity }`), and the relevant error responses (`@ApiUnauthorizedResponse`, `@ApiNotFoundResponse`, …).
- Param decorators with DTOs (rule 04); `@Param('id', ParseUUIDPipe)` for a single UUID; a decorator like `@GetUser()` for the authenticated user.
- A single `return this.<injectedService>.<verb>(...)`.

## Canonical controller

```ts
@ApiTags('Resources')
@Controller('resources')
export class ResourceController {
  constructor(
    private readonly create: ResourceCreateService,
    private readonly get: ResourceGetService,
    // …
  ) {}

  @Post()
  @RequireAbility('create', 'Resource')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Create a resource' })
  @ApiCreatedResponse({ type: ResourceEntity })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired token' })
  createResource(@Body() dto: CreateResourceDto) {
    return this.create.create(dto);
  }

  @Get(':id')
  @RequireAbility('read', 'Resource')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get a resource by ID' })
  @ApiOkResponse({ type: ResourceEntity })
  @ApiNotFoundResponse({ description: 'Resource not found' })
  getResource(@Param('id', ParseUUIDPipe) id: string) {
    return this.get.get(id);
  }
}
```

## Rules

1. **One line per method body**: `return this.<service>.<verb>(args)`. No `await` + post-processing.
2. **No business logic** — no `if` on request fields, no combining responses, no Prisma calls, no `I18nService`.
3. **Access control is a decorator**, not inline code. Default to `@RequireAbility(action, subject)` (rule 10); use a coarser platform-boundary decorator only for genuine platform-boundary endpoints (e.g. "my profile"). Public endpoints carry no auth decorator — be deliberate about which ones don't.
4. **Every protected method documents `@ApiBearerAuth('access-token')`** and the response types with entity classes.
5. **Use explicit `@HttpCode`** for non-default codes: `CREATED` on create, `NO_CONTENT` on delete.
6. **Return the service result directly.** Don't wrap in `{ data }` — paginated services already return `{ data, meta }` via the pagination helper.
7. **Don't inject `PrismaService` or `I18nService`** into a controller. If you need them, the logic belongs in a service.
8. **Don't `try/catch`** in the controller — the global filters (rules 05, 11) format errors.

# 10 — Authorization: resource+action via an ability matrix

Authorization is **by action on a resource**, not by role name sprinkled through the codebase. This is enforced by CASL, driven by a single declarative table, and consumed on endpoints through one decorator. Do not hand-roll guards or inline role checks.

## The moving parts (conventionally under `common/casl/`)

| File | Role |
|------|------|
| `ability.types.ts` | The `Actions` union and `Subjects` union (one subject per business resource). |
| `ability.definitions.ts` | A role/platform map + `ABILITY_MATRIX` — the declarative grant table. |
| `ability.factory.ts` | `AbilityFactory.createForUser(payload)` projects the matrix for the user's role/platform. |
| `policies.guard.ts` | `PoliciesGuard` builds the ability and runs the `@CheckPolicies` handlers (AND). |
| `decorators/*.decorator.ts` | `@RequireAbility`, plus coarser platform-boundary decorators as needed. |
| `casl.module.ts` | `@Global()` module exporting `AbilityFactory`, `PoliciesGuard`. |

`Actions` are typically: `manage` (CASL wildcard), `access` (coarse platform boundary), CRUD (`create`/`read`/`update`/`delete`), `manage-self` (own account), plus domain-specific actions as the product needs them. `Subjects` is one entry per resource/module.

## How a request is authorized

1. An auth guard authenticates and puts the user's payload (including role/platform) on `request.user`.
2. `AbilityFactory.createForUser(payload)` grants every `ABILITY_MATRIX` rule whose `platforms`/`roles` include the user's own.
3. `PoliciesGuard` runs the endpoint's `@CheckPolicies` handlers; **all** must return true.

## Protecting an endpoint

Default — require a capability (the common case):

```ts
@RequireAbility('create', 'Resource')   // = authenticate + can('create','Resource')
```

`@RequireAbility(action, subject)` bundles the auth guard(s) and checks the single ability. The grant of that capability to a role/platform lives in `ABILITY_MATRIX`, not on the endpoint.

Reserve coarser decorators (e.g. an `@AuthAdminOnly()`-style platform-boundary guard, or a multi-handler `@AuthAbility(...)`) for genuine platform-boundary endpoints ("my profile", "my sessions") that aren't really a resource capability.

## Adding a new module's authorization

1. Add the resource to the `Subjects` union in `ability.types.ts` (add a new domain action to `Actions` only if CRUD + `manage` don't cover it).
2. Add one (or a few) rule(s) to `ABILITY_MATRIX`:
   ```ts
   { action: 'manage', subject: 'Resource', platforms: [ADMIN] },
   { action: ['read', 'update'], subject: 'Order', platforms: [STAFF, CUSTOMER] },
   ```
   `action` accepts one action or an array; `manage` is the wildcard that subsumes CRUD and domain actions.
3. Decorate each endpoint with `@RequireAbility('<action>', '<Subject>')`.

You do **not** touch `AbilityFactory` or the guards to add a module. The matrix is the single place capabilities are granted.

## Rules

1. **Protect endpoints with the decorators**, never with inline `if (user.role !== …)` or a bespoke guard.
2. **Prefer `@RequireAbility(action, subject)`.** Reach for a platform-boundary decorator only for genuine platform-boundary access.
3. **Grants live in `ABILITY_MATRIX`.** Adding/removing who-can-do-what is a matrix edit, not an endpoint edit.
4. **Keep `Subjects` one-per-resource** and reuse `manage` for "full control by this role".
5. **Public endpoints carry no auth decorator.** Be deliberate — an endpoint with no decorator is world-reachable.
6. The CASL module is `@Global()`; do not re-import it in feature modules.

# Detección de package manager y bloque de setup por variante

## Cómo detectar

Orden de precedencia cuando hay señales — el lockfile manda; el `packageManager` de `package.json` (si existe) es la fuente de verdad para la versión exacta:

```bash
test -f pnpm-lock.yaml && echo pnpm
test -f yarn.lock && echo yarn
test -f package-lock.json && echo npm
test -f bun.lock -o -f bun.lockb && echo bun
grep -m1 '"packageManager"' package.json 2>/dev/null
```

**Yarn classic vs. berry** (ambos usan `yarn.lock`, el setup es distinto):

```bash
head -1 yarn.lock   # "# yarn lockfile v1" => classic. Cualquier otra cosa (o ausencia de esa línea) => berry (v2+)
test -f .yarnrc.yml && echo "probablemente berry"
```

Si detectas **más de un lockfile** en la raíz (p. ej. `package-lock.json` y `yarn.lock` juntos), es una señal de repo inconsistente — avísale al usuario en vez de elegir uno en silencio.

**Versión de Node/runtime**, en este orden:

1. `packageManager` en `package.json` (fija la versión del package manager, no la de Node, pero suele venir acompañado de `engines.node`).
2. `.nvmrc` o `.node-version`.
3. `engines.node` en `package.json`.
4. `FROM node:X` en un `Dockerfile` del repo.
5. Un pipeline de CI ya existente (buildspec, otro workflow) que instale Node explícitamente.

Si ninguna de estas está presente, no inventes un número — pregúntale al usuario o usa la LTS activa vigente al momento, dejándolo explícito en el PR.

## Bloques de setup/instalación por variante

Todos reemplazan el mismo tramo del `assets/security.yml.template` (los pasos `Setup Node.js` + `Install dependencies`). El resto del workflow no cambia.

### npm

```yaml
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: <NODE_VERSION>
          cache: npm

      - name: Install dependencies
        run: npm ci
```

### yarn classic (v1)

```yaml
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: <NODE_VERSION>
          cache: yarn

      - name: Install dependencies
        run: yarn install --frozen-lockfile
```

### yarn berry (v2+)

`corepack` resuelve la versión exacta desde el campo `packageManager` de `package.json` — no fijes la versión de yarn a mano en el workflow, para no desincronizarla de lo que corre en local/Docker.

```yaml
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: <NODE_VERSION>

      - name: Enable corepack
        run: corepack enable

      - name: Install dependencies
        run: yarn install --immutable
```

### pnpm

Sin `version:` en `pnpm/action-setup`, la action toma la versión del campo `packageManager` de `package.json` — fijarla ahí (no en el workflow) evita que CI, Docker y las máquinas locales resuelvan versiones de pnpm distintas entre sí.

```yaml
      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: <NODE_VERSION>
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
```

### bun

```yaml
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile
```

## Monorepos

`snyk test --all-projects` ya recorre todos los `package.json` del árbol — no hace falta instalar por paquete. Si el monorepo usa workspaces (npm/yarn/pnpm), un solo `install` en la raíz basta. Si tiene múltiples lockfiles independientes por paquete (monorepo "poliglota", cada carpeta con su propio lockfile y sin workspaces), revisa con el usuario si el escaneo debe correr una vez por paquete o si `--all-projects` cubre el caso — con `--detection-depth=4` normalmente sí lo hace.

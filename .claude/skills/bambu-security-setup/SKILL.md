---
name: bambu-security-setup
description: Monta desde cero (o audita) el escaneo de dependencias con Snyk en CI para cualquier repositorio — backend o frontend, monorepo o paquete único, con npm/yarn classic/yarn berry/pnpm/bun. Genera el workflow de GitHub Actions bloqueante en PRs + schedule semanal, el CODEOWNERS de `.snyk`, configura el secret SNYK_TOKEN y el acceso del team de seguridad al repo. Usa este skill cuando el usuario pida "agregar Snyk", "configurar el escaneo de seguridad", "replicar el workflow de seguridad a otro repo", "montar CI de dependencias", "settear el SNYK_TOKEN", o quiera llevar esta misma configuración de un repo a otro del mismo equipo/org.
---

# Snyk Security CI Setup

Bootstrap portable del pipeline de escaneo de dependencias con Snyk: un workflow de GitHub Actions que bloquea PRs con vulnerabilidades high/critical en dependencias de producción, corre semanalmente por su cuenta, y una gobernanza mínima (`CODEOWNERS`) para que ignorar un hallazgo sea una decisión revisada, no un atajo.

No asume un stack específico. Antes de escribir nada, este skill **detecta** el package manager, el runtime, si es monorepo, y qué branches existen — y adapta la plantilla a eso.

> **Scope boundary.** Esto es sobre *montar el pipeline*, no sobre triage de hallazgos concretos. Para decidir si un hallazgo se arregla con upgrade o se documenta como excepción en `.snyk`, usa el skill `bambu-snyk-dependency-hardening` (si está disponible en el repo) — este skill solo deja la tubería lista.

## Cuándo usar este skill

- "Agrega el workflow de Snyk a este repo."
- "Configura el escaneo de seguridad como en el repo X."
- "Necesito el SNYK_TOKEN configurado aquí."
- "Replica la configuración de seguridad en estos otros repos."
- Está por abrirse un repo nuevo y quieres el mismo baseline de seguridad desde el día uno.

## Flujo de trabajo

### Paso 0 — Prerrequisitos

Verifica, no asumas:

```bash
git rev-parse --is-inside-work-tree   # estás en un repo git
git remote -v                          # tiene remoto de GitHub
gh auth status                         # gh CLI autenticado
snyk --version                         # Snyk CLI disponible (si no, indícalo: npm i -g snyk / brew install snyk)
```

Si falta `gh` o `snyk` CLI, dilo explícitamente y ofrece instalarlos o pide al usuario que lo haga — no continúes asumiendo que existen.

### Paso 1 — Detectar el stack

Lee `references/package-manager-detection.md` para las heurísticas completas. Resumen:

1. **Package manager**, por el lockfile presente (en ese orden de precedencia si hay más de uno, y avisa si detectas mezcla — es una señal de repo inconsistente):
   - `pnpm-lock.yaml` → pnpm
   - `yarn.lock` → yarn (revisa si es **classic v1** o **berry/v2+**: `head -1 yarn.lock` dice `# yarn lockfile v1` para classic; berry no lleva esa línea y suele traer `.yarnrc.yml` + carpeta `.yarn/`)
   - `package-lock.json` → npm
   - `bun.lock` / `bun.lockb` → bun
   - Sin lockfile de JS/TS → probablemente no es un proyecto Node; confirma con el usuario antes de asumir que este skill aplica.

2. **Versión de runtime**: `packageManager` en `package.json` > `.nvmrc` / `.node-version` > `engines.node` en `package.json` > Dockerfile (`FROM node:X`) > pipeline de CI existente (buildspec, otros workflows). Si no encuentras nada, no inventes una versión — pregunta o usa la LTS activa vigente.

3. **Monorepo vs. paquete único**: campo `workspaces` en `package.json`, o `pnpm-workspace.yaml`, o carpetas tipo `apps/*`/`packages/*`. No cambia el comando de Snyk (`--all-projects` ya cubre monorepos), pero sí importa para el paso de instalación (algunos monorepos requieren `--frozen-lockfile` a nivel raíz únicamente).

4. **Backend / frontend / fullstack** — solo para el copy y los comentarios del workflow, no cambia la mecánica del escaneo:
   - Backend: `@nestjs/*`, `express`, `fastify`, `koa`, `apps/*/src/main.ts`, `serverless.yml`.
   - Frontend: `@angular/*`, `react`, `next`, `vue`, `vite.config.*`, `angular.json`.
   - Ambos → fullstack/monorepo; el workflow es el mismo, ajusta solo el copy de los comentarios si quieres mantenerlos descriptivos.

### Paso 2 — Detectar las branches a proteger

No asumas `develop`/`main`. Consulta las branches reales:

```bash
git branch -r
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
```

Usa el branch default siempre, más cualquier branch de integración de larga vida que exista (`develop`, `qa`, `staging`, `sprint-*` activo). Si hay ambigüedad, pregúntale al usuario con `AskUserQuestion` en vez de adivinar — es la lista que define cuándo el check bloquea un PR.

### Paso 3 — Revisar qué ya existe (idempotencia)

Antes de crear nada, revisa si ya hay una versión previa para no pisarla a ciegas:

```bash
ls .github/workflows/*.yml 2>/dev/null   # ¿ya hay un workflow de seguridad con otro nombre?
cat .github/CODEOWNERS 2>/dev/null       # ¿ya hay reglas, para no reemplazarlas?
gh secret list                           # ¿ya existe SNYK_TOKEN?
```

Si algo ya existe, muéstraselo al usuario y pregunta si actualizar, dejar como está, o fusionar — nunca sobreescribas un `CODEOWNERS` con reglas de otros paths sin avisar.

### Paso 4 — Generar el workflow

Parte de `assets/security.yml.template` (usa `npm ci` como base) y ajusta el bloque de setup/instalación según el package manager detectado en el Paso 1, usando las variantes de `references/package-manager-detection.md`. Mantén intacto el resto: triggers (`pull_request` + `schedule` semanal + `workflow_dispatch`), `permissions`, el paso de `Run Snyk` con `--all-projects --detection-depth=4 --severity-threshold=high --exclude=.worktrees`, y el paso de abrir/comentar el issue en el run programado.

Ajusta únicamente:
- `on.pull_request.branches` con la lista del Paso 2.
- El bloque de checkout/setup-node/instalación con el package manager correcto.
- Los comentarios explicativos, si quieres que reflejen el stack real del repo (opcional, no cambia el comportamiento).

No agregues pasos que el repo no necesita (p. ej. generar un cliente ORM) solo porque otro repo de referencia los tenía — Snyk resuelve el árbol de dependencias desde el lockfile/`node_modules`, no desde artefactos generados.

### Paso 5 — Generar/actualizar CODEOWNERS

Usa `assets/CODEOWNERS.template`. Si ya existe un `CODEOWNERS`, agrega solo la línea de `/.snyk`, no reemplaces el archivo.

El team dueño de esa línea es una decisión de la organización, no algo que este skill deba inventar: pregunta al usuario qué team/persona debe aprobar excepciones en `.snyk` si no es obvio por convención ya establecida en otros repos del mismo org.

### Paso 6 — Gobernanza en GitHub (acciones que requieren confirmación)

Todo lo de este paso modifica configuración compartida del repo/org — **confirma con el usuario antes de ejecutar cada una**, no lo asumas por haberlo hecho en un repo anterior:

1. **¿El team de CODEOWNERS tiene acceso al repo?**
   ```bash
   gh api orgs/<org>/teams/<team-slug>/repos --jq '.[].full_name'
   ```
   Si no aparece el repo, GitHub invalida esa línea del CODEOWNERS silenciosamente (no la aplica, no da error visible). Para que la asignación automática de reviewer funcione, el team necesita **al menos permiso `push` (write)** — `pull` (read) no alcanza aunque el archivo "parezca" válido. Ver `references/github-governance.md`.

2. **¿Cómo se obtiene el SNYK_TOKEN?** Pregunta explícitamente — no asumas la opción del token personal solo porque fue lo que se usó la última vez:
   - Token personal vía `snyk config get api` (rápido, pero es tu identidad individual la que queda atada al escaneo de CI).
   - Service Account Token a nivel de organización en Snyk (mejor práctica para CI compartido, sobrevive si la persona deja el equipo).

3. **Crear el secret:**
   ```bash
   gh secret set SNYK_TOKEN --repo <owner>/<repo> --body "<token>"
   ```

4. Si el PR se abre desde una rama ya existente creada **antes** de mergear este workflow, recuerda: GitHub resuelve los workflows de `pull_request` usando el archivo tal como existe en el **head** del PR, no en el base. Un PR viejo no va a correr el check nuevo solo porque ya está en la rama base — hay que actualizar esa rama (`gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch`, equivalente al botón "Update branch" de la UI) para que dispare un `synchronize`.

### Paso 7 — Branch, commit y PR

Sigue el flujo de contribución que ya use el repo (revisa su `CLAUDE.md`/`CONTRIBUTING.md` si existe: convención de nombres de branch, plantilla de PR, checks previos a abrir PR). Si no hay convención documentada, usa un nombre de branch descriptivo (`feat/ci-snyk-security` o similar), commit con mensaje claro, push, y abre el PR describiendo qué agrega y qué queda pendiente de configurar manualmente (branch protection).

### Paso 8 — Reportar lo que queda pendiente

Este skill deja el pipeline funcional, pero **no** configura branch protection (requiere permisos de admin y es una decisión de gobernanza del equipo, no algo para automatizar sin pedirlo explícitamente). Avisa siempre al usuario:

- Sin "Require status checks to pass" con el check de Snyk marcado como requerido, el check es solo indicativo — no bloquea el merge aunque falle.
- Sin "Require review from Code Owners", el CODEOWNERS tampoco bloquea, solo asigna reviewer.

## Reglas clave

1. **Nunca asumas el package manager, las branches, ni el nombre del team de seguridad** — detéctalos o pregúntalos. Este skill es portable entre repos con stacks distintos; una plantilla copiada a ciegas de otro proyecto es el error más común aquí.
2. **Idempotencia primero.** Revisa qué existe antes de generar — no dupliques workflows ni pises un `CODEOWNERS` con reglas de otros equipos.
3. **Toda acción que toque GitHub a nivel de repo/org (secrets, permisos de team, branch protection) se confirma explícitamente con el usuario antes de ejecutarse**, incluso si ya la ejecutaste sin objeción en un repo anterior de la misma sesión.
4. **No agregues pasos del workflow que el repo no necesita** (build steps, generación de clientes ORM, etc.) solo porque un repo de referencia los tenía — Snyk no los requiere para escanear dependencias.
5. **`--severity-threshold=high` no se negocia bajándolo** para destrabar un PR — un hallazgo sin fix disponible va a `.snyk` con `reason` y `expires`, nunca bajando el umbral global.

## Archivos de referencia

- `assets/security.yml.template` — Plantilla base del workflow (variante npm), con los puntos de ajuste marcados.
- `assets/CODEOWNERS.template` — Línea base para `.snyk`.
- `references/package-manager-detection.md` — Heurísticas de detección y el bloque de setup/instalación exacto para npm, yarn classic, yarn berry, pnpm y bun.
- `references/github-governance.md` — Detalle de permisos de team, CODEOWNERS, y el problema de PRs abiertos antes del merge del workflow.

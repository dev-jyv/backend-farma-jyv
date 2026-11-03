---
name: bambu-git-flow
description: Crea ramas y abre Pull Requests en cualquier repo de Bambu siguiendo la Política de Estrategia de Branching interna (v0.1, borrador) — infiere el tipo de rama (feature/fix/hotfix/refactor/chore/docs), determina la base correcta, valida la convención de nombres `<tipo>/<modulo>-<descripcion>[-<ticket>]` (≤50 caracteres, kebab-case), y abre el PR en borrador con el destino, método de merge y etiqueta de versión (major/minor/patch) que corresponda — corriendo antes los pre-chequeos de la política (PRs abiertos del developer, tamaño del diff, archivos pesados, plazo de vida de la rama) para que no los rechace el pipeline. Cubre también hotfixes desde `main`, promociones `dev→qa→main`, sincronizaciones `main→qa→dev`, y diagnóstico de un nombre de rama o PR ya existente. Usa este skill cuando el usuario diga "crea una rama para...", "voy a trabajar en...", "abre el PR", "sube esto", "hotfix de...", "promueve dev a qa", "sincroniza main a dev", "¿cómo se llama la rama para...?", "revisa el nombre de mi rama". Nunca hace merge, aprueba PRs, push directo a `dev`/`qa`/`main`, force push, salta protecciones, extiende plazos de ramas, ni ejecuta excepciones de emergencia.
---

# Bambu Git Flow

Skill que crea ramas y abre PRs **cumpliendo la Política de Estrategia de Branching de Bambu sin que el developer tenga que recordarla**. Deriva de esa política en su versión **v0.1 (borrador, sin fecha de emisión)** — las reglas completas viven en `references/politica-branching.md`; este archivo es solo el índice procedural.

> **Scope boundary.** Esta skill **propone y ejecuta con confirmación** acciones que crean una rama remota o abren un PR — nunca actúa en silencio. Lo que **nunca** hace, bajo ninguna circunstancia: merge de un PR, aprobar un PR, push directo a `dev`/`qa`/`main`, force push, saltarse protecciones de rama, extender el plazo de vida de una rama, ni ejecutar una excepción de emergencia. Esas son decisiones humanas (y algunas requieren al líder técnico).

## Cuándo usar este skill

- "Crea una rama para arreglar el timeout de checkout."
- "Voy a trabajar en el reset de password de auth."
- "Abre el PR" / "sube esto."
- "Hotfix de pagos duplicados."
- "Promueve dev a qa" / "sincroniza main a dev."
- "¿Cómo se llama la rama para esto?"
- "Revisa el nombre de mi rama" / "¿este PR cumple la política?"

## Antes de cualquier acción con efecto

- **Confirma con el usuario** antes de crear la rama remota o de abrir el PR — enséñale el nombre propuesto, la base, y el método de merge esperado antes de ejecutar.
- Antes de cambiar de rama o hacer `pull`, corre `git status`: si hay cambios sin commitear, detente y pregunta (stash/commit) en vez de perderlos. `scripts/create-branch.sh` ya aplica esta guarda él mismo (aborta si el working tree no está limpio, incluso si ya estás parado en la base) — no la saltees invocando git a mano.
- Si el repo pertenece a un cliente con un flujo de branching distinto al de esta política, dilo explícitamente: **la desviación requiere una solicitud escrita aprobada por el líder técnico y el CISO** — la skill no la aplica por su cuenta ni asume que "este repo es diferente" sin esa aprobación documentada.
- Esta skill asume `git` y GitHub CLI (`gh`) autenticado (`gh auth status`). Si falta, dilo y detente.

## Flujos

### Flujo A — Crear rama de desarrollo

1. Infiere el **tipo** (`feature`/`fix`/`refactor`/`chore`/`docs`/`hotfix`) de lo que describe el usuario; si es ambiguo, pregunta una sola vez — no insistas más de una ronda.
2. Determina la **base**: `dev` para todo excepto `hotfix`, que parte de `main`.
3. Pide o infiere **módulo** y **descripción** (resumen breve, en **inglés**, kebab-case) y el **ticket** si lo hay (va al final del nombre).
4. Corre `scripts/validate-branch-name.sh "<tipo>/<modulo>-<descripcion>[-<ticket>]"`. Si falla (formato o >50 caracteres), muestra el motivo y propón una descripción más corta — no la crees hasta que pase.
5. Con el nombre validado y confirmado por el usuario, corre `scripts/create-branch.sh <tipo> <modulo> <descripcion> [ticket]` — el script aborta si el working tree tiene cambios sin commitear (incluso si ya estabas parado en la base), actualiza la base (`fetch` + `checkout` + `pull --ff-only`), confirma que quedó parado exactamente en esa base antes de ramificar, y recién entonces crea la rama.
6. Recuerda el plazo de vida (**5 días hábiles**; **1 día hábil** si es `hotfix`, sin considerar feriados) y que el PR debe abrirse **en borrador desde el primer push**.

### Flujo B — Abrir PR de una rama de desarrollo

1. Verifica que el nombre de la rama actual sea válido (`scripts/validate-branch-name.sh`) y que su base real coincida con la que le corresponde al tipo.
2. Corre `scripts/create-pr.sh --base dev --title "<título>" --body-file <archivo>` (usa `--base main` si es `hotfix`) — el script hace los pre-chequeos de la política (PRs abiertos del developer, tamaño del diff, archivos >5 MB) antes de crear el PR.
3. Redacta el cuerpo del PR a partir de `assets/pr-template.md`; no inventes secciones nuevas, no quites el checklist.
4. El PR se abre **en borrador** apuntando a `dev` (o `main` si es `hotfix`). Indica al usuario el método de merge que le corresponde: **Rebase and merge** para una rama de desarrollo → `dev`.
5. Recuérdale: pasar el PR a *Ready for review* dispara el pipeline completo (build, lint, pruebas, SAST, dependencias); hay un máximo de **10 corridas totales** y **1 corrida simultánea** (la nueva cancela la anterior en curso).

### Flujo C — Hotfix

1. Rama `hotfix/<modulo>-<descripcion>` creada desde `main` (Flujo A, tipo `hotfix`).
2. PR a `main` vía `scripts/create-pr.sh --base main ...` — método **Merge commit**, requiere **2 aprobaciones** (una debe ser del líder técnico); plazo de vida de la rama: **1 día hábil**.
3. Al terminar (una vez mergeado a `main`), **prepara** los PRs de sincronización `main → qa` y `main → dev` (Flujo E) — no asumas que el pipeline los abre solo; ofrécelos tú.

### Flujo D — Promoción (`dev → qa`, `qa → main`)

1. Confirma el sentido: la promoción es **siempre hacia arriba** (`dev → qa → main`), nunca al revés.
2. Pregunta el incremento de versión (**`major` / `minor` / `patch`**) y aplica **exactamente una** etiqueta con `scripts/create-pr.sh --label <incremento>`. Si el usuario no decide, no la pongas tú — avísale que sin etiqueta el pipeline **asume `patch`**.
3. `scripts/create-pr.sh --base <qa|main> --label <incremento> ...` — método **Merge commit**, con las aprobaciones que correspondan a la rama destino (1 para `qa`, 2 para `main` con una del líder técnico).
4. Menciona que el pipeline etiqueta automáticamente: `vX.Y.Z-rc.N` al mergear a `qa`, `vX.Y.Z` al mergear a `main` — la skill no calcula ese número, solo lo menciona.

### Flujo E — Sincronización hacia abajo

PR `main → qa` y `qa → dev` (o `main → dev` directo tras un hotfix), vía `scripts/create-pr.sh --base <qa|dev> ...` sin `--label` — método **Merge commit**, sin etiqueta de versión.

### Flujo F — Validar / diagnosticar

Dado un nombre de rama o un PR ya abierto:
- Nombre de rama: corre `scripts/validate-branch-name.sh "<nombre>"` y explica en texto llano qué regla incumple y cómo corregirla.
- PR existente: lee su base, su head, y sus labels (`gh pr view <n> --json baseRefName,headRefName,labels,isDraft`) y compáralos contra `references/politica-branching.md` (destino correcto, método de merge esperado, exactamente una etiqueta si es de promoción) — reporta discrepancias, no las corrijas sin confirmar.

## Reglas clave

1. **Nunca mergees, apruebes, hagas push directo o force push** a `dev`/`qa`/`main`, ni extiendas el plazo de una rama — son decisiones humanas (algunas requieren al líder técnico o al CISO).
2. **El PR siempre se abre en borrador** desde el primer push; pasar a *Ready for review* es decisión del developer, no de esta skill.
3. **Un PR de promoción lleva exactamente una etiqueta** (`major`/`minor`/`patch`) — nunca ninguna, nunca dos. Si el usuario no decide, no la inventes: el pipeline asume `patch`.
4. **Valida antes de crear** — nombre de rama (`validate-branch-name.sh`) antes de `create-branch.sh`, y precondiciones (`git status` limpio, base actualizada) antes de cualquier `checkout`/`pull`.
5. Si el repo tiene un flujo distinto al de esta política, repórtalo y exige la aprobación escrita del líder técnico y el CISO — no la implementes por tu cuenta.
6. Los días hábiles que menciona esta skill **no consideran feriados** (la política v0.1 no define un calendario) — dilo como advertencia cada vez que reportes un plazo.

## Archivos de referencia

- `references/politica-branching.md` — reglas completas de la política (ramas permanentes, convención de nombres, métodos de merge, límites de PRs, etiquetado/versiones, poda) y los puntos que la v0.1 todavía no resuelve.
- `assets/pr-template.md` — plantilla de descripción de PR (agrega `Versión: major | minor | patch` en PRs de promoción).
- `scripts/validate-branch-name.sh` — valida formato + longitud ≤50 de un nombre de rama.
- `scripts/create-branch.sh` — arma el nombre, valida, actualiza la base y crea la rama.
- `scripts/create-pr.sh` — corre los pre-chequeos y abre el PR en borrador con `gh pr create`.

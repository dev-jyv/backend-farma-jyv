# Política de Estrategia de Branching — reglas completas

> Fuente: *Política de Estrategia de Branching* **v0.1 (borrador, sin fecha de emisión)** — Bambu Tech Services.
> Esta skill deriva de esa versión. Cuando la política se revise (la organización la revisa semestralmente), actualiza este archivo y el número de versión en el encabezado.

## 1. Ramas permanentes y ambientes

| Rama | Ambiente | Recibe cambios de | Aprobaciones en PR |
|---|---|---|---|
| `dev` | Desarrollo | `feature/*`, `fix/*`, `refactor/*`, `chore/*`, `docs/*` | 1 |
| `qa` | QA / Staging | `dev` | 1 |
| `main` | Producción | `qa` y `hotfix/*` | 2 (una debe ser del líder técnico) |

Promoción unidireccional: `dev → qa → main`. Los cambios de `main` regresan por **sincronización** (`main → qa → dev`) para evitar divergencia — nunca se promueve "hacia abajo".

## 2. Ramas de desarrollo

| Tipo | Uso | Se crea desde | Se integra a | Vida máxima |
|---|---|---|---|---|
| `feature` | Nueva funcionalidad | `dev` | `dev` | 5 días hábiles |
| `fix` | Corrección no urgente | `dev` | `dev` | 5 días hábiles |
| `refactor` | Reestructura sin cambio funcional | `dev` | `dev` | 5 días hábiles |
| `chore` | Mantenimiento, dependencias, configuración | `dev` | `dev` | 5 días hábiles |
| `docs` | Documentación | `dev` | `dev` | 5 días hábiles |
| `hotfix` | Corrección urgente en producción | `main` | `main` (luego sincronizar a `qa` y `dev`) | 1 día hábil |

## 3. Convención de nombres

```
<tipo>/<modulo>-<descripcion>[-<ticket>]
```

- `tipo`: `feature`, `fix`, `hotfix`, `refactor`, `chore` o `docs`.
- `modulo`: módulo funcional afectado (`auth`, `payments`, `reports`…).
- `descripcion`: resumen breve **en inglés**.
- `ticket`: opcional, **al final**, cuenta dentro del límite.
- **Máximo 50 caracteres** en total.
- Solo minúsculas, números y guiones (kebab-case). `/` solo después del tipo. Sin mayúsculas, espacios ni guiones bajos.

Expresión de validación (la que corre `scripts/validate-branch-name.sh`):

```
^(feature|fix|hotfix|refactor|chore|docs)/[a-z0-9]+(-[a-z0-9]+)+$
```
y longitud total ≤ 50.

Ejemplos válidos: `feature/auth-add-password-reset`, `fix/reports-null-total-on-export`, `hotfix/payments-timeout-on-checkout`, `feature/auth-add-reset-bam-123`.

## 4. Método de merge por tipo de integración

| Integración | Método |
|---|---|
| Rama de desarrollo → `dev` | **Rebase and merge** |
| Promoción `dev → qa → main` | **Merge commit** |
| Sincronización `main → qa → dev` | **Merge commit** |
| `hotfix/*` → `main` | **Merge commit** |

La rama se elimina automáticamente al hacer merge.

## 5. Pull Requests

- **Obligatorio abrirlo en borrador desde el primer push.** El pipeline completo corre al pasar a *Ready for review*; en borrador solo validaciones ligeras.
- Límites: **3 PRs abiertos por developer** (incluye borradores — ver punto abierto #5 más abajo), **10 corridas totales por PR**, **1 corrida simultánea** (la nueva cancela la anterior), **5 MB máx. por archivo**, **a partir de 4000 líneas modificadas se solicita dividir el PR**.
- Checks obligatorios para merge: build, lint, pruebas unitarias, SAST y dependencias.
- Conversaciones de revisión resueltas; aprobaciones obsoletas se descartan con commits nuevos.

## 6. Etiquetado y versiones (PRs de promoción)

- El PR de promoción lleva **una** etiqueta: `major`, `minor` o `patch`. El pipeline calcula la versión a partir de ella.
- Sin etiqueta, o con más de una → se asume **PATCH**.
- Tags automáticos desde el pipeline: `vX.Y.Z-rc.N` al hacer merge a `qa`, `vX.Y.Z` al hacer merge a `main`.

## 7. Poda

- Plazo desde la **creación de la rama**; aviso 1 día hábil antes como comentario en el PR; después, eliminación automática.
- Extensión: **una sola vez**, por 5 días hábiles, con aprobación del líder técnico. Esta skill **nunca** la ejecuta — solo informa que existe ese mecanismo y que requiere al líder técnico.

## 8. Puntos abiertos (la política v0.1 no los define — la skill no los resuelve por su cuenta)

1. **Módulo con varias palabras.** El formato `<modulo>-<descripcion>` no permite distinguir dónde termina el módulo si éste lleva guion (`user-profile`). La validación de formato no depende de esta distinción (el regex solo exige kebab-case con ≥2 segmentos), así que no bloquea nada — pero al **construir** un nombre nuevo, pide módulo y descripción como dos datos separados al usuario en vez de intentar adivinar el corte de un string ya armado.
2. **Formato del ticket.** El ejemplo de la política es `bam-123`: no está definido si el prefijo `bam` es fijo o varía por proyecto/cliente. No lo asumas — usa el ticket tal como lo dé el usuario.
3. **Título del PR y mensajes de commit.** La política no define convención (¿Conventional Commits?). Hasta que se defina explícitamente, esta skill **no impone ninguna** — el título del PR lo decide el developer o se deriva directamente de la descripción de la rama.
4. **Cálculo de días hábiles.** No está definido si se considera el calendario de feriados de México. Esta skill cuenta únicamente días hábiles de calendario (lunes a viernes) **sin** feriados, y lo advierte explícitamente cada vez que reporta un plazo.
5. **"PRs abiertos por developer: 3".** No está definido si cuentan los PRs en borrador. Esta skill **asume que sí** cuentan, por ser el escenario más estricto.
6. **PRs de sincronización.** No está definido si se abren manualmente o los automatiza el pipeline. Esta skill los **ofrece** como Flujo E (y como parte del cierre de un Flujo C de hotfix) — siempre con confirmación del usuario, nunca de forma automática/silenciosa.
7. **Rama de tags `qa`.** Si hay varios merges a `qa` entre promociones, el número `-rc.N` lo calcula el pipeline; esta skill solo lo menciona, nunca lo calcula.
8. **Versión del documento.** La política está en borrador (v0.1, sin fecha de emisión). Cuando se publique una revisión, actualiza el encabezado de este archivo con la nueva versión y revisa si alguno de estos puntos abiertos ya quedó resuelto.

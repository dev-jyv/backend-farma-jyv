---
name: bambu-nest-api-guide
description: Genera y publica, como Artifact, una guía de integración de API para el equipo de frontend a partir de un diff de git en el monorepo NestJS + Prisma de Bambu — endpoints nuevos/modificados/eliminados, breaking changes, y diffs de body/query/response/validadores. Usa este skill cuando el usuario pida "genera la guía de API para frontend", "documenta los cambios de API de este PR/rama", "necesito el changelog de endpoints", "qué rompe este cambio para el frontend", "publica el artifact de la API", "API integration guide", "breaking changes report for this branch". Solo aplica al monorepo NestJS de Bambu (controllers + DTOs con class-validator/@nestjs/swagger) — no es project-agnostic como bambu-readme-generator.
---

# Guía de integración de API para frontend

Genera un **Artifact** con la guía de integración de API para el equipo de frontend: endpoints nuevos, modificados y eliminados, breaking changes resaltados, y diffs de body/query/response/validadores — a partir de comparar dos puntos del historial git en el monorepo NestJS + Prisma de Bambu.

> **Scope boundary.** Este skill es **de solo lectura sobre git** — nunca hace commit, push, ni modifica código. El único efecto de lado es publicar (o actualizar) la página vía la herramienta `Artifact`. Es específico del stack de Bambu (controllers NestJS + DTOs con `class-validator`/`@nestjs/swagger` + `nestjs-i18n`) — pareado con `bambu-nest-rules`, que define esas convenciones. No es un generador de docs OpenAPI genérico.

## Cuándo usar este skill

- "Genera la guía de API para frontend de este PR/rama."
- "Documenta qué cambió en la API entre `v1.4.0` y `develop`."
- "¿Qué rompe este cambio para los clientes que ya integraron?"
- "Necesito el changelog de endpoints de este sprint."
- "Publica/actualiza el artifact de integración de API."

## Flujo de trabajo

### Paso 0 — Resolver el rango de comparación

1. Si el usuario dio un rango explícito (`refA..refB`) o una sola ref (tag/rama/commit) a usar como base, respétalo tal cual — corre `git fetch origin` primero si alguna ref no existe localmente.
2. Si no dio nada, detecta la rama base automáticamente:
   - Si la rama actual tiene upstream configurado (`git rev-parse --abbrev-ref --symbolic-full-name @{u}`), úsalo como base.
   - Si no, busca el punto de creación de la rama actual contra las ramas de larga vida candidatas (`develop`, `main`, `master`, `staging` — las que existan en `git branch -r`): `git merge-base <candidata> HEAD` para cada una, y toma la candidata cuyo merge-base sea el ancestro común más reciente (el "fork point" más próximo).
   - Compara `<base-detectada>..HEAD`.
3. Si tras esto sigue ambiguo (ej. varias candidatas con merge-base igual de cercano), usa `AskUserQuestion` con las candidatas encontradas — el rango de comparación es la decisión más importante de este skill, no adivines.
4. Repórtale al usuario, en una línea, qué rango vas a analizar (`base...HEAD`, conteo de commits, fecha del commit más viejo) antes de seguir.

### Paso 1 — Detectar archivos relevantes a la API

```bash
git diff --name-status <rango> -- '**/*.controller.ts' '**/*.dto.ts'
```

Lee `references/api-relevant-files.md` para la lista completa de qué incluir/ignorar (decoradores de auth y de `@nestjs/swagger` a vigilar, cuándo un archivo "interno" sí cuenta como cambio de contrato, y cuándo ignorarlo).

Para diffs grandes (muchos módulos tocados), delega el barrido a subagentes en paralelo con la herramienta `Agent` — uno por módulo/dominio afectado (ej. uno para `reservations`, otro para `group-sales`) — cada uno debe devolver una lista estructurada de endpoints afectados con su clasificación (ver Paso 2) en vez de prosa libre, para que armar el artifact después sea mecánico.

### Paso 2 — Clasificar cada endpoint tocado

Para cada endpoint cuyo controlador o DTO cambió en el rango, usa `git diff <rango> -- <archivo>` (no solo el estado final) para ver el antes/después real, y clasifícalo en una de: **NUEVO**, **ELIMINADO**, o **MODIFICADO** (body/query/params, response, auth/guards, o ruta/método HTTP).

Para cada campo modificado captura: nombre, tipo antes → después, y si el cambio es aditivo o no. Ver `references/breaking-change-taxonomy.md` para el desglose completo de qué cuenta como cada tipo de cambio.

### Paso 3 — Marcar breaking changes

Un cambio es **breaking** si un cliente que integró contra la versión anterior deja de funcionar sin cambios en su código. `references/breaking-change-taxonomy.md` lista los casos exactos (breaking vs. aditivo) — consúltalo antes de etiquetar cada cambio, no confíes solo en intuición.

### Paso 4 — Armar el contenido del artifact

Antes de escribir el HTML, carga la skill `artifact-design` para calibrar la inversión de diseño — esto es documentación técnica de consumo frecuente por frontend, prioriza escaneabilidad sobre ornamento: tabla de contenidos, badges de método HTTP con color consistente, bloques de código con diff visual `+`/`-`/`~` para los campos que cambiaron, no prosa larga.

Estructura sugerida:

1. **Encabezado** — rango comparado, fecha, conteo de endpoints nuevos/modificados/eliminados.
2. **Resumen de breaking changes** — arriba de todo, en un bloque visualmente distinto; si no hay ninguno, dilo explícitamente en vez de omitir la sección (evita que frontend tenga que inferir "sin mención = sin breaking changes").
3. **Índice** — por módulo/dominio, con conteo de cambios.
4. **Por cada endpoint tocado**, una tarjeta/sección con: badge de método HTTP + path completo + badge NUEVO/MODIFICADO/ELIMINADO, plataforma(s)/guard de auth requerido, tabla de campos de request y de response (nombre, tipo, requerido, validadores) con marcas `+`/`-`/`~`, ejemplo de JSON del body, y si es breaking, nota explícita de qué debe actualizar el frontend.
5. **Sección de eliminados** al final, aparte, para que no se pierdan entre los modificados.

No inventes campos que no estén en el DTO real ni infieras validadores que no viste en el diff — si necesitas mostrar el shape completo de un DTO grande aunque solo un campo haya cambiado, tómalo del archivo actual, no lo adivines.

### Paso 5 — Publicar el artifact

Escribe el HTML en el scratchpad de la sesión y publícalo con la herramienta `Artifact` (favicon fijo, ej. 🔌 o 📡 — consistente si el usuario vuelve a correr este skill sobre el mismo rango y pide "actualízalo"). Si el usuario menciona que ya existe un artifact de una corrida anterior y quiere el mismo link, pide la URL existente (o búscala con `Artifact` `action: "list"`) y actualiza en vez de publicar uno nuevo.

### Paso 6 — Reporte final

En el chat (no solo en el artifact):
- Link del artifact publicado.
- Conteo: X nuevos, Y modificados, Z eliminados.
- Si hay breaking changes, lístalos también en texto plano aquí — no obligues al usuario a abrir el link para saber si hay algo urgente.

## Reglas clave

1. **Solo lectura sobre git** — nunca hagas commit, push, ni modifiques código fuente; el único efecto de lado es publicar el artifact.
2. **El rango de comparación no se adivina a ciegas** — detéctalo con upstream/merge-base, y si queda ambiguo, pregunta.
3. **No inventes contrato** — campos, tipos y validadores salen del diff/archivo real, nunca de suposición.
4. **Breaking changes siempre visibles primero**, tanto en el artifact como en el reporte de chat — nunca los dejes solo implícitos en el detalle de cada endpoint.
5. Carga `artifact-design` antes de escribir el HTML.

## Archivos de referencia

- `references/api-relevant-files.md` — qué archivos/decoradores cuentan como contrato de API en el monorepo de Bambu, y qué ignorar.
- `references/breaking-change-taxonomy.md` — desglose completo de cambios breaking vs. aditivos.

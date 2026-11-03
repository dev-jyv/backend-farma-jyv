# bambu-nest-api-guide

Skill de Claude Code que genera y publica, como **Artifact**, una guía de
integración de API para el equipo de frontend a partir de un diff de git en
el monorepo **NestJS + Prisma** de Bambu: endpoints nuevos/modificados/
eliminados, breaking changes resaltados, y diffs de body/query/response/
validadores. Es de solo lectura sobre git — nunca hace commit ni push; el
único efecto de lado es publicar la página.

Específico del stack de Bambu (controllers NestJS + DTOs con
`class-validator`/`@nestjs/swagger` + `nestjs-i18n`), igual que
[`bambu-nest-rules`](../bambu-nest-rules) y
[`bambu-nest-test`](../bambu-nest-test) — no es un generador de docs OpenAPI
genérico.

## Estructura (auto-contenida)

```
bambu-nest-api-guide/
├── SKILL.md                             # metadata + flujo de trabajo paso a paso
└── references/
    ├── api-relevant-files.md            # qué archivos/decoradores cuentan como contrato de API
    └── breaking-change-taxonomy.md      # desglose de cambios breaking vs. aditivos
```

## Instalación

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-nest-api-guide ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-nest-api-guide <tu-proyecto>/.claude/skills/
```

O instálalo junto con el resto de la colección:

```bash
npx skills add Bambu-Developers/skills/bambu-nest-api-guide
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-nest-api-guide` (debe
aparecer en el autocompletado).

## Uso

Dentro del monorepo, con un rango de git explícito o dejando que lo detecte:

```text
/bambu-nest-api-guide v1.4.0..develop
```

o en lenguaje natural, por ejemplo:

- *"Genera la guía de API para frontend de este PR."*
- *"Documenta qué cambió en la API entre `v1.4.0` y `develop`."*
- *"¿Qué rompe este cambio para los clientes que ya integraron?"*
- *"Necesito el changelog de endpoints de este sprint."*
- *"Publica/actualiza el artifact de integración de API."*

Si no das un rango, la skill detecta la rama base (upstream configurado, o
merge-base contra `develop`/`main`/`master`/`staging`) y compara
`<base>..HEAD` — preguntando si queda ambiguo, nunca adivinando a ciegas.

### Salida

- Un **Artifact** HTML publicado con la guía completa (resumen de breaking
  changes arriba de todo, índice por módulo, una tarjeta por endpoint
  tocado).
- Un resumen en el chat: link del artifact, conteo de endpoints
  nuevos/modificados/eliminados, y los breaking changes listados en texto
  plano (no solo dentro del link).

## Límites (explícitos)

- Es de **solo lectura sobre git** — nunca hace commit, push, ni modifica código fuente.
- No inventa campos, tipos ni validadores que no estén en el DTO/diff real.
- No decide el rango de comparación sin evidencia — si queda ambiguo, pregunta con `AskUserQuestion`.
- No es project-agnostic: asume las convenciones de `bambu-nest-rules` (DTOs con `class-validator` + `@nestjs/swagger`, guards `@AuthAdminOnly`/`@AuthCustomerOnly`, `nestjs-i18n`).

Licencia: MIT · Bambu Tech Services.

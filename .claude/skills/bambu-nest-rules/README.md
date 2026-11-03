# bambu-nest-rules

Skill de Claude Code con las **convenciones de aplicación de un backend Bambu
en NestJS + Prisma**: estructura de carpetas, módulos dinámicos en libs, envs
tipados con Zod, DTOs con i18n + Swagger, un servicio por acción, manejo de
errores, acceso a datos vía Prisma, controladores delgados, autorización por
recurso+acción (CASL) y efectos secundarios orientados a eventos. Estas reglas
**pisan** cualquier consejo genérico de NestJS cuando entran en conflicto.

> **Agnóstico a infraestructura a propósito.** Ninguna regla aquí asume un
> destino de despliegue (contenedor, función serverless, VM, Kubernetes…), una
> nube concreta, ni un producto específico de gestión de secretos. Donde un
> detalle de infra podría colarse (p. ej. de dónde vienen los secretos), la
> regla lo deja explícitamente fuera de alcance. Para esas decisiones, usa el
> propio repo o una skill de infra dedicada (p. ej. `bambu-terraform-aws`).

## Estructura (auto-contenida)

```
bambu-nest-rules/
├── SKILL.md                                  # metadata + índice de reglas + resumen de 12 líneas
└── rules/
    ├── 01-project-structure.md
    ├── 02-libs-dynamic-modules.md
    ├── 03-env-config.md
    ├── 04-dtos-validation-swagger.md
    ├── 05-i18n-setup.md
    ├── 06-service-per-action.md
    ├── 07-service-error-handling.md
    ├── 08-prisma-usage.md
    ├── 09-thin-controllers.md
    ├── 10-authorization-ability-matrix.md
    ├── 11-exception-filters.md
    └── 12-event-driven-side-effects.md
```

## Instalación

Copia esta carpeta al repo NestJS donde Claude Code detecta skills:

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-nest-rules ~/.claude/skills/

# …o a nivel proyecto (recomendado, para poder ajustarla a ese repo)
cp -R bambu-nest-rules <tu-backend>/.claude/skills/
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-nest-rules`.

## Uso

El skill se carga automáticamente — no hace falta invocarlo por nombre — en
cuanto el trabajo toca el backend, por ejemplo:

- *"Crea un módulo nuevo para `invoices`."*
- *"Agrega un endpoint que reciba un `UpdateOrderDto`."*
- *"Necesito disparar un correo cuando se confirme un pago."*
- *"Revisa este PR contra las convenciones del repo."*
- *"¿Cómo protejo este endpoint para que solo lo use un admin?"*

También puedes invocarlo explícitamente con `/bambu-nest-rules` antes de pedir
el cambio, si quieres forzar que relea las reglas primero.

Carga siempre junto con `bambu-nest-test` cuando el cambio también necesita
tests (la skill de tests debe reflejar estas mismas convenciones).

## Reglas clave (ver tabla completa en `SKILL.md`)

1. Carpeta por dominio de negocio; código compartido agrupado por tipo.
2. Libs exponen `forRoot` / `forRootAsync`, nunca leen `process.env`.
3. Env vars tipadas y validadas con Zod en un único módulo de config.
4. DTOs obligatorios: cada validator con su key de i18n, cada campo con Swagger.
5. i18n se configura una sola vez por app; resolver e idioma por defecto según convención del repo.
6. Un servicio por acción de negocio (no un `XService` con cinco métodos).
7. Servicios lanzan excepciones con mensajes de `I18nService.t(...)`.
8. Acceso a datos solo vía `PrismaService` del lib interno de Prisma.
9. Controladores: una línea, delegan al servicio correspondiente.
10. Autorización por recurso+acción vía `ABILITY_MATRIX` + `@RequireAbility`.
11. Errores tipados de Prisma se mapean con un filtro global + i18n.
12. Efectos secundarios (correo, SMS, PDF…) corren tras el commit, vía eventos.

Esta skill reemplaza la versión anterior (atada a un monorepo serverless
específico con AWS Secrets Manager y `serverless.ts`): ese contenido era
demasiado específico de infraestructura para ser el estándar general de
Bambu. Si un proyecto concreto necesita esas convenciones, deben vivir en la
skill específica de ese repo, no aquí.

Licencia: MIT · Bambu Tech Services.

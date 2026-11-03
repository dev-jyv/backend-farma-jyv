# bambu-nest-test

Skill de Claude Code con los **patrones canónicos de unit testing** del monorepo
Bambu_Backend (NestJS + Prisma + nestjs-i18n): tests de DTOs, servicios,
controladores y módulos. Estos patrones pisan cualquier consejo genérico de
Jest/NestJS cuando entran en conflicto.

> Es específico de ese repo *consumidor* — no de este repositorio de skills.

## Estructura (auto-contenida)

```
bambu-nest-test/
├── SKILL.md                        # metadata + índice de reglas + config de Jest requerida
└── rules/
    ├── 01-dto-testing.md
    ├── 02-service-testing.md
    ├── 03-controller-testing.md
    └── 04-module-testing.md
```

## Instalación

Copia esta carpeta al repo Bambu_Backend donde Claude Code detecta skills:

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-nest-test ~/.claude/skills/

# …o a nivel proyecto (recomendado, es específico del monorepo)
cp -R bambu-nest-test <Bambu_Backend>/.claude/skills/
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-nest-test`.

## Uso

Se carga automáticamente al escribir o revisar tests en el monorepo, por ejemplo:

- *"Escribe los tests del `StaffService`."*
- *"Agrega el test del DTO `CreateStaffDto`."*
- *"Este módulo no tiene test, créalo."*
- *"Revisa si estos tests cubren el caso de error `NotFoundException`."*

Cárgalo siempre junto con `bambu-nest-rules` para que el test refleje las
convenciones reales de la implementación.

## Reglas clave (ver tabla completa en `SKILL.md`)

1. DTO → `plainToInstance(Dto, plain)` + `validate()`, se asiertan las keys de i18n.
2. Servicio → `Test.createTestingModule` con mocks `useValue` de `PrismaService` e `I18nService`.
3. Controlador → mock del servicio, `toBe` (referencia) en vez de `toEqual`.
4. Módulo → importa el módulo real, `overrideProvider(PrismaService).useValue(mock)`.
5. Siempre → `jest.clearAllMocks()` en `beforeEach`, un `describe` por método, nunca DB real.

## Ejecutar los tests

```bash
# Un patrón de archivos
pnpm jest --testPathPattern="apps/staff/src/dto"

# Un spec específico
pnpm jest --testPathPattern="staff.service.spec"

# Todos
pnpm jest
```

Licencia: MIT · Bambu Tech Services.

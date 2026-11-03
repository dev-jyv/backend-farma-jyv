# bambu-spec-define

Skill de Claude Code para la mitad **lenta** de un flujo de spec-driven design:
crea y mantiene specs (`SPEC NN`) como el contrato escrito que precede al código,
con preguntas socráticas sección por sección y un ciclo de vida de estados que
bloquea el paso a Approved mientras algo siga ambiguo. Forma pareja con
[**bambu-spec-implement**](../bambu-spec-implement), que ejecuta rápido una vez
que el spec correspondiente está Approved.

> "A spec is not decorative documentation. It is the contract that drives later
> execution. If the spec is vague, the code will improvise."

## Estructura (auto-contenida)

```
bambu-spec-define/
├── SKILL.md                      # metadata + flujo de trabajo + ciclo de vida de estados
└── templates/
    ├── SPEC.template.md          # esqueleto del spec con {{placeholders}}
    └── section-recipes.md        # receta socrática por sección (qué preguntar, cuándo omitir)
```

## Instalación

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-spec-define ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-spec-define <tu-proyecto>/.claude/skills/
```

O instálalo junto con el resto de la colección:

```bash
npx skills add Bambu-Developers/skills/bambu-spec-define
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-spec-define` (debe aparecer
en el autocompletado).

## Uso

Dentro del repositorio donde quieras el spec:

```text
/bambu-spec-define reintento de pagos
```

o en lenguaje natural, por ejemplo:

- *"Escribamos el spec del reintento de pagos."*
- *"Necesito un spec para el login con PIN de taquilla."*
- *"Manda el SPEC 04 a revisión."*
- *"Apruebo el SPEC 04."*
- *"¿Qué dice el SPEC 02?"*
- *"El SPEC 07 quedó obsoleto, lo reemplazó el SPEC 11."*

La skill ubica (o crea) el directorio `specs/` en la raíz del repo —o usa
`docs/specs/` si ya existe—, asigna el siguiente número `NN` libre, exige que el
**Objective** quepa en una sola oración, y guía sección por sección con las
preguntas de `templates/section-recipes.md` hasta llenar cada sección obligatoria
o justificar por qué una opcional se omite.

### Ciclo de vida de estados

```
Draft → In review → Approved → Implemented
  ↑___________________|   (editar contenido sustantivo regresa a In review)
  → Obsolete            (desde cualquier estado excepto Implemented)
```

| Estado | Español | Significado |
|---|---|---|
| Draft | Borrador | En construcción, puede estar incompleto. |
| In review | En revisión | Todas las secciones obligatorias están llenas; puede seguir teniendo Open Questions. |
| Approved | Aprobado | Open Questions vacía, Acceptance Criteria no vacío, dependencias también Approved/Implemented. Lo dispara solo una instrucción explícita del usuario. |
| Implemented | Implementado | Lo marca `bambu-spec-implement` al terminar; nunca se vuelve a editar en el lugar. |
| Obsolete | Obsoleto | Cancelado o reemplazado. El archivo nunca se borra. |

### Salida

```text
specs/
└── SPEC-04-reintento-de-pagos.md   # Status: Draft → ... → Approved
```

## Límites (explícitos)

- No escribe ni modifica código de aplicación — eso lo hace `bambu-spec-implement`, y solo cuando el spec está Approved.
- No se auto-aprueba a sí misma — Approved requiere instrucción explícita del usuario nombrando el spec.
- No borra archivos de spec — los marca Obsolete con la razón en la línea de Status.
- No rellena secciones opcionales con relleno genérico — las omite por completo cuando su regla de omisión aplica.

Licencia: MIT · Bambu Tech Services.

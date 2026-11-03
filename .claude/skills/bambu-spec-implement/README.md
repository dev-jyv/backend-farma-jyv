# bambu-spec-implement

Skill de Claude Code para la mitad **rápida** de un flujo de spec-driven design:
ejecuta un spec (`SPEC NN`) que ya está en estado Approved, tratándolo como el
contrato completo — sin reabrir decisiones de diseño ni improvisar donde el spec
ya decidió. Forma pareja con
[**bambu-spec-define**](../bambu-spec-define), que produce y aprueba ese
contrato antes de que esta skill pueda arrancar.

> "That is why this flow is deliberately slow during the definition phase and
> fast during the writing phase."

## Estructura (auto-contenida)

```
bambu-spec-implement/
└── SKILL.md   # metadata + flujo de trabajo + contrato de handoff
```

## Instalación

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-spec-implement ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-spec-implement <tu-proyecto>/.claude/skills/
```

O instálalo junto con el resto de la colección:

```bash
npx skills add Bambu-Developers/skills/bambu-spec-implement
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-spec-implement` (debe
aparecer en el autocompletado). Instálalo junto con `bambu-spec-define` — son
un par, no tienen sentido por separado.

## Uso

Dentro del repositorio donde vive el spec:

```text
/bambu-spec-implement SPEC 04
```

o en lenguaje natural, por ejemplo:

- *"Implementa el SPEC 04."*
- *"Empecemos a programar el spec del reintento de pagos."*
- *"¿Ya podemos hacer el SPEC 03?"*

La skill localiza `specs/SPEC-NN-*.md` (o `docs/specs/`), verifica que su
`Status` sea **Approved** y que cada entrada de `Depends on:` también lo esté,
lee las secciones de contrato (Interfaces & contracts, Functional requirements,
Edge cases, Acceptance criteria, Non-goals) como fuente de verdad, implementa, y
verifica el resultado contra cada ítem de Acceptance Criteria antes de reportar
terminado.

### Si el spec no está Approved

La skill se niega a arrancar y reporta exactamente qué falta:

```text
SPEC 04 está en estado "In review" — no se puede implementar todavía.
Pendiente para llegar a Approved: 2 Open Questions sin resolver.
Resuélvelo con bambu-spec-define antes de pedir la implementación.
```

### Al terminar

La única escritura que hace sobre el archivo del spec:

```diff
- > **Status:** Approved
+ > **Status:** Implemented — PR #123
```

Ninguna otra sección del spec se modifica.

## Límites (explícitos)

- No implementa nada contra un spec que no esté Approved — ni siquiera si "se ve casi listo".
- No decide ni edita el contenido de un spec — eso es trabajo de `bambu-spec-define`.
- No reinterpreta los Non-goals como alcance implícito.
- No improvisa ante una ambigüedad real del spec Approved — se detiene y pregunta, y lo reporta como un hueco del spec, no lo resuelve en silencio.

Licencia: MIT · Bambu Tech Services.

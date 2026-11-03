# bambu-git-flow

Skill de Claude Code que crea ramas y abre Pull Requests en cualquier repo de
Bambu siguiendo la **Política de Estrategia de Branching interna** (v0.1,
borrador): infiere el tipo de rama, determina la base correcta, valida la
convención de nombres, y abre el PR en borrador con el destino, método de
merge y etiqueta de versión que correspondan — corriendo antes los
pre-chequeos de la política (PRs abiertos, tamaño del diff, archivos
pesados) para que no los rechace el pipeline.

**Nunca** hace merge, aprueba PRs, push directo a `dev`/`qa`/`main`, force
push, salta protecciones, extiende plazos de ramas, ni ejecuta excepciones
de emergencia — eso son decisiones humanas.

## Estructura (auto-contenida)

```
bambu-git-flow/
├── SKILL.md                      # metadata + flujos A–F (corto, procedural)
├── references/
│   └── politica-branching.md     # reglas completas + puntos que la v0.1 no resuelve
├── assets/
│   └── pr-template.md            # plantilla de descripción de PR
└── scripts/
    ├── validate-branch-name.sh   # regex + longitud ≤ 50
    ├── create-branch.sh          # base correcta + fetch + checkout -b
    └── create-pr.sh              # gh pr create --draft + pre-chequeos + labels
```

## Instalación

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-git-flow ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-git-flow <tu-proyecto>/.claude/skills/
```

O instálalo junto con el resto de la colección:

```bash
npx skills add Bambu-Developers/skills/bambu-git-flow
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-git-flow` (debe
aparecer en el autocompletado).

### Prerrequisitos

```bash
git --version
gh auth status      # gh CLI autenticado contra GitHub
```

## Uso

Dentro del repositorio donde quieras crear la rama o el PR, en lenguaje
natural:

- *"Crea una rama para el reset de password de auth."*
- *"Voy a trabajar en el timeout de checkout en pagos."*
- *"Abre el PR."* / *"Sube esto."*
- *"Hotfix de pagos duplicados."*
- *"Promueve dev a qa."* / *"Sincroniza main a dev."*
- *"¿Cómo se llama la rama para esto?"*
- *"Revisa el nombre de mi rama."*

La skill cubre seis flujos: **A** crear rama de desarrollo, **B** abrir PR
de una rama de desarrollo, **C** hotfix (rama + PR a `main` + sincronización
posterior), **D** promoción `dev→qa`/`qa→main` con etiqueta de versión,
**E** sincronización hacia abajo `main→qa→dev`, y **F** validar/diagnosticar
un nombre de rama o PR existente.

### Salida

- Una rama local nueva, creada desde la base correcta y ya actualizada.
- Un PR **en borrador** con el destino, método de merge y (si aplica)
  etiqueta de versión correctos, usando la plantilla de `assets/pr-template.md`.
- Un reporte de los pre-chequeos de la política: PRs abiertos del
  developer, líneas modificadas vs. la base, y archivos > 5 MB.

## Límites (explícitos)

- Nunca mergea, aprueba, hace push directo o force push a `dev`/`qa`/`main`.
- Nunca extiende el plazo de vida de una rama ni ejecuta una excepción de
  emergencia — ambas requieren al líder técnico (o al CISO).
- No impone convención de título de PR ni de mensajes de commit — la
  política v0.1 no la define.
- No calcula días hábiles considerando feriados de México — la política no
  define ese calendario; la skill lo advierte cada vez que reporta un plazo.
- Si el repo tiene un flujo de branching distinto, la skill lo reporta y
  exige una solicitud escrita aprobada por el líder técnico y el CISO — no
  lo implementa por su cuenta.

Ver `references/politica-branching.md` para el resto de puntos que la
política v0.1 todavía no resuelve.

Licencia: MIT · Bambu Tech Services.

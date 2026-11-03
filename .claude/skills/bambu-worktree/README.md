# bambu-worktree

Skill de Claude Code para crear un **git worktree aislado** en `.worktrees/<feature>/`,
con su propia rama, a partir de una descripción breve del requerimiento o de un
nombre de rama explícito. Pensado para trabajar varias cosas en paralelo sin
hacer `stash`/`checkout` constantes en el mismo directorio de trabajo. No asume
rama por defecto ni convención de ramas de ningún repo en particular — las
detecta o pregunta.

## Estructura (auto-contenida)

```
bambu-worktree/
└── SKILL.md   # metadata + flujo de trabajo paso a paso
```

## Instalación

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-worktree ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-worktree <tu-proyecto>/.claude/skills/
```

O instálalo junto con el resto de la colección:

```bash
npx skills add Bambu-Developers/skills/bambu-worktree
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-worktree` (debe aparecer
en el autocompletado).

## Uso

Dentro del repositorio donde quieras el worktree nuevo:

```text
/bambu-worktree agregar login con PIN a taquilla
```

o en lenguaje natural, por ejemplo:

- *"Crea un worktree para el fix del cálculo de descuento."*
- *"Necesito trabajar en paralelo en el reporte de ventas sin tocar lo que ya tengo en progreso."*
- *"Dame un checkout aparte en una rama llamada `hotfix/pago-duplicado`."*
- *"New worktree for the login feature."*

La skill deriva el nombre de carpeta/rama (o respeta el que le des explícito),
detecta la rama base real del repo (nunca asume `develop`/`main`), verifica que
no exista ya esa carpeta o rama, se asegura de que `.worktrees/` esté en el
`.gitignore` del repo destino, y solo entonces corre
`git worktree add -b <feature> .worktrees/<feature> origin/<rama-base>`.

### Salida

```text
.worktrees/
└── <feature>/   # checkout nuevo, rama <feature> creada a partir de <rama-base>
```

Más la línea `.worktrees/` agregada al `.gitignore` del repo destino, si no
estaba ya.

## Límites (explícitos)

- No asume rama base por defecto — la detecta (`gh repo view` / `git remote show origin`) o pregunta si hay ambigüedad.
- No crea el worktree si ya existe una carpeta o rama con ese nombre sin confirmar antes con el usuario.
- No sube `.worktrees/` al remoto ni modifica ramas existentes — solo agrega una rama y un checkout local nuevos.

Licencia: MIT · Bambu Tech Services.

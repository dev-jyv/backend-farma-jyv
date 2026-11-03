# bambu-readme-generator

Skill de Claude Code que regenera el `README.md` raíz de **cualquier** proyecto
autodescubriendo su estado real: lenguaje/runtime, package manager, layout
(`apps/`, `libs/`, `packages/`, `services/`, …), scripts disponibles y archivos
principales. Trata el README existente como una fotografía desactualizada, no
como fuente de verdad.

## Estructura (auto-contenida)

```
bambu-readme-generator/
├── SKILL.md                      # metadata + flujo de trabajo paso a paso (detección → render → validación)
└── templates/
    ├── README.template.md        # esqueleto genérico con {{placeholders}}
    └── section-recipes.md        # cómo renderizar cada sección opcional
```

## Instalación

Copia esta carpeta a donde Claude Code detecta skills:

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-readme-generator ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-readme-generator <tu-proyecto>/.claude/skills/
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-readme-generator`.

## Uso

Dentro de cualquier proyecto (Node, Python, Go, Rust, Java, PHP, Ruby, Elixir,
Dart/Flutter, monorepo o paquete único):

```text
/bambu-readme-generator
```

o en lenguaje natural:

- *"Genera el README."*
- *"Actualiza el README del proyecto."*
- *"Regenera la documentación raíz, agregué un servicio nuevo."*
- *"Create the README from scratch for this repo."*
- *"Refresh the README, the scripts changed."*

La skill inspecciona manifiestos (`package.json`, `pyproject.toml`, `go.mod`,
`Cargo.toml`, etc.), mapea el layout, extrae los scripts/comandos reales y
renderiza el `README.md` desde `templates/README.template.md`. Antes de
escribir, valida que ningún `{{placeholder}}` quede sin sustituir y te pregunta
si alguna sección escrita a mano (badges, sponsors, FAQ) se perdería.

> No se usa para documentar archivos individuales, JSDoc/TSDoc, referencias de
> API, ni READMEs de sub-paquetes — solo el `README.md` raíz.

## Reglas clave

- Nunca inventa componentes, scripts o versiones de runtime que no estén
  respaldados por un archivo real.
- Nunca borra o renombra secciones escritas a mano sin confirmación.
- Solo toca `README.md` — no `CONTRIBUTING.md`, `CHANGELOG.md`, `CLAUDE.md`, etc.

Licencia: MIT · Bambu Tech Services.

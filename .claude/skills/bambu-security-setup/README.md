# bambu-security-setup

Skill de Claude Code para montar (o auditar) el **escaneo de dependencias con Snyk**
en CI, en cualquier repositorio — backend o frontend, monorepo o paquete único,
con npm / yarn classic / yarn berry / pnpm / bun. No asume un stack: detecta
el package manager, el runtime y las branches a proteger antes de escribir nada.

## Estructura (auto-contenida)

```
bambu-security-setup/
├── SKILL.md                         # metadata + flujo de trabajo paso a paso
├── references/
│   ├── package-manager-detection.md # heurísticas + bloque de setup exacto por package manager
│   └── github-governance.md         # permisos de team, CODEOWNERS, PRs abiertos antes del merge
└── assets/
    ├── security.yml.template        # workflow base de GitHub Actions (variante npm)
    └── CODEOWNERS.template          # línea base para `.snyk`
```

## Instalación

Copia esta carpeta a donde Claude Code detecta skills:

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-security-setup ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-security-setup <tu-proyecto>/.claude/skills/
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-security-setup` (debe aparecer
en el autocompletado).

### Prerrequisitos

```bash
gh auth status      # gh CLI autenticado contra GitHub
snyk --version       # Snyk CLI disponible (si falta: npm i -g snyk / brew install snyk)
```

## Uso

Dentro del repositorio al que le quieres agregar el escaneo:

```text
/bambu-security-setup
```

o en lenguaje natural, por ejemplo:

- *"Agrega el workflow de Snyk a este repo."*
- *"Configura el escaneo de seguridad como en el repo X."*
- *"Necesito el SNYK_TOKEN configurado aquí."*
- *"Replica la configuración de seguridad de este repo en estos otros tres."*
- *"Vamos a abrir un repo nuevo, déjalo con el mismo baseline de seguridad desde el día uno."*

La skill sigue, en orden: detectar el package manager/runtime/monorepo (Paso 1),
detectar las branches a proteger (Paso 2), revisar qué ya existe para no pisarlo
(Paso 3), generar el workflow (Paso 4) y el `CODEOWNERS` de `.snyk` (Paso 5), y
solo entonces pasar a la gobernanza de GitHub (Paso 6) — acceso del team, secret
`SNYK_TOKEN` — **confirmando cada acción contigo antes de ejecutarla**. Cierra
abriendo el PR (Paso 7) y reportando qué queda pendiente de configurar
manualmente, como branch protection (Paso 8).

### Salida

```text
.github/
├── workflows/security.yml   # bloquea PRs (branches detectadas) + corre semanal + workflow_dispatch
└── CODEOWNERS                # agrega (o crea) la línea de `.snyk`
```

Más el secret `SNYK_TOKEN` configurado en el repo (`gh secret list` para verificarlo).

## Límites (explícitos)

- No decide triage de hallazgos concretos (upgrade vs. excepción en `.snyk`) — eso
  es responsabilidad del skill `bambu-snyk-dependency-hardening`, si está disponible.
- No baja `--severity-threshold=high` para destrabar un PR.
- No configura *branch protection* ni *require review from Code Owners* — requiere
  permisos de admin y es una decisión de gobernanza que se reporta, no se automatiza.
- No asume package manager, branches ni team de seguridad — los detecta o pregunta.

Licencia: MIT · Bambu Tech Services.

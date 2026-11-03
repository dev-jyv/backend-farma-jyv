# bambu-e2e-test-matrix

Skill de Claude Code para **QA E2E** sobre cualquier aplicación web: genera y ejecuta
matrices de pruebas manuales (flujo, usabilidad, visual, accesibilidad, casos borde),
compara opcionalmente contra **Figma** y corre análisis de seguridad **SAST** (OWASP Top 10,
CWE Top 25, secretos, CVEs). Todo local; nunca modifica el código de la app bajo prueba.

## Estructura (auto-contenida)

```
bambu-e2e-test-matrix/
├── SKILL.md                     # metadata + instrucciones (el orquestador)
├── scripts/
│   └── setup.sh                 # configura Playwright MCP @0.0.68 + (opcional) instala agentes
├── references/                  # guías que la skill consulta cuando aplican
│   ├── playwright-automation.md
│   ├── agentic-browser-testing.md
│   ├── visual-testing.md
│   ├── accessibility-testing.md
│   ├── seguridad-sast.md
│   └── agents/                  # perfiles de los 4 subagentes
│       ├── e2e-explorer.md
│       ├── e2e-runner.md
│       ├── e2e-visual-figma.md
│       └── e2e-security-sast.md
└── assets/
    └── templates/               # matriz-pruebas.csv · ESTADO-CORRIDA.md · reporte.md
```

## Instalación

Copia esta carpeta a donde Claude Code detecta skills (igual que el resto de skills del repo):

```bash
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-e2e-test-matrix ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-e2e-test-matrix <tu-proyecto>/.claude/skills/
```

Reinicia Claude Code para que detecte la skill. Compruébalo escribiendo `/bambu-e2e-test-matrix`
(debe aparecer en el autocompletado).

## Configuración (una sola vez): Playwright MCP con video

La skill graba video usando el Playwright MCP. Configúralo con el script incluido:

```bash
bash ~/.claude/skills/bambu-e2e-test-matrix/scripts/setup.sh
```

Esto:

1. Registra el MCP fijado en **`@playwright/mcp@0.0.68`** con **`--save-video=1280x800`**
   (esa versión/flag es la que **habilita grabar el video**).
2. Pregunta si quieres instalar los **4 subagentes** en `~/.claude/agents/` para poder
   invocarlos por nombre. (Si dices que no, la skill igual delega leyendo sus perfiles de
   `references/agents/` como prompt — funciona en ambos casos.)
3. Reporta las herramientas **opcionales** de SAST.

### Equivalente manual (sin el script)

```bash
claude mcp add playwright -- npx @playwright/mcp@0.0.68 --save-video=1280x800 --output-dir ~/qa-e2e-tmp
```

Confirma con `/mcp` que `playwright` conecta (Claude Code pide aprobar el servidor la 1ª vez).

> **Sobre la versión 0.0.68:** es la versión del paquete `@playwright/mcp` (el servidor MCP)
> que permite tomar video con `--save-video`. Si en el futuro se actualiza y se pierde la
> grabación, vuelve a fijar `0.0.68`.

### Figma (opcional, solo comparación visual)

```bash
# Figma Desktop → Preferences → Enable Dev Mode MCP Server
claude mcp add --transport http figma-dev-mode-mcp-server http://127.0.0.1:3845/mcp
```

### SAST (opcional)

```bash
brew install semgrep osv-scanner   # macOS. npm/pnpm ya sirven de respaldo para CVEs.
```

## Uso

Dentro del proyecto/URL que quieras probar:

```text
/bambu-e2e-test-matrix
```

o en lenguaje natural: *"genera la matriz de pruebas E2E del flujo de compra en <URL>,
incluye accesibilidad y seguridad SAST"*.

La skill te preguntará el intake (URL, credenciales, repo, Figma, alcance, salida, email
temporal, SAST, tamaño de lote y modo de avance), armará la matriz (**Fase 1**) y **esperará
tu aprobación explícita** antes de ejecutar (**Fase 2**; **Fase 3** de seguridad si la pediste).

### Salida

```text
qa/e2e/<fecha>/
├── matriz-pruebas.csv     # casos: Estado, Video, Marca_Tiempo (mm:ss), Notas
├── ESTADO-CORRIDA.md      # checkpoint del loop: módulos completos, activo, qué sigue
├── .auth/session.json     # sesión guardada (evita repetir OTP entre lotes)
├── videos/                # UN video continuo por módulo
├── screenshots/           # solo comparaciones Visual/Figma
├── seguridad/             # solo si pediste SAST
└── reporte.md             # resumen + calificación 0-100 + ranking de módulos
```

## Límites (explícitos)

- No modifica el código del proyecto bajo prueba, nunca.
- No es pentesting activo / DAST — el SAST es estático de solo lectura.
- No es prueba de carga/estrés.
- No completa pagos/compras/acciones irreversibles reales sin autorización explícita.
- No ejecuta la Fase 2 sin aprobación de la matriz de la Fase 1.

Licencia: MIT · Bambu Tech Services.

# bambu-playwright-qa-e2e

Skill de Claude Code para generar suites E2E con **Playwright** en cualquier app web —
Angular, React, Vue, Next.js, o un framework que el modelo no reconozca de entrada — a
partir de un flujo crítico descrito por el usuario o de un componente/pantalla concreto.
Cubre happy paths y, sistemáticamente, edge cases por tipo de campo (email mal formado,
letras en un input numérico/teléfono, longitud máxima, fechas fuera de rango, selects sin
opción válida) usando un catálogo de casos, no solo lo obvio. Confirma selectores y
comportamiento contra la UI real antes de escribir un solo spec. No asume el framework del
proyecto ni su convención de locators — los detecta o pregunta.

## Estructura (auto-contenida)

```
bambu-playwright-qa-e2e/
├── SKILL.md                          # metadata + flujo de trabajo paso a paso
├── references/
│   ├── framework-detection.md        # señal universal (package.json) + matiz puntual por framework
│   ├── edge-case-catalog.md          # matriz tipo de campo → caso feliz + edge cases
│   ├── page-object-pattern.md        # patrón de Page Object + gotchas por framework
│   └── authenticated-routes.md       # storageState, proyecto de setup, 2FA/SSO/CAPTCHA
└── scripts/
    └── detect-framework.sh           # detección determinista (no depende de que el modelo adivine)
```

## Instalación

```bash
npx skills add Bambu-Developers/skills/bambu-playwright-qa-e2e

# …o manualmente
# A nivel usuario (sirve para todos tus proyectos)
cp -R bambu-playwright-qa-e2e ~/.claude/skills/

# …o a nivel proyecto
cp -R bambu-playwright-qa-e2e <tu-proyecto>/.claude/skills/
```

Reinicia Claude Code y confírmalo escribiendo `/bambu-playwright-qa-e2e` (debe aparecer en el
autocompletado).

## Uso

Dentro del repositorio del proyecto que quieres cubrir:

```text
/bambu-playwright-qa-e2e el flujo de checkout: agregar al carrito, aplicar cupón y pagar
```

o en lenguaje natural, por ejemplo:

- *"Genera tests E2E para el formulario de registro, con todos los edge cases de validación."*
- *"Pruébame el componente de selección de fecha, incluyendo fechas fuera de rango."*
- *"Cubre los edge cases del campo de teléfono en el checkout — que no acepte letras."*
- *"Write E2E tests for the login flow, including invalid email handling."*
- *"Quiero que un cambio futuro en este componente no rompa el flujo de pago sin que nos enteremos."*

La skill detecta el framework del proyecto (`scripts/detect-framework.sh`), confirma la UI
real antes de escribir nada (vía MCP de Playwright si está disponible, o navegando el dev
server manualmente), arma la matriz de casos con `references/edge-case-catalog.md` para
cada campo detectado, y escribe Page Objects por rol/nombre accesible — respetando
`data-testid` si el proyecto ya lo usa, sin imponerlo si no. Si el flujo vive detrás de un
login, usa el patrón `storageState` de `references/authenticated-routes.md` en vez de volver
a loguearse en cada spec.

### Salida

```text
e2e/                        # o la carpeta que ya use el proyecto, si existe una suite previa
├── pages/
│   └── <flujo>.page.ts     # Page Object con locators por rol/label
└── <flujo>.spec.ts         # happy path + edge cases del catálogo que apliquen
```

Más un reporte final con: huecos de accesibilidad encontrados en el camino, bugs reales
expuestos por los edge cases (no solo "pasó/falló"), y qué regresión futura protege cada
spec nuevo.

## Límites (explícitos)

- No genera Component Testing real (`mount()` + gallery de Playwright 1.62+) — para eso
  remite al skill oficial de Microsoft (`playwright-component-testing`) cuando el framework
  lo soporta (React/Vue). Un "componente individual" aquí se prueba a través de la página
  real que lo renderiza, nunca montado aislado.
- No tiene gallery de Component Testing para Angular porque no existe ninguna oficial ni
  comunitaria vigente — queda fuera de alcance, no es una omisión de esta skill.
- No configura CI/CD ni engancha la suite a un pipeline — genera los specs, no su ejecución
  recurrente.
- No crea una suite paralela si el proyecto ya tiene una establecida (`e2e/`, `cypress/`,
  `tests/e2e/`) — extiende la existente y sigue sus convenciones.
- No asume el framework, el gestor de paquetes, ni la convención de locators de ningún
  proyecto en particular — los detecta primero o pregunta si hay ambigüedad.

Licencia: MIT · Bambu Tech Services.

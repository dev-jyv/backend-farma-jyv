---
name: bambu-playwright-qa-e2e
description: >
  Genera suites E2E con Playwright para cualquier app web (Angular, React, Vue, Next.js, o cualquier
  SPA/SSR que el modelo no reconozca) a partir de un flujo crítico descrito por el usuario o de un
  componente/pantalla concreto. Cubre happy paths Y edge cases sistemáticos por tipo de campo —
  formato inválido en un input de email, letras en un campo numérico o de teléfono, longitud máxima,
  fechas fuera de rango, selects sin opción válida — usando un catálogo de casos por tipo de campo, no
  solo lo obvio. Confirma selectores y comportamiento contra la UI real (vía MCP de Playwright o el
  dev server) antes de escribir el spec, nunca a ciegas desde el código. Maneja flujos detrás de login
  con el patrón `storageState` (sesión de prueba real, nunca credenciales inventadas), no solo rutas
  públicas. Úsala cuando el usuario diga
  "genera tests E2E para...", "pruébame este flujo", "agrega casos de prueba para el login/checkout/
  formulario de X", "write E2E tests for...", "test this component", "cubre los edge cases de este
  formulario", "reduce bugs de regresión en...", o cuando pida que un cambio en un componente no rompa
  otra parte de la app. Detecta el framework del proyecto antes de asumir convenciones (Signal Forms,
  React controlled inputs, Vue v-model, etc. se comportan distinto frente a eventos sintéticos). Nunca
  hace Component Testing real (mount()+gallery) — para eso remite al skill oficial de Microsoft
  (`playwright-component-testing`) cuando el framework lo soporta (React/Vue); un "componente
  individual" aquí se prueba a través de la página real que lo renderiza. No reemplaza el gate de CI
  ni corre los tests de forma recurrente por su cuenta — eso es trabajo del CI del proyecto o de un
  comando/skill de ejecución aparte, no de esta skill.
---

# bambu-playwright-qa-e2e

Genera suites de Playwright E2E — flujos críticos multi-pantalla y componentes individuales probados
a través de su página real — cubriendo sistemáticamente happy paths y edge cases por tipo de campo,
en cualquier framework. El objetivo es reducir bugs de producción y cazar regresiones cuando un
cambio en un componente rompe otra parte de la app, no solo demostrar que "algo funciona".

## Cuándo usar este skill

- El usuario pide tests E2E para un flujo crítico (login, checkout, alta de un registro, onboarding).
- El usuario pide tests para un componente o pantalla específica, incluyendo casos borde de
  validación ("que el campo de teléfono no acepte letras", "que el email esté bien validado").
- El usuario quiere que un cambio futuro en un componente no rompa silenciosamente otra parte de la
  app — es decir, quiere specs que sirvan de gate real.

**Cuándo NO usarla:**

- Para Component Testing real (`mount()` + gallery de Playwright). Esta skill no lo hace — ver
  `references/framework-detection.md` para cuándo remitir al skill oficial de Microsoft en su lugar.
- Para configurar CI/CD. Esta skill genera los specs; engancharlos a un pipeline es trabajo aparte.
- Si el proyecto ya tiene una suite E2E establecida (`e2e/`, `cypress/`, `tests/e2e/` con specs
  existentes): extiende esa suite y sigue sus convenciones de Page Object, no crees una paralela.

## Paso 0 — Detectar framework y confirmar alcance

1. Corre `scripts/detect-framework.sh <ruta-del-proyecto>` (o sin argumento si ya estás parado en la
   raíz del proyecto). Es determinista — lee `package.json` y archivos de configuración — no adivines
   el framework leyendo prosa o el nombre de carpetas.
2. Aplica la advertencia que imprime el script sobre el comando de dev server, si trae una (Next.js:
   preferir `next build && next start` sobre `next dev`; Angular: agregar `--no-live-reload`) — ambas
   evitan que una recarga espontánea tire el estado a mitad de un test. Ver
   `references/framework-detection.md` para el porqué de cada una.
3. Si no hay `@playwright/test` instalado, instálalo. Antes de asumir que el navegador se descargó,
   revisa si el gestor de paquetes bloquea scripts de instalación (pnpm 10+ con
   `onlyBuiltDependencies`, `npm`/`yarn` con `--ignore-scripts`) — si lo bloquea, corre
   `npx playwright install chromium` explícito después.
4. Si el usuario no describió un flujo o componente concreto al invocar la skill, **pregúntale antes
   de seguir**. No inventes el alcance ni elijas un flujo "representativo" por tu cuenta.
5. Revisa si ya existe una suite E2E en el repo (`e2e/`, `cypress/`, `tests/e2e/`, `playwright.config.*`).
   Si existe, sigue su estructura y convenciones de Page Object en vez de imponer una nueva.
6. **¿El flujo vive detrás de una sesión?** Intenta navegar directo a la ruta objetivo sin loguearte;
   si redirige a login o responde 401/403, está protegida. En ese caso lee
   `references/authenticated-routes.md` antes de seguir: cómo conseguir una sesión de prueba real
   (nunca inventar credenciales), el patrón `storageState` + proyecto de setup para no repetir el
   login en cada spec, y qué hacer cuando no hay atajo limpio (2FA real, SSO externo, CAPTCHA).

## Paso 1 — Leer antes de escribir, y tratarlo como hipótesis

1. Lee el componente/página del flujo. Identifica cada campo de formulario y su tipo semántico: email,
   teléfono, numérico/monto, fecha, texto con longitud máxima, select/combobox, checkbox/radio,
   archivo.
2. **Confirma en vivo, nunca a ciegas.** Si hay MCP de Playwright disponible, úsalo para navegar la
   UI real antes de escribir nada. Si no, levanta el dev server y navega manualmente. Lo que hay que
   confirmar, no asumir:
   - El nombre accesible real de cada campo (rol + texto del label), no el que parece obvio por el
     HTML.
   - La condición exacta bajo la que aparece cada mensaje de error (algunos frameworks lo muestran
     solo tras `touched`/`blur`, otros al primer submit — difiere incluso entre librerías del mismo
     framework).
   - Si hay autoguardado, debounce, o cualquier retraso — y si existe una condición de carrera entre
     ese autoguardado y la acción de enviar/confirmar (ver `references/page-object-pattern.md`: ya se
     encontró una real en producción escribiendo esta skill).
   - Los gotchas de eventos sintéticos por framework listados en
     `references/page-object-pattern.md` (inputs controlados de React, `v-model` de Vue, Signal
     Forms/Reactive Forms de Angular) — un campo puede parecer actualizado en el DOM sin que el
     framework se haya enterado.

## Paso 2 — Armar la matriz de casos

Usa `references/edge-case-catalog.md`: por cada campo que el Paso 1 confirmó, toma el tipo semántico
y lista el caso feliz más los edge cases del catálogo que apliquen. No apliques el catálogo completo
a ciegas — si un campo no tiene una validación de formato real, no inventes un caso que la pruebe.
Si el Paso 1 reveló una regla de negocio específica (un tope, una ventana de fechas, un máximo), añade
un caso en el límite exacto (±1) aunque no esté listado literal en el catálogo genérico.

## Paso 3 — Page Objects + specs

1. Un Page Object por pantalla/componente relevante, con locators por **rol y nombre accesible**
   primero.
2. **Sobre `data-testid`**: detecta la convención ya existente del proyecto (`grep -r data-testid` en
   su código fuente) y síguela si ya la usa. Si el proyecto no tiene ese patrón, no lo introduzcas —
   usa rol/label, que además funciona como aserción implícita de accesibilidad.
3. Agrupa los tests con `test.describe`. Cada test es un escenario de usuario completo (acción +
   resultado observable), nunca una llamada directa a un método interno del componente.
4. Nombra los tests en el idioma que use el resto del proyecto (si el código y los comentarios están
   en español, los nombres de test van en español; si están en inglés, en inglés).

## Paso 4 — Correr hasta que pase

Corre la suite. Si algo no se comporta como el Paso 1 asumió, vuelve a confirmarlo en vivo antes de
ajustar el spec a ciegas — un segundo selector adivinado es tan arriesgado como el primero.

## Paso 5 — Reporte final

Reporta, sin arreglarlos a menos que se pida:

- Huecos de accesibilidad encontrados en el camino (labels rotos, nombres accesibles ausentes, estados
  que solo se distinguen por color).
- Bugs reales encontrados al correr los edge cases (no solo "el test pasó/falló" — qué comportamiento
  incorrecto expuso).
- Qué protegen específicamente los specs nuevos: qué regresión futura detectarían y en qué componente,
  para que el valor de "reduce bugs en producción" quede explícito.

## Reglas clave

- **Nunca** escribas un spec sin haber confirmado el comportamiento real primero (Paso 1).
- **Nunca** asumas el framework — corre siempre la detección del Paso 0.
- **Nunca** impongas `data-testid` si el proyecto no lo usa ya, ni lo prohíbas si sí lo usa.
- **Nunca** generes Component Testing real (`mount()`/gallery) — remite al skill oficial si aplica.
- **Nunca** omitas los edge cases del catálogo que apliquen a un tipo de campo detectado, salvo que el
  usuario pida explícitamente solo happy path.

## Archivos de referencia

- `references/framework-detection.md` — la señal universal (`package.json`) y el matiz puntual por
  framework (advertencia sobre el comando, veredicto de Component Testing).
- `references/edge-case-catalog.md` — la matriz tipo de campo → caso feliz + edge cases.
- `references/page-object-pattern.md` — el patrón de Page Object y los gotchas de formularios por
  framework.
- `references/authenticated-routes.md` — cómo probar flujos detrás de login: `storageState`,
  proyecto de setup, múltiples roles, y qué hacer con 2FA/SSO/CAPTCHA reales.
- `scripts/detect-framework.sh` — detección determinista de framework, gestor de paquetes y comando
  de dev server.

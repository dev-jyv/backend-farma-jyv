---
name: bambu-e2e-test-matrix
description: >
  Genera y ejecuta matrices de pruebas funcionales E2E manuales (flujo, usabilidad,
  vista/visual y casos borde) para cualquier aplicación web usando Playwright MCP, y
  opcionalmente compara contra Figma y/o corre análisis de seguridad SAST (OWASP Top 10,
  CWE Top 25, secretos, CVEs de dependencias). Ejecuta por lotes (un módulo por sub-agente;
  el orquestador solo coordina, nunca navega), graba video continuo por módulo, corre hasta
  completar todos los casos aprobados con gate de completitud (checkpoint/retomado si se
  corta) y cierra con una calificación/ranking final. Úsala cuando el usuario pida una "matriz de pruebas E2E",
  "pruebas de flujo/usabilidad", "probar un sitio", "evidencias de pruebas (video)",
  "comparar la UI contra Figma" o "análisis de seguridad/SAST del código". Es genérica:
  pregunta primero la URL del sistema, el repositorio y si hay diseño en Figma antes de
  empezar. NO modifica el código del proyecto.
---

# E2E Test Matrix (genérico)

Skill reutilizable y **auto-contenida** para levantar pruebas E2E **manuales** sobre
cualquier web. Todo se genera y guarda **en local**. Nunca modifica el código de la app
bajo prueba.

## Cuándo cargar esta skill
Cárgala cuando el usuario pida: una matriz de pruebas E2E, pruebas de flujo/usabilidad,
"probar un sitio", evidencias en video, comparar la UI contra Figma, o un análisis de
seguridad/SAST del código.

## Preparación (una sola vez por equipo)
Esta skill necesita el **Playwright MCP** con grabación de video. Configúralo una vez con el
script incluido (fija `@playwright/mcp@0.0.68` con `--save-video`, que es lo que habilita el
video, y opcionalmente registra los subagentes):

```bash
bash scripts/setup.sh
```

Detalles y alternativas manuales en `README.md`. Verifica con `/mcp` que `playwright` quede
conectado (Claude Code pide aprobar el servidor MCP la primera vez).

## Recursos incluidos (léelos cuando apliquen)
Todo vive dentro de esta carpeta de skill. Consúltalos (Read) antes de la tarea
correspondiente; no los cargues todos de entrada:

- `references/playwright-automation.md` — base técnica de navegador (localización robusta,
  esperas, diálogos/iframes/pestañas, viewport, evidencia). Léela antes de navegar o de
  delegar a un runner/explorer.
- `references/agentic-browser-testing.md` — patrón de exploración autónoma (Fase 1).
- `references/visual-testing.md` — captura consistente y comparación visual/Figma.
- `references/accessibility-testing.md` — checklist WCAG 2.1 AA.
- `references/seguridad-sast.md` — guía SAST (OWASP/CWE/secretos/CVEs).
- `references/agents/` — perfiles de los 4 subagentes (ver "Delegación" abajo).
- `assets/templates/` — plantillas de salida: `matriz-pruebas.csv`, `ESTADO-CORRIDA.md`,
  `reporte.md`.

## Delegación a subagentes
El trabajo pesado se reparte a 4 subagentes cuyos perfiles están en `references/agents/`:
`e2e-explorer` (explora sitio + repo), `e2e-runner` (ejecuta un lote/módulo y graba su
video), `e2e-visual-figma` (diff contra Figma), `e2e-security-sast` (SAST).

Para delegar, lanza un subagente (herramienta Task/Agent) con el contenido del perfil
correspondiente como instrucciones:
- Si corriste `scripts/setup.sh` con la opción de instalar agentes, estarán registrados en
  `~/.claude/agents/` y puedes invocarlos por nombre (`e2e-explorer`, etc.).
- Si no, **lee** el archivo `references/agents/<nombre>.md` y úsalo como prompt del subagente
  (subagent_type `general-purpose`). El resultado es el mismo: contexto propio por lote, el
  orquestador solo coordina.

## 0. Reglas duras (siempre)
- **No modificar el código** del proyecto bajo prueba. El repo es solo referencia de lectura.
- Trabajar en **dos fases**: primero la matriz (para aprobación), luego la ejecución.
- Toda evidencia va a una carpeta local con fecha. Nunca a la nube.
- Para flujos que requieran correo **de prueba/registro nuevo**, usar **email temporal**
  (p. ej. mail.tm / temp-mail). Esto NO aplica al login a una cuenta real administrativa
  ya existente (ver "Login con OTP" abajo): ahí se usan las credenciales reales que dé el
  usuario, porque la cuenta y su email ya están fijados de antemano.
- **Login con OTP (código por email/SMS en cada intento)**: cuando aparezca la pantalla
  que pide el código, DETENTE y pregúntale el código al usuario en el chat; espera su
  respuesta antes de continuar. Nunca inventes un código ni intentes leer la bandeja de
  correo real del usuario. Para no pedirlo una y otra vez, autentícate **una sola vez** y
  guarda el estado de sesión (ver Fase 2) para reutilizarlo; solo repite el login si la
  sesión expira de verdad o si el caso es específicamente de "sesión expirada"/re-login.
- **Evidencia en video por módulo, no screenshot suelto por caso**: la evidencia principal
  de cada caso es un **video continuo por módulo** (todos los casos de ese módulo, en
  orden, en un solo archivo). Los screenshots sueltos quedan reservados solo para
  comparación **Visual/Figma** (ahí sí hace falta una imagen fija para el diff) y para
  hallazgos de **Seguridad**. Para cualquier otro caso, en vez de tomar screenshot al
  fallar, registra la **marca de tiempo exacta** (mm:ss dentro del video del módulo).
- **No dejar casos sin ejecutar**: el objetivo es que todos los casos aprobados terminen en
  `Passed`/`Failed`/`Blocked` — ninguno debe quedar `Pendiente` salvo que el usuario limite
  el alcance. Cómo se recorre eso depende del **modo de avance** (punto 10 del intake):
  `interactivo` se detiene entre módulos a confirmar, `corrido` no para. En ambos, el gate de
  completitud (Fase 2) impide declarar terminado con pendientes. Ver sección 5 si se corta.
- Apóyate en las **guías de referencia** de esta skill (arriba): `playwright-automation`
  (patrones de navegador robustos), `agentic-browser-testing` (exploración en Fase 1),
  `visual-testing` (comparación/regresión visual) y `accessibility-testing` (a11y, WCAG 2.1 AA).
- El análisis de seguridad (SAST) es solo lectura y estático: no hagas explotación activa
  ni pruebas dinámicas contra sistemas en producción.

## 1. Intake — pregunta esto ANTES de empezar
Haz estas preguntas (agrupadas, en un solo mensaje) y espera respuesta:

1. **URL del sistema** a probar (obligatorio).
2. **¿Requiere acceso/login?** Si sí: tipo (código de gate, usuario/contraseña, OTP) y
   credenciales. Si el login pide un **código OTP por email/SMS en cada intento**, avísalo
   aquí: el código se te pedirá en vivo, en el chat, en el momento en que aparezca esa
   pantalla durante la exploración/ejecución.
3. **Ruta local del repositorio** del código fuente (opcional; para inferir casos de uso). Solo lectura.
4. **¿Hay diseño en Figma para comparar la vista?** (sí/no). Si sí: URL o archivo Figma + pantallas/nodos.
5. **Alcance**: ¿qué módulos o flujos? (o "todos").
6. **Carpeta de salida** (por defecto: `./qa/e2e/<YYYY-MM-DD>/` en el directorio actual).
7. **¿Habilitar email temporal** para flujos con correo? (sí/no).
8. **¿Incluir análisis de seguridad SAST** (OWASP Top 10, CWE Top 25, secretos y CVEs de
   dependencias)? (sí/no). Requiere ruta del repositorio (punto 3).
9. **Tamaño de lote** (casos por sub-agente/video). Por defecto **12**; techo recomendado
   **20-25**. Un módulo más grande se parte en sub-lotes. Puedes subirlo (el usuario mencionó
   ~30) pero avísale del riesgo: a más casos por lote, más riesgo de que el propio runner se
   sature antes de terminar el lote (ver nota en Fase 2). Un módulo chico entra en un solo
   lote aunque no llegue al tamaño.
10. **Modo de avance entre módulos**: `interactivo` (por defecto — al terminar cada módulo
    DETENTE, muestra su resumen y pregunta si continúas con el siguiente) o `corrido` (ejecuta
    todos los módulos sin parar; recomendado combinar con `/loop`, ver sección 5).

Si el usuario ya dio algún dato en su mensaje inicial, no lo vuelvas a preguntar.

## 2. Fase 1 — Exploración y matriz (NO ejecutar pruebas todavía)
1. Delega la exploración al subagente **`e2e-explorer`** (perfil en
   `references/agents/e2e-explorer.md`) pasándole: URL, credenciales, ruta del repo, alcance.
   El explorer navega el sitio (con Playwright MCP en modo lectura), cruza contra el repo y
   propone los casos.
2. Con lo que devuelva, construye `matriz-pruebas.csv` en la carpeta de salida con estas columnas
   (usa `assets/templates/matriz-pruebas.csv` como plantilla):

   `ID,Modulo,Titulo,Tipo,Prioridad,Precondiciones,Pasos,Datos,Resultado_esperado,Estado,Video,Marca_Tiempo,Evidencia,Notas`

   - **ID**: `E2E-<MODULO>-###` (p. ej. `E2E-COMPRA-001`).
   - **Tipo**: `Funcional` | `Flujo` | `Usabilidad` | `Visual` | `Borde` | `Negativo` |
     `Accesibilidad` | `Seguridad`.
   - **Prioridad**: `Alta` | `Media` | `Baja`.
   - **Pasos**: numerados en una sola celda (usa `\n` o ` | ` entre pasos).
   - **Estado**: dejar `Pendiente` (se llena en la Fase 2).
   - **Video**: vacío por ahora. En Fase 2 será el nombre del archivo de video del módulo
     (ej. `USR.mp4`) — todos los casos de un mismo módulo comparten el mismo archivo.
   - **Marca_Tiempo**: vacío por ahora. En Fase 2: `mm:ss` donde inicia ese caso dentro del
     video del módulo y, si falló, `mm:ss` del fallo (formato `inicio / fallo`, ej. `02:15`
     o `02:15 / 03:40`).
   - **Evidencia**: vacío. Solo se llena para casos **Visual/Figma** (rutas de screenshots
     real y de referencia) o **Seguridad** (ruta al reporte). El resto de casos deja este
     campo vacío porque su evidencia vive en Video + Marca_Tiempo.
3. Cubre **casos borde** de verdad: campos vacíos/límite, formatos inválidos, doble clic,
   sesión expirada, back del navegador, recarga a mitad de flujo, datos duplicados,
   sin stock/agotado, red lenta/timeout, pago rechazado, cantidades máximas/mínimas.
4. Incluye casos de **usabilidad y vista** (estados de carga, errores visibles,
   responsividad, foco, textos, y —si hay Figma— fidelidad al diseño). Incluye también
   casos de **accesibilidad** (contraste, labels, navegación por teclado, ARIA) usando la
   guía `references/accessibility-testing.md` como checklist.
5. **DETENTE aquí.** Muestra la tabla resumen al usuario y pide aprobación explícita
   antes de ejecutar nada.

## 3. Fase 2 — Ejecución (solo con aprobación, corre hasta terminar TODOS los casos)

> **Regla de oro de la ejecución: el orquestador NO navega el sitio en su propio contexto.**
> Ejecutar decenas de casos en el contexto del orquestador lo satura y la corrida se corta
> a medias (así se quedaron 116 casos pendientes en una corrida real). El orquestador solo
> **coordina**: reparte lotes a sub-agentes `e2e-runner`, recibe resúmenes compactos y
> actualiza CSV + `ESTADO-CORRIDA.md`. Toda la navegación pesada vive en los runners, cada
> uno con su propio contexto.

**Abrir la sesión de ejecución** (patrón loop, ver sección 5):
1. Lee `ESTADO-CORRIDA.md` si ya existe (retomado) o créalo si es la primera corrida (usa
   `assets/templates/ESTADO-CORRIDA.md`). De él sale cuál es el **módulo activo** y qué
   módulos ya están completos — no re-ejecutes esos.
2. **Arma los lotes**: agrupa los casos aún `Pendiente` por **Módulo**, respetando el orden
   de la matriz. Un lote = un módulo. Si un módulo supera el **tamaño de lote** (punto 9 del
   intake, por defecto 12; techo recomendado 20-25), pártelo en sub-lotes numerados
   (`AUTH-1`, `AUTH-2`, …) para que cada uno quepa cómodo en el contexto de UN runner. Cada
   lote produce su propio video (un módulo de un solo lote → `AUTH.<ext>`; partido →
   `AUTH-1.<ext>`, `AUTH-2.<ext>`).
   - **Por qué un techo y no "todo el módulo aunque sean 33":** un sub-agente tiene su propio
     presupuesto de contexto (por eso 12 casos en un runner sí caben aunque 33 en el
     orquestador principal lo saturaran), pero **no es infinito**: cada caso de navegación
     real gasta contexto (snapshots, pasos). Cerca de ~25-30 casos un runner también puede
     saturarse y cortar el lote a media. Por eso el default es conservador y los módulos
     grandes se parten. Subir el tamaño a ~30 es posible pero es el usuario aceptando ese
     riesgo; si un runner corta un lote, se retoma igual (paso 5) — no se pierde nada, solo
     conviene el tamaño chico para evitarlo.
3. Autentícate una sola vez (gate/login/OTP según punto 2 del intake) y, en cuanto tengas
   sesión válida, guarda el estado de sesión (cookies/localStorage — "storage state" de
   Playwright) en `<salida>/.auth/session.json`. Cada runner abrirá su navegador cargando
   ese storage state, así entra ya autenticado **sin repetir OTP**.
   - **No hace falta iniciar sesión por cada caso ni por cada módulo.** Mientras la app
     persista la sesión en cookies/localStorage (caso común; p. ej. si guarda un token o
     refresh token en `localStorage`), recargar el storage state basta para saltarse el
     login completo. El OTP solo se vuelve a pedir si la sesión **expira de verdad** (paso 5)
     o si un caso es específicamente de re-login/sesión expirada.
   - Solo si una app concreta atara la sesión a algo NO persistido en el storage (y por eso
     re-pidiera OTP al reabrir el navegador), entonces sí habría que pedir el código por
     lote; en ese caso, díselo al usuario al inicio y usa modo `interactivo` para que el OTP
     se pida de forma ordenada al abrir cada lote.

Crea la estructura de salida:

```
<salida>/
├── matriz-pruebas.csv      # el "GOALS" de la corrida: módulos = metas, casos = entregables
├── ESTADO-CORRIDA.md       # el "MEMORY" de la corrida: dónde vamos, qué sigue (ver sección 5)
├── .auth/
│   └── session.json       # storage state: evita repetir login/OTP entre módulos
├── videos/
│   └── <MODULO>.<ext>     # UN video continuo por módulo, con todos sus casos en orden
├── screenshots/            # solo para casos Visual/Figma (imagen fija para el diff)
├── seguridad/              # solo si se habilitó SAST
│   ├── semgrep-report.json / .txt
│   ├── osv-report.json / npm-audit.json
│   └── seguridad-reporte.md
└── reporte.md
```

Por cada **lote** (módulo o sub-lote, en el orden de la matriz):
1. **Delega el lote completo al subagente `e2e-runner`** (perfil en
   `references/agents/e2e-runner.md`; un runner por lote, contexto propio). Pásale: la lista
   de casos del lote, la ruta de `.auth/session.json` y el nombre del video del lote. El
   runner abre su navegador, graba UN video continuo del lote, ejecuta todos sus casos en
   orden y te devuelve un resumen compacto: por cada caso su `Estado`, `Marca_Tiempo` y
   `Notas`, más la ruta del video.
2. **Concurrencia baja a propósito**: corre los lotes de forma secuencial, o como máximo 2 a
   la vez. No es por límite de Claude — es porque el sistema bajo prueba suele tener datos y
   sesión **compartidos y reales**; varios navegadores a la vez con la misma cuenta se
   pisan y corrompen datos. La cobertura total se logra por continuidad (sección 5), no por
   paralelismo agresivo.
3. **Casos Visual/Figma**: el runner los marca pero no hace el diff. Deriva esos a
   **`e2e-visual-figma`** (perfil en `references/agents/e2e-visual-figma.md`; toma
   screenshots real + referencia de Figma, porque el diff visual necesita imagen fija).
4. **Vuelca el resumen al CSV**: por cada caso del lote actualiza `Estado`, `Video`,
   `Marca_Tiempo`, `Evidencia` (solo Visual/Figma o Seguridad) y `Notas`.
5. Si el runner reporta que la sesión expiró a mitad del lote: pide el OTP nuevo al usuario,
   regenera `.auth/session.json`, y re-delega **solo los casos del lote que quedaron sin
   ejecutar** (no repitas los ya hechos).
6. **Cierra el lote (checkpoint)**: actualiza `ESTADO-CORRIDA.md` — marca ese lote/módulo
   completo, apunta el siguiente como activo, escribe "qué sigue". El checkpoint por lote es
   lo que hace que un corte pierda a lo sumo el lote en curso, no toda la corrida.
7. **Punto de control entre módulos** (según el modo de avance, punto 10 del intake):
   - `interactivo` (por defecto): DETENTE, muestra el resumen del módulo recién terminado
     (passed/failed/blocked + enlace a su video) y **pregunta si continúas con el siguiente
     módulo**. No sigas sin el "sí". Así el humano revisa módulo a módulo y se evita cualquier
     saturación acumulada.
   - `corrido`: sigue directo con el siguiente lote sin preguntar (ideal con `/loop`).

**Gate de completitud (antes de declarar terminado):** cuenta los casos con
`Estado=Pendiente` en el CSV. Si es **> 0**, la corrida NO está terminada — sigue con el
siguiente lote (o, si el turno se agota, deja el estado real y retoma vía sección 5). Solo
declara la corrida completa cuando `Pendiente == 0`. Nunca cierres con pendientes en
silencio ni marques como ejecutado algo que no corrió.

## 3bis. Fase 3 (opcional) — Seguridad SAST
Si el usuario habilitó el análisis de seguridad (punto 8 del intake) y hay ruta de repo:
1. Delega al subagente **`e2e-security-sast`** (perfil en
   `references/agents/e2e-security-sast.md`) pasándole la ruta del repo y la carpeta de
   salida. Corre en paralelo/independiente de la ejecución funcional (no bloquea Fase 2).
   Apóyate en `references/seguridad-sast.md`.
2. El subagente usa `semgrep` (OWASP Top 10, CWE Top 25, secretos) y `osv-scanner`/`npm audit`
   (CVEs de dependencias) si están disponibles; si no, reporta la limitación explícitamente.
3. Añade sus hallazgos como filas `Tipo=Seguridad` en `matriz-pruebas.csv` (con `Evidencia`
   apuntando al reporte) y guarda su reporte detallado en
   `<salida>/seguridad/seguridad-reporte.md`.

## 4. Notas de configuración
- **Playwright MCP**: esta skill graba video usando `@playwright/mcp@0.0.68` con
  `--save-video=1280x800` (esa versión/flag es la que habilita el video). Configúralo con
  `scripts/setup.sh` o manualmente (ver `README.md`). Verifica las tools con `/mcp`.
- **Directorio de trabajo del MCP vs. carpeta de salida**: el `--output-dir` del MCP es solo
  un directorio de trabajo temporal. La skill **organiza y mueve** la evidencia final a la
  carpeta de salida de la corrida (`<salida>/videos/<MODULO>.<ext>`, `screenshots/`). No dejes
  la evidencia final en el directorio del MCP.
- Si tu servidor MCP solo graba toda la sesión en un único archivo (no por contexto/módulo),
  usa esa grabación única como `<salida>/videos/completo.<ext>` y registra igual la
  `Marca_Tiempo` de cada caso dentro de ese archivo — la mecánica es la misma, solo cambia
  cuántos archivos de video terminas teniendo. Si ni siquiera eso está disponible, usa
  trace + una única captura por hito como respaldo y anótalo como limitación.
- **Figma MCP** (opcional, solo para comparación visual): requiere Figma Desktop con Dev Mode
  MCP activo. Si vas a comparar contra diseño, regístralo (ver `README.md`) y confirma sus
  tools con `/mcp`.
- **Tools de los subagentes**: por defecto heredan las tools de la sesión. Si restringes
  `tools:` en un perfil de agente, incluye los nombres reales del MCP (revisa `/mcp`).

## 5. Continuidad — loop + memoria persistente (no dejar pruebas pendientes)

Patrón adoptado de la metodología **bambu-goals-loop** (memoria persistente + loop de
sesión), aterrizado a una corrida de QA. La matriz (`matriz-pruebas.csv`) hace de "GOALS"
—los módulos son las metas, los casos con su `Estado` son los entregables con checkbox— y
`ESTADO-CORRIDA.md` hace de "MEMORY": el estado vivo entre sesiones.

**El loop de cada sesión de ejecución:**
- **Abrir**: lee `ESTADO-CORRIDA.md` + el CSV. Identifica el módulo activo y los casos aún
  `Pendiente`. Trabaja solo eso; no re-ejecutes lo ya cerrado.
- **Trabajar**: ejecuta módulo por módulo, con checkpoint al cerrar cada módulo (paso 6 de
  Fase 2). Pasos chicos y verificables — un módulo a la vez, no 151 casos de un tirón.
- **Cerrar**: actualiza `ESTADO-CORRIDA.md` (módulos completos, módulo activo, "qué sigue")
  y deja el CSV con el progreso real.

**Regla dura (de bambu-goals-loop): lo no ejecutado se registra como `Pendiente` explícito,
nunca en silencio y nunca como hecho.** El objetivo es dejar **cero** `Pendiente` de los
aprobados; si un corte lo impide, el estado real queda visible al frente, no enterrado.

**Retomar manualmente**: pide *"continúa la matriz pendiente en `<salida>`"* — se lee
`ESTADO-CORRIDA.md` + CSV y se sigue desde el módulo activo, sin repetir lo cerrado.

**Retomar automático** (sin pedirlo cada vez): envuelve con el comando `/loop` de Claude
Code, ej. `/loop 20m continúa la matriz pendiente en <salida>` — se re-invoca en intervalos
hasta que no queden casos `Pendiente`.

## 6. Calificación y ranking
Al cerrar una corrida (completa o parcial), calcula y añade a `reporte.md` una sección de
calificación (usa `assets/templates/reporte.md` como base):

- **Puntaje por caso**: `Passed` = 100, `Blocked` = 50, `Failed` = 0. Los `Pendiente` NO
  entran al cálculo de calificación (solo afectan a "Cobertura", abajo).
- **Peso por prioridad**: `Alta` = 3, `Media` = 2, `Baja` = 1.
- **Score por categoría** (`Tipo`): promedio ponderado por prioridad de los casos
  ejecutados de ese tipo → `Σ(puntaje × peso) / Σ(peso)`. Calcúlalo para Funcional/Flujo,
  Usabilidad, Visual y Accesibilidad (Borde/Negativo se cuentan dentro del tipo base del
  caso, no aparte).
- **Score de Seguridad** (si se corrió SAST): 100 menos penalización por hallazgo según
  severidad — Crítica −40, Alta −20, Media −10, Baja −5 (piso 0). Es independiente del
  score funcional, no se mezcla en el promedio global.
- **Score global**: promedio ponderado por prioridad de todos los casos ejecutados
  (excluyendo Seguridad, que se reporta aparte).
- **Cobertura**: `ejecutados / total_aprobados`. Repórtala siempre junto al score, dejando
  explícito que el score solo refleja lo efectivamente ejecutado — una corrida con
  cobertura baja no se lee como "el sistema califica alto" sin esa salvedad.
- **Clasificación** por score global: `A` (≥90) | `B` (75–89) | `C` (60–74) | `D` (<60).
- **Ranking por módulo**: lista los módulos ordenados de peor a mejor score, para
  priorizar dónde atacar primero.

`reporte.md` final debe incluir: cobertura y conteo por estado (passed/failed/blocked/
pendiente), lista de bugs con su `Video` + `Marca_Tiempo`, hallazgos de usabilidad/visual/
accesibilidad, resumen de seguridad si aplica, y la sección de **Calificación y ranking**.

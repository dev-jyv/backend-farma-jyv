# Referencia: Playwright Automation

> Guía técnica de apoyo del skill `bambu-e2e-test-matrix`. La consultan el orquestador y los
> subagentes (`e2e-explorer`, `e2e-runner`, `e2e-visual-figma`) como referencia de cómo
> interactuar con el navegador de forma robusta vía Playwright MCP. No es un flujo de
> principio a fin por sí sola.

## 1. Localización de elementos (de más a menos robusto)
1. Rol + nombre accesible: usa `browser_snapshot` (accessibility tree) antes de clicar o
   llenar, y referencia elementos por su `ref` del snapshot.
2. Texto visible único.
3. `label` / `placeholder` / `aria-label` para inputs.
4. `data-testid` si el proyecto lo expone.
5. Evita CSS/XPath frágiles (nth-child, clases generadas). Si no queda otra opción,
   anótalo como deuda técnica en el reporte porque se rompe ante cambios de estilos.

## 2. Esperas y estabilidad
- Nunca uses esperas fijas (`sleep(N)`) como primera opción: espera por estado (elemento
  visible/habilitado, navegación completada, red en idle).
- Tras cada navegación o submit, vuelve a tomar `browser_snapshot` — el DOM cambió y los
  `ref` anteriores dejan de ser válidos.
- Ante un fallo transitorio, reintenta una vez antes de marcar el paso como fallido; si el
  segundo intento también falla, es un fallo real.

## 3. Diálogos, popups, iframes, pestañas nuevas
- Diálogos nativos (alert/confirm/prompt): resuélvelos con la tool de diálogo del MCP
  antes de que bloqueen la ejecución.
- Popups/pestañas nuevas (ej. login con proveedor externo): usa la tool de pestañas del
  MCP para listar/cambiar de pestaña; no asumas que la acción sigue en la pestaña original.
- Contenido en iframe: verifica que el elemento objetivo esté en el frame correcto antes
  de interactuar (el snapshot incluye frames).

## 4. Viewport y dispositivo
- Define el viewport explícitamente por caso cuando el módulo lo requiera (desktop,
  tablet, mobile). No mezcles viewports dentro del mismo caso sin anotarlo.
- Para pruebas de responsividad, repite el mismo flujo en al menos 2 breakpoints.

## 5. Evidencia (video / trace / screenshots)
- **Esta skill usa el Playwright MCP fijado en `@0.0.68` con `--save-video=1280x800`**
  (configúralo con `scripts/setup.sh`), que es la versión/flag que habilita la grabación de
  video. Verifica antes de empezar que el servidor esté activo (`/mcp`). Si el video por
  contexto no está disponible, usa trace + screenshot por hito como respaldo y anótalo.
- El `--output-dir` del MCP es un directorio de trabajo temporal; la evidencia final se
  mueve a `<salida>/videos/` y `<salida>/screenshots/`.
- Screenshots de evidencia: full page a resolución completa, salvo que el caso pida
  explícitamente el estado del viewport visible.
- Nombra archivos de forma trazable al caso: `<ID-caso>-<paso>-<estado>.png`.

## 6. Datos de prueba
- Para flujos con correo, usa un servicio de email temporal (mail.tm o similar). Nunca
  correos reales.
- No ejecutes pagos/compras/acciones irreversibles reales salvo autorización explícita
  del usuario; si es simulación, detente en el paso previo a confirmar y anótalo.

## 7. Cuando algo falla
- Screenshot en alta resolución del estado exacto del fallo (no de un estado posterior).
- Registra el mensaje de error visible en pantalla y, si hay consola JS/red disponible en
  el MCP, adjunta el error técnico relevante (no el log completo).

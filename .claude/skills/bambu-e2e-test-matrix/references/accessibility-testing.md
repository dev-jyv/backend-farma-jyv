# Referencia: Accessibility Testing (WCAG 2.1 AA)

> Guía técnica de apoyo del skill `bambu-e2e-test-matrix` para evaluar accesibilidad de una
> pantalla/flujo web. Solo lectura: no modifica código, solo reporta hallazgos con
> severidad y criterio WCAG. Úsala en casos de tipo Accesibilidad.

## 1. Si `axe-core` está disponible
- Inyecta axe-core en la página (vía la tool de evaluación JS del Playwright MCP,
  cargando `axe.min.js` e invocando `axe.run()`).
- Recoge los `violations` devueltos: `id`, `impact` (critical/serious/moderate/minor),
  `description`, `nodes` (selector + snippet HTML) y el criterio WCAG asociado (en
  `tags`, ej. `wcag2aa`, `wcag143`).
- Si no se puede inyectar axe-core (CSP, MCP sin `evaluate`, etc.), repórtalo como
  limitación y usa el checklist manual de la sección 2.

## 2. Checklist manual (si no hay axe-core o como complemento)
- **Contraste**: texto normal ≥ 4.5:1, texto grande (≥18pt o ≥14pt bold) ≥ 3:1 contra su
  fondo. Revisa visualmente los pares más sospechosos (texto claro sobre fondo claro,
  placeholders, texto deshabilitado).
- **Imágenes**: toda `<img>` informativa tiene `alt` descriptivo; decorativas usan `alt=""`.
- **Formularios**: cada input tiene `label` asociado (`for`/`id` o envolvente), o
  `aria-label`/`aria-labelledby`. Mensajes de error asociados al campo
  (`aria-describedby`) y no dependen solo del color.
- **Teclado**: todo control interactivo es alcanzable y operable solo con teclado (Tab/
  Shift+Tab/Enter/Espacio/Escape). Sin trampas de foco. Orden de tabulación sigue el
  orden visual lógico.
- **Foco visible**: el estado `:focus` es visualmente distinguible.
- **Encabezados**: jerarquía de `<h1>-<h6>` sin saltos, un solo `h1` por vista.
- **Roles/ARIA**: componentes custom (modales, dropdowns, tabs, acordeones) exponen el rol
  y estado ARIA correcto (`role`, `aria-expanded`, `aria-selected`, `aria-modal`, etc.).
- **Modales**: al abrir, el foco se mueve dentro del modal; al cerrar, regresa al elemento
  que lo abrió; `Escape` cierra el modal.

## 3. Severidad
- **Crítica**: bloquea completamente el uso con teclado o lector de pantalla.
- **Alta**: incumplimiento claro de WCAG AA con impacto real (contraste insuficiente,
  falta de label en input obligatorio).
- **Media**: incumplimiento con impacto parcial (jerarquía de encabezados incorrecta).
- **Baja**: mejora recomendada sin incumplimiento estricto de AA.

## 4. Reporte
- Tabla: `ID,Elemento/Pantalla,Criterio WCAG,Severidad,Descripción,Cómo reproducir,Sugerencia`.
- Si se usa dentro de `bambu-e2e-test-matrix`, añade filas con `Tipo=Usabilidad` o crea una
  sección aparte de accesibilidad en `reporte.md` con el resumen por severidad.

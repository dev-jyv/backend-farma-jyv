# Referencia: Visual Testing

> Guía técnica de apoyo del skill `bambu-e2e-test-matrix`. La usa el subagente `e2e-visual-figma`
> (y el orquestador) cuando el caso es de tipo Visual. Solo lectura: reporta diferencias,
> no modifica la app ni el diseño.

## 1. Captura consistente (requisito para poder comparar)
- Mismo viewport en cada corrida para el mismo caso (ancho x alto exactos), full page.
- Espera a que la página esté "quieta": sin animaciones en curso, fuentes e imágenes
  cargadas, sin spinners visibles — de lo contrario el diff da falsos positivos.
- Enmascara u oculta contenido no determinista antes de capturar si es posible (fecha/hora
  actual, IDs generados, contadores en vivo, anuncios); si no se puede ocultar, anótalo
  como ruido conocido en vez de reportarlo como diferencia real.

## 2. Comparación contra baseline (regresión visual)
- Primera corrida de un caso: la captura se guarda como baseline (`<ID>-baseline.png`) y
  el caso queda `Passed` por definición (no hay contra qué comparar).
- Corridas siguientes: compara contra el baseline existente. Si no hay herramienta de diff
  de píxeles disponible, compara visualmente ambas imágenes y describe diferencias
  concretas (posición, tamaño, color) en vez de dar un veredicto genérico.
- Un baseline solo se reemplaza si el usuario aprueba explícitamente el cambio visual
  (ej. un rediseño intencional). Nunca lo sobrescribas silenciosamente.

## 3. Comparación contra Figma
- Iguala la resolución/viewport de la captura real a la del frame de Figma antes de
  comparar (si el frame es de un tamaño de diseño distinto, indícalo).
- Clasifica cada diferencia: layout/espaciado, color, tipografía, contenido/textos,
  estados (hover/focus/error no representados en Figma), componentes faltantes o
  desalineados.
- Severidad: Alta (rompe usabilidad o muy visible), Media (perceptible pero no crítica),
  Baja (detalle menor, ej. 1-2px de espaciado).

## 4. Responsividad
- Repite la captura en al menos: mobile (~375px), tablet (~768px) y desktop (~1440px)
  para pantallas críticas o casos de tipo Visual sin viewport fijo.
- Reporta por separado si una diferencia solo ocurre en un breakpoint específico.

## 5. Reporte
- Cada hallazgo visual: `ID caso, breakpoint, categoría, severidad, descripción, ruta de
  screenshot(s) comparados`.
- Veredicto final por caso: `Passed` (fiel al baseline/diseño) o `Failed` (diferencias de
  severidad Media/Alta encontradas).

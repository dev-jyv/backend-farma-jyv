# Patrón de Page Object y gotchas por framework

## El patrón

Un Page Object por pantalla o componente relevante, con:

- **Locators por rol y nombre accesible primero** (`getByRole('textbox', { name: '...' })`,
  `getByRole('button', { name: '...' })`). Esto hace que cada test sea también una aserción implícita
  de accesibilidad: si Playwright no encuentra el campo por su nombre accesible, un lector de pantalla
  tampoco lo encontraría.
- `data-testid` **solo si el proyecto ya lo usa**. Confirma con `grep -r data-testid` en el código
  fuente del proyecto target antes de decidir. No lo introduzcas en un proyecto que no lo tiene, y no
  lo evites en uno que sí lo tiene por convención propia.
- Métodos que representan acciones de usuario completas (`submitEmail(email)`,
  `addItemAndFill(data)`), no exposición cruda de cada locator sin contexto — aunque los locators
  individuales también se exponen como propiedades públicas para aserciones directas desde el spec.
- Nada de lógica de aserción dentro del Page Object: las aserciones (`expect(...)`) viven en el spec,
  el Page Object solo navega e interactúa.

## Verificar en vivo antes de escribir — por qué importa

El código de un componente es una hipótesis sobre su comportamiento, no la verdad. Dos ejemplos reales
encontrados escribiendo specs para una app Angular con Signal Forms, que una lectura superficial del
código habría predicho al revés:

- Un campo marcaba su error visualmente solo bajo `touched() && invalid()`, lo que sugería que un
  click en "enviar" con el campo intacto no lo dispararía — pero el framework de formularios marca
  `touched` en **todo el árbol** del formulario al intentar el submit, antes de evaluar si la acción
  corre. El click sí revela el error, sin necesidad de forzar un blur.
- Un formulario con autoguardado debounced (800ms) parecía inofensivo para el flujo de envío — hasta
  que se confirmó que la acción de "enviar" no toma los datos del formulario en memoria, sino lo
  último que el autoguardado alcanzó a persistir. Enviar antes de que el debounce complete produce un
  envío con datos viejos o vacíos, sin ningún aviso en la UI. Esto solo se descubre corriendo el
  flujo rápido de verdad (con `fill()`/`click()` reales, no explorando a mano con un MCP que por su
  propio overhead da tiempo de sobra) — si un flujo tiene autoguardado, siempre probar qué pasa al
  enviar inmediatamente después de la última edición, antes de asumir que hay tiempo suficiente.

La lección general: **cualquier retraso (debounce, llamada async, animación) es candidato a una
condición de carrera con la siguiente acción del usuario.** Confírmalo explícitamente en vez de
asumir que "sale en el orden en que lo escribí".

## Gotchas de eventos sintéticos por framework

Estos afectan cómo escribir interacciones en el spec, no solo cómo leerlas:

- **React (inputs controlados)**: un input con `value` + `onChange` no refleja un cambio si se le
  asigna `.value` por fuera de React (p. ej. dentro de un `page.evaluate()`). Usa siempre `fill()` o
  `type()` de Playwright — disparan eventos de teclado/input reales que React sí procesa. Nunca
  manipules el DOM manualmente para "ahorrarte" una interacción.
- **Vue (`v-model`)**: mismo problema de fondo que React — `fill()`/`type()` normales funcionan bien
  porque disparan el evento `input` nativo que `v-model` escucha; el riesgo aparece solo si el test
  intenta forzar un valor vía `page.evaluate()`.
- **Angular con `@angular/forms/signals`**: un `<select>` con `[formField]` escucha el evento
  `input` para sincronizar, no `change`. Un `dispatchEvent(new Event('change'))` sintético dentro de
  un test deja el modelo desincronizado del DOM sin ningún error — pero `selectOption()` de
  Playwright ya dispara ambos eventos, así que es seguro en uso normal; el peligro es solo con
  `page.evaluate()` manual.
- **Angular con Reactive Forms clásico**: confirma el `updateOn` del control (`'change'` por default,
  pero puede ser `'blur'` o `'submit'`) antes de asumir en qué momento aparece un error de validación.
- **Componentes de select/dropdown custom (no `<select>` nativo)**: muchos design systems (CDK
  Overlay de Angular Material, Radix/Headless UI en React, Headless UI en Vue) implementan su propio
  listbox flotante. El patrón de interacción es: click en el trigger (rol `combobox`) para abrir,
  luego click en la opción (rol `option`) que aparece — normalmente **fuera** del árbol DOM del
  trigger (en un overlay adjunto al body), así que el Page Object no debe asumir que la opción es hija
  del combobox en el DOM.

## Qué confirmar siempre en vivo (checklist corta)

1. Nombre accesible real de cada campo (rol + texto del label) — no el que parece obvio por el HTML.
2. Condición exacta bajo la que aparece cada mensaje de error.
3. Si hay retrasos (debounce, red, animaciones) y si alguno compite con la siguiente acción del
   usuario.
4. Si un combobox/select es nativo o un widget custom con overlay.
5. El texto exacto de botones que cambian según estado (p. ej. "Enviar" → "Enviando…") para no usar
   un nombre accesible que deje de matchear a mitad de la interacción.

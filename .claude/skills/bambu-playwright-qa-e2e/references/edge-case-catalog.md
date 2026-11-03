# Catálogo de edge cases por tipo de campo

Para cada campo que el Paso 1 de `SKILL.md` confirmó en vivo, usa la entrada correspondiente. Cada
caso lista el valor a probar y el resultado esperado en genérico ("bloquea + mensaje" o "acepta") —
el mensaje exacto y el mecanismo de bloqueo (disabled, error inline, toast) hay que confirmarlos en
vivo, no asumirlos de esta tabla.

No apliques una entrada completa si el Paso 1 no confirmó que esa validación existe: si un campo de
texto libre no tiene límite de longitud, no inventes un caso que lo pruebe.

## Email

| Caso | Valor de ejemplo | Esperado |
|---|---|---|
| Feliz | `nombre@dominio.com` | Acepta |
| Sin `@` | `nombredominio.com` | Bloquea |
| Sin dominio | `nombre@` | Bloquea |
| Sin TLD | `nombre@dominio` | Bloquea (confirmar: algunos validadores lo aceptan) |
| Espacios al inicio/final | ` nombre@dominio.com ` | Confirmar si recorta (`trim`) o bloquea |
| Mayúsculas | `NOMBRE@DOMINIO.COM` | Confirmar si normaliza a minúsculas o lo deja igual |
| Vacío | `` | Bloquea si el campo es requerido |
| Múltiples `@` | `a@b@dominio.com` | Bloquea |

## Teléfono

| Caso | Valor de ejemplo | Esperado |
|---|---|---|
| Feliz | Formato local válido del proyecto (confirmar cuántos dígitos espera) | Acepta |
| Letras mezcladas | `55abc12345` | Bloquea |
| Menos dígitos de los esperados | Un dígito menos que el formato válido | Bloquea |
| Más dígitos de los esperados | Uno o más dígitos de más | Bloquea, o confirmar si trunca |
| Símbolos no permitidos | `55-1234-567#` | Bloquea (confirmar si `+`, `-`, espacios sí se permiten — varía mucho por proyecto) |
| Vacío | `` | Bloquea si el campo es requerido |

## Numérico / monto

| Caso | Valor de ejemplo | Esperado |
|---|---|---|
| Feliz | Un valor típico dentro de cualquier rango conocido | Acepta |
| Negativo | `-100` | Bloquea si el dominio no permite negativos |
| Cero | `0` | Bloquea si el dominio exige un valor positivo real (p. ej. un monto de gasto) |
| Letras | `abc` | Bloquea, o confirmar si el input numérico del navegador ya lo impide a nivel de teclado (en cuyo caso el test verifica que el campo sigue vacío, no un mensaje de error) |
| Decimales de más | `10.999` en un campo de 2 decimales | Bloquea, o confirmar si trunca/redondea |
| Límite superior exacto | El tope conocido, y tope + 1 | El tope exacto acepta; tope + 1 bloquea (si el Paso 1 confirmó un tope real) |
| Límite inferior exacto | El mínimo conocido, y mínimo − 1 | Idéntico razonamiento que el límite superior |

## Fecha

| Caso | Valor de ejemplo | Esperado |
|---|---|---|
| Feliz | Una fecha dentro de cualquier ventana válida conocida | Acepta |
| Futura | Mañana, si el dominio no permite fechas futuras | Bloquea |
| Fuera de una ventana cerrada | Un día antes de que abra, o después de que cierre, si existe esa regla | Bloquea con el mensaje que indique cuándo sí se puede |
| Formato inválido escrito a mano | Si el input permite texto libre (no solo un date picker), un formato no reconocible | Bloquea |
| Límite exacto de la ventana | El primer/último día válido | Acepta (si el Paso 1 confirmó los límites exactos) |

## Texto con longitud máxima

| Caso | Valor de ejemplo | Esperado |
|---|---|---|
| Feliz | Un texto típico, bien por debajo del límite | Acepta |
| Exactamente en el límite | Una cadena de longitud igual al máximo confirmado | Acepta |
| Un carácter sobre el límite | Longitud máxima + 1 | Bloquea, o confirmar si el input trunca en vez de bloquear |
| Vacío | `` | Bloquea si el campo es requerido |
| Solo espacios en blanco | `   ` | Confirmar si cuenta como vacío (muchos validadores de "requerido" no hacen `trim` antes de chequear) |

## Select / combobox

| Caso | Esperado |
|---|---|
| Feliz | Seleccionar una opción válida del catálogo real (confirmado en vivo, no inventado) acepta |
| Sin selección | Bloquea si el campo es requerido y no trae un valor por default |
| Catálogo dinámico | Si las opciones vienen de una API/catálogo, confirmar que las que se ven en vivo son las que el test usa — no hardcodear una opción que puede no existir en otro ambiente |

## Checkbox / radio obligatorio

| Caso | Esperado |
|---|---|
| Feliz | Marcado, permite continuar |
| Sin marcar | Bloquea el submit si es obligatorio (términos y condiciones, confirmaciones) |

## Archivo

| Caso | Esperado |
|---|---|
| Feliz | Tipo y tamaño dentro de lo permitido (confirmar los límites exactos en vivo) | Acepta |
| Tipo de archivo no permitido | Un archivo de un tipo distinto al aceptado | Bloquea |
| Tamaño excedido | Un archivo más grande que el límite confirmado | Bloquea |
| Sin archivo | Si el campo es requerido, intentar continuar sin adjuntar nada | Bloquea |

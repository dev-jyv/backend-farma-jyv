# Taxonomía de breaking changes

Un cambio es **breaking** para el frontend si un cliente que integró contra la versión anterior deja de funcionar sin cambios en su código.

## Breaking

- Endpoint eliminado, o su path/método HTTP cambiado.
- Campo de **response** eliminado o renombrado.
- Campo de **request** que pasó de opcional a requerido, o fue eliminado mientras el backend seguía esperándolo con otro nombre.
- Tipo de un campo cambiado (ej. `string` → `number`, objeto → array).
- Valor de enum **eliminado** (rompe un `switch`/mapeo en frontend).
- Guard de autenticación agregado a un endpoint que antes era público, o requisito de rol/plataforma más estricto (ej. `@AuthCustomerOnly()` → requiere un rol distinto).
- Código de status de éxito cambiado (ej. `200` → `201`).

## Aditivo (no breaking, pero vale la pena listar)

- Campo nuevo opcional en request.
- Campo nuevo en response.
- Endpoint nuevo.
- Valor **nuevo** de enum (agregar, no quitar).
- Relajar una validación (requerido → opcional).

## Caso especial: posible rename

Un campo que desaparece de un lado del diff y aparece otro con shape similar (mismo tipo, validadores parecidos) en el mismo método casi siempre es un rename, no dos cambios independientes (una eliminación + una adición). Señálalo explícitamente como "posible rename de `<campoViejo>` → `<campoNuevo>`" en vez de reportarlo como dos entradas separadas — ayuda al frontend a entender la intención real del cambio.

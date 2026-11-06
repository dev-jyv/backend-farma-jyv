# Mejoras al POS: ventas, entradas y compras

Auditoría del 2026-11-06 sobre el POS (`farma-jyv-pos`) y el backend (`backend-farma-jyv`), de solo lectura. Objetivo: encontrar lo que hace fallar ventas, entradas y compras legítimas, o lo que las deja inconsistentes.

Convención de rutas:

- `back:` es relativo a `backend-farma-jyv/functions/src/`.
- `pos:` es relativo a `farma-jyv-pos/`.

Las líneas citadas corresponden al código a la fecha de la auditoría.

## Cómo está construido

- **POS local-first.** Electron + SQLite (Prisma). La venta se cobra y se guarda en local. El auto-push la sube en ≤30 s por `POST /v1/sales/bulk` (`offline: true`), en orden catálogo → entradas → ventas. El catálogo y el stock de otras cajas solo bajan a las 10:30, 14:00 y 20:00, o con "Sincronizar".
- **Backend.** `createSale` corre en una transacción de Firestore: FEFO por lote, idempotencia `<cashierId>:<key>`, promociones y cupones, controlados, folio y turno.
- **Venta que el servidor rechaza.** Si el error menciona "stock", "lote" o "producto no encontrado", el POS la manda a `unreconciledSales`. Si no, queda bloqueada en el panel "Rechazados".
- **Regla de oro actual.** Una venta offline no se rechaza por promoción o cupón vencido: se acepta y se marca para revisión.
  - **El problema central:** esa regla no se aplica a stock, caducidad, catálogo inactivo ni turno cerrado. En esos casos una venta ya cobrada termina rechazada, y de ahí sale la mayoría de los fallos.

## Principios propuestos

1. **Una venta cobrada nunca se rechaza: se registra y se marca.** Igual que `promotionReview` / `couponReview`, con `stockShortfall`, `catalogReview` y `lateSync`.
2. **Los errores se clasifican por código, no por texto.** Códigos como `STOCK_INSUFFICIENT`, `SESSION_CLOSED`, `CATALOG_INACTIVE`, `ENTRY_IN_PROGRESS`, más `retryable: true` en los transitorios. Hoy el POS decide con `includes('stock')` (`pos: src/app/features/pos/services/sale.service.ts:849-857`).
3. **La identidad y la hora son de quien cobró y cuándo cobró**, no de quien sincroniza ni de cuándo llegó.

## A. Ventas

### A1 (P0): el reintento de una venta ya confirmada responde "Stock insuficiente"

- **Dónde:** `back: services/sales.service.ts:769`. FEFO valida antes de la revisión de idempotencia (`:1070`).
- **Escenario:**
  1. Se venden las últimas 2 piezas.
  2. La transacción confirma, pero la respuesta se pierde.
  3. El reintento con la misma llave ve 0 piezas y responde 400.
  4. El POS manda la venta a no conciliadas, aunque sí exista.
- Lo mismo ocurre si entre ambos intentos se desactivó el producto, caducó el lote o cambió el rol.
- **Impacto:** el dinero se cuenta dos veces y la conciliación no cuadra.
- **Cambio:** calcular la huella y consultar `saleIdempotencyKeys` antes de FEFO y de las validaciones de catálogo.

### A2 (P0): un payload inválido tumba el lote completo

- **Dónde:** `back: schemas/sales.ts:241` (`items: z.array(createSaleSchema)`) y `modules/sales/sales.controller.ts:106`.
- **Escenario:** basta una venta con un error de validación para que todo el lote devuelva 400 y la cola de esa caja se atore en cada sync. Por ejemplo:
  - un descuento con más de 2 decimales;
  - una cédula que no tiene 7 u 8 dígitos;
  - un RFC inválido;
  - `unitPrice: 0`;
  - más de 100 partidas.
- **Cambio:** declarar `items: z.array(z.unknown())` y hacer `createSaleSchema.safeParse` dentro del loop, con resultado `{ ok: false, code: 'VALIDATION' }` para esa venta.

### A3 (P0): dos cajas en el mismo lote mandan ventas buenas a conciliación

- **Dónde:** `back: services/sales.service.ts:755-775`. El reparto FEFO se planea fuera de la transacción, y `:1264-1273` solo revisa los lotes planeados.
- **Escenario:**
  1. La caja A deja el lote L1 en 0.
  2. La caja B planeó tomar de L1, así que su transacción lanza "Stock insuficiente en lote X", aunque L2 tenga 50 piezas.
  3. Firestore no reintenta un `badRequest`.
- **Cambio:** repartir FEFO dentro de la transacción, leyendo los lotes con `transaction.get`. Agregar una prueba con dos ventas concurrentes que agoten un lote.

### A4 (P0): la venta queda a nombre de quien sincroniza

- **Dónde:** `back: modules/sales/sales.controller.ts:120-125` (`cashierId = user.uid`), `services/sales.service.ts:1067` y `pos: src/app/core/sync/push-owner.ts:20-23`.
- **Escenario:** el cajero A deja ventas en cola y un admin u otro cajero inicia sesión en esa caja.
  - Si sube un admin: la venta queda a su nombre y la llave cambia a `admin:<key>`. Si el intento de A ya había confirmado, la venta se duplica, con stock y efectivo dobles.
  - Si sube otro cajero: `assertCanAccessSession` responde 403.
  - El tope del 20 % se evalúa con el rol de quien sincroniza.
- **Cambio:** mandar `soldBy` en el payload, validado contra el `openedBy` del turno; formar la llave por turno o por cajero original; registrar quién autorizó el descuento.

### A5 (P1): `soldAt` se ignora y la venta toma la fecha del servidor

- **Dónde:** `back: services/sales.service.ts:1379, 1420-1429`. `soldAt` solo va a la bitácora (`:1449`), y FEFO usa la hora actual (`:769`).
- **Escenario:** una venta del día 31 a las 23:50 que sincroniza el día 1 cae en el mes siguiente: reporte, IVA y libro COFEPRIS del día 1. Además, un lote que caducó a medianoche rechaza una venta de ayer.
- **Cambio:**
  - con `soldAt` confiable, usarlo como fecha de negocio de la venta, los movimientos y el libro, y como `now` de `allocateFefo`;
  - dejar `createdAt` como fecha de recepción;
  - no confiar en un `soldAt` anterior a la apertura del turno ni con más de N horas de antigüedad.

### A6 (P1): turno cerrado con ventas aún en cola

- **Dónde:** `back: services/sales.service.ts:1257-1259` y `services/cash-sessions.service.ts:390-434`.
- **Escenario A:** el cierre llega antes que las ventas en cola. Todas responden "turno cerrado", el Z marca un sobrante falso y las ventas acaban en no conciliadas.
- **Escenario B:** `closeSession` calcula el resumen fuera de la transacción. Una venta que confirma en medio queda en el turno pero fuera del resumen.
- **Mismo hueco en devoluciones:** `sale-returns.service.ts:232` revisa `closedAt` fuera de la transacción.
- **En el POS:** la ruta `requeuedClose` no pasa `sinHijosPendientes` (`pos: src/app/features/pos/services/cash-session.service.ts:434`).
- **Cambio:**
  - con `offline` y `soldAt ≤ closedAt`, aceptar la venta con `lateSync` y poner `hasPendingAdjustment` en el turno;
  - releer las ventas dentro de la transacción de cierre, o llevar una suma en el doc del turno;
  - pasar `sinHijosPendientes: true` también en `requeuedClose`.

### A7 (P1): producto desactivado o lote caducado al sincronizar

- **Dónde:** `back: services/sales.service.ts:735-737` responde "Producto X no encontrado". Ese texto no coincide con `pos: electron/db/blocked-diagnosis.js:28`.
- **Impacto:** la venta, ya cobrada, queda bloqueada con diagnóstico "desconocido".
- **Cambio:** offline, aceptar productos o servicios inactivos que existan, con `catalogReview`.

### A8 (P1): timeout del bulk

- **Dónde:** `back: modules/sales/sales.controller.ts:114-137`. Hasta 200 ventas en serie, cada una con `await listBatchesByProduct` por producto, contra el límite de 60 s.
- **Impacto:** el POS no recibe resultado y el reintento cae en A1.
- **Cambio:**
  - presupuesto de unos 40 s; lo que no alcance se devuelve como `DEFERRED`;
  - bajar `max` a 25-50;
  - leer los lotes en paralelo.

### A9 (P1): anulaciones que divergen entre caja y servidor

- **Alta OK, anulación falla** (`pos: src/app/features/pos/services/sale.service.ts:976-994`):
  - Si el `POST /void` falla por red, se llama `markPushFailed` en vez de `markSynced`, y la venta queda bloqueada sin `remoteId`.
  - El admin puede descartarla en local mientras el servidor la mantiene activa.
  - **Cambio:** llamar `markSynced` al crearse y no marcar `pushError` en errores de red o 5xx.
- **Anulación remota pendiente rechazada con 4xx** (`:1030-1037`):
  - Un texto que no contiene "anulad" cae en `of(undefined)` y se reintenta para siempre en silencio.
  - **Cambio:** mostrar el 4xx en el panel de rechazados, con acción para el admin.

### A10 (P2): ticket autoguardado tras un apagón

- **Dónde:** `pos: src/app/features/pos/sale/sale.ts:347-352, 1474-1476`.
- **Escenario:** se restaura un carrito ya cobrado y, al cobrarlo de nuevo, se genera otra llave: venta duplicada.
- **Cambio:** guardar la llave de idempotencia con el borrador y, al restaurar, revisar en SQLite si esa venta ya existe.

### A11 (P2): el escáner pasa por la búsqueda difusa

- **Dónde:** `pos: src/app/features/pos/sale/sale.ts:885-960` y `electron/db/products.js:139-155` (`contains`, `take: 25`, sin `switchMap`).
- **Cambio:** con Enter, buscar primero el `getByBarcode` exacto. No aceptar coincidencias parciales que vengan del escáner.

### A12 (P2): el auto-push en pausa no se rearma

- **Dónde:** `pos: src/app/core/sync/auto-push.service.ts:162-166`.
- **Escenario:** tras 5 fallos se pausa 15 min sin temporizador. Con la caja quieta en la noche, lo último del día espera al horario de las 10:30.
- **Cambio:** rearmar el envío al terminar la pausa.

## B. Entradas y compras

### B1 (P0): una reserva reciente responde 409 y el POS lo toma como rechazo permanente

- **Dónde:** `back: services/stock-entries.service.ts:108-110`; `pos: src/app/features/pos/services/stock-entry.service.ts:215, 229-240`; `src/app/core/sync/sync-diagnosis.ts:65-72` ("No la reintentes").
- **Escenario:**
  1. El primer intento reserva la llave y truena con un 5xx.
  2. El auto-push reintenta a los 15 s, todavía dentro de los 10 min de la reserva, y recibe 409.
  3. La entrada queda marcada como fallida.
- **Impacto:** el stock existe solo en la caja, y luego las ventas de esa mercancía fallan en el servidor.
- **Cambio:** un código `ENTRY_IN_PROGRESS` (o 503 con `Retry-After`) tratado como transitorio; corregir el texto del diagnóstico.

### B2 (P0): la llave de entrada es `userId:key` y las entradas no tienen dueño

- **Dónde:** `back: services/stock-entries.service.ts:63`; `pos: electron/db/products.js:425` (`getPendingStockEntries` sin filtro de dueño).
- **Escenario:** el cajero A sube una entrada, se pierde la respuesta, entra el cajero B y el push la reenvía. La llave `B:<id>` no existe, así que se aplica dos veces: stock fantasma.
- **Cambio:** formar la llave con `deviceId:key` o con un UUID global, o filtrar por dueño como en ventas.

### B3 (P1): liberar la llave ante cualquier error

- **Dónde:** `back: services/entry-idempotency.service.ts:81-83` y `services/supplier-payment-idempotency.service.ts:81-83`. Se libera también ante un 5xx o un commit ambiguo.
- **Impacto:** el reintento duplica la entrada o el abono. Es el mismo bug que ya corrigió el commit 396eec2 en `createStockEntry`.
- **Cambio:** liberar solo ante un `AppError` con status < 500.

### B4 (P1): producto en línea huérfano y entrada atorada

- **Rechazo después de crear el producto** (`back: services/stock-entries.service.ts:168-193`, `services/inventory.service.ts:558`):
  1. La entrada crea el producto y `recordEntry` falla, por ejemplo con el proveedor desactivado vía PATCH `isActive`.
  2. Cada reintento recibe 409 por SKU.
- **Retomar una reserva vieja** (`:150-153` frente a `:117-121`):
  1. Retomarla reescribe `createdAt`.
  2. El tercer intento ya no adopta el producto sobrante.
- **Alta directa** (`recordDirectEntry`, `:598`): crea productos en serie; si el segundo choca, el primero queda huérfano.
- **Cambio:** validar proveedor y unicidad de todos los productos antes de crear cualquiera; guardar `productId` en el doc de la llave justo después de `createProduct`; medir la antigüedad de la reserva con un campo aparte.

### B5 (P1): el POS reenvía el alta embebida aunque el producto ya tenga `remoteId`

- **Dónde:** `pos: electron/db/products.js:470`.
- **Escenario:** el catálogo sube primero el producto y luego la entrada lo intenta crear otra vez: 409.
- **Cambio:** si `product.remoteId` existe, mandar `productId` y quitar `product`.

### B6 (P1): choque de `remoteId @unique` cuando el pull llega antes que el enlace local

- **Dónde:** `pos: electron/db/products.js:332-337, 484-495` y `src/app/.../product-catalog.service.ts:181`.
- **Impacto:** dos productos locales, stock contado doble y ventas esperando para siempre por el id local.
- **Cambio:** al enlazar, fusionar en una transacción: reasignar lotes y partidas, y borrar la fila local.

### B7 (P1): recapturar la misma factura duplica el stock

- **Dónde:** `pos: electron/db/invoice-rag.js:134` (solo deduplica por sha256 local) y `:315` (`remove` no revisa `stockAppliedAt`).
- **Escenarios:**
  - foto y PDF de la misma factura;
  - borrar y volver a subir;
  - dos cajas;
  - IA más captura manual.
- **Cambio:**
  - bloquear `remove` cuando el documento ya se aplicó;
  - pedir confirmación ante misma factura + producto + lote + cantidad con otra llave;
  - cancelación de entrada con contramovimiento;
  - indicador "capturado vs total" por factura.

### B8 (P1): la captura con IA confunde caja con pieza

- **Dónde:** `pos: src/app/features/pos/invoice-rag/invoice-rag-stock/invoice-rag-stock-dialog.ts:229` e `invoice-rag-stock-form.ts:21, 53-57`.
- **Escenario:** la factura dice 3 cajas de 20 piezas y entran 3 piezas. El costo por caja se guarda como costo por pieza.
- **Impacto:** stock subcontado, y COGS y `lastCostPriceBySupplier` inflados.
- **Cambio:** convertir con `boxQuantity` y mostrar la conversión.

### B9 (P1): las entradas de controlados no van al libro COFEPRIS

- **Dónde:** `back: types/index.ts:354` (`ControlledLedgerType = 'sale' | 'void' | 'return'`). `persistEntryItems` no escribe en el libro.
- **Cambio:** registrar un renglón `entry` dentro de la transacción de la entrada. Quitar al cajero (`stockEntry` / `productUpdate`) la edición de `controlledGroup`.

### B10 (P1): productos duplicados entre cajas

- **Dónde:** `back: repositories/products.repository.ts:19-62`. La unicidad es exacta: mayúsculas y acentos cuentan.
- **Inconsistencia:** el catálogo del POS adopta cualquier producto con el mismo SKU aunque sea otro (`product-catalog.service.ts:181, 221`) y descarta los datos locales.
- **Cambio:** campo `nameKey` normalizado con unicidad; adoptar solo si SKU y barcode coinciden.

### B11 (P2): otros de entradas y facturas

- **`productUpdate` puede tumbar la entrada:**
  - `barcode: ''` falla la regex (`pos: src/app/features/pos/stock-entry/stock-entry.ts:461`);
  - un barcode de otro producto da 409;
  - el precio absoluto capturado offline pisa al admin.
  - **Cambio:** aplicarlo best-effort después de la entrada y aceptar `null` para borrar el barcode.
- **Lotes:**
  - `findBatchByProductLotAndExpiry` corre fuera de la transacción (`back: services/inventory.service.ts:405` vs `:418`), así que pueden nacer lotes duplicados;
  - el mismo lote con otra caducidad no avisa;
  - el número de lote es sensible a mayúsculas.
  - **Cambio:** id de lote determinista y número de lote normalizado.
- **Costo:**
  - al fusionar lotes gana el último costo (`inventory.service.ts:450-451`);
  - **Cambio:** promedio ponderado y etiqueta "sin IVA, por pieza".
- **Fechas:**
  - se validan en UTC (`back: schemas/stock-entries.ts:18`, `schemas/inventory.ts:6-9, 213`): después de las 18:00 se rechaza caducidad = hoy;
  - el prompt de la IA no dice que las fechas vienen en DD/MM (`services/invoice-rag.service.ts:21`).
  - **Cambio:** usar `getZonedYmd` y validar contra la fecha de captura.
- **Reserva vieja:** con dos partidas iguales en una factura, una reserva vieja puede quedarse con la partida equivocada (`stock-entries.service.ts:225-244`). **Cambio:** guardar la llave en la entrada.
- **TTL:** las llaves de `createStockEntry` no llevan `expiresAt` (`:160`), así que no aplica la política TTL.
- **Topes:** `inventoryEntrySchema` / `directInventoryEntrySchema` no tienen `.max()` en `items`, con riesgo de topar el límite de escrituras, el doc de 1 MiB y los 60 s.
- **Facturas:**
  - el folio no se normaliza ("A-123" ≠ "A123");
  - no hay cancelación de factura;
  - `totalAmount` es inmutable;
  - la IA no manda el UUID del CFDI;
  - no hay notas de crédito ni devolución a proveedor (ya documentado en `GOALS.md:89` del POS).

## C. Stock y catálogo entre cajas

### C1 (P0): una venta no conciliada no descuenta ninguna partida

- **Dónde:** `back: services/unreconciled-sales.service.ts:15-55` no mueve stock. En el POS, `electron/db/sales.js:953-963` (`markUnreconciled`) saca la venta de `pendingStockDelta`, y el pull (`products.js:334`) iguala el stock al del servidor.
- **Escenario:** en un ticket de 10 renglones falta stock en uno. Los 10 quedan sin descontar y, tras el pull, todas las cajas ven esas piezas como disponibles.
- **Cambio:** aceptar la venta y descontar lo que exista; el faltante va en `stockShortfall` (principio 1).

### C2 (P1): el pull pisa ediciones de catálogo pendientes

- **Dónde:** `pos: electron/db/products.js:336-339`. `upsertMany` no respeta `pendingCatalogPush`, y `toPushFields` (`:601-623`) sube la fila ya pisada.
- **Impacto:** la edición se pierde sin aviso y el panel de rechazados se "arregla" solo.
- **Cambio:** en filas con edición pendiente, actualizar solo stock y lotes.

### C3 (P1): el PATCH desde la caja manda el registro completo

- **Dónde:** `pos: electron/db/products.js:601-623`. El backend no tiene precondición de versión.
- **Escenario:** el admin sube un precio o desactiva un producto. Una caja con datos viejos corrige otro campo y revierte el precio, y además **reactiva** el producto.
- **Cambio:** mandar solo el diff (las entradas ya lo hacen, `stock-entry.ts:397`), más un `baseUpdatedAt` opcional que devuelva 409 en precio e `isActive`.

### C4 (P1): el cursor de sync se salta cambios

- **Cursor sin traslape:** `pos: src/app/core/sync/sync-scheduler.service.ts:691-712`.
  - `back: services/sales.service.ts:596` toma `timestamp` antes de que la transacción confirme.
  - Una caja puede avanzar su cursor más allá de ese cambio y no bajarlo nunca.
- **Anulación offline:** escribe `products.updatedAt` con el `voidedAt` reportado, es decir, en el pasado (`sales.service.ts:1612-1620, 1660-1668`).
- **Cambio:**
  - `/products/sync` devuelve `meta.serverTime` tomado antes de leer;
  - la caja lo usa como cursor menos 1-2 min;
  - `updatedAt` siempre con la hora del servidor.

### C5 (P1): el pull no espera al auto-push

- **Dónde:** `pos: src/app/core/sync/sync-scheduler.service.ts:686-712`. El pull no está en `pushChain` (`:552-559`).
- **Impacto:** stock fantasma hasta el siguiente horario.
- **Cambio:** meter el pull en la cadena, o restar las ventas que se marcaron como subidas durante el GET.

### C6 (P1): mercancía recibida en otra caja no se puede vender por horas

- **Dónde:** `pos: src/app/features/pos/sale/sale.ts:1633` bloquea si `piezas > stock` local.
- **Impacto:** de 3.5 a 14 h de ventas perdidas con el producto en el anaquel.
- **Cambio:** con red y stock local insuficiente, refrescar solo ese producto (1-2 lecturas) antes de negar la venta.

### C7 (P2): la caducidad no coincide entre caja y servidor

- **Dónde:** `pos: src/app/features/pos/sale/sale.ts:1715-1720` y `electron/db/products.js:387`. La medianoche UTC equivale a las 18:00 del día anterior en México, así que la caja trata el lote como caducado un día antes.
- **Cambio:** comparar Y-M-D en la zona de la farmacia.

### C8 (P2, latente): el conteo físico descuenta dos veces

- **Dónde:** `back: services/inventory-counts.service.ts:100-140`. Fija una cantidad absoluta, sin `countedAt`.
- **Escenario:** las ventas en cola que suben después del conteo descuentan otra vez.
- **Estado:** latente. Hoy ningún front llama `/inventory/counts`.
- **Cambio:** mandar `countedAt` por partida y avisar si alguna caja tiene ventas pendientes.

## D. Caja, dinero y antifraude

### D1 (P1): el cajero anula su propia venta sin motivo ni autorización

- **Dónde:** `pos: src/app/features/pos/history/sale-history.ts:84-86` (`canVoid = pos:write`); `services/sale.service.ts:561, 574, 602`.
- **Escenario:** cobra en efectivo, anula y se queda el efectivo. Es el robo clásico de mostrador.
- **Cambio:** motivo obligatorio y PIN o rol de supervisor para anular ventas en efectivo o pasados X minutos. Mandar el motivo al backend.
- **Requiere decisión de negocio.**

### D2 (P1): tarjeta registrada sin comprobante

- **Dónde:** `pos: src/app/features/pos/checkout/checkout.ts:474-478`, con `terminalEnabled: false`.
- **Escenario:** cobra en efectivo, marca la venta como tarjeta y el Z cuadra.
- **Cambio:** con la terminal desactivada, exigir número de autorización o últimos 4 dígitos del voucher; agregar un reporte de tarjeta por turno para conciliar con el banco.

### D3 (P1): el cajero puede cambiar precio o quitar el grupo controlado

- **Dónde:**
  - `pos: src/app/features/pos/products/product-form.ts:83-84`;
  - `electron/db/products.js:601-622`: `toPushFields` omite `controlledGroup` nulo, así que la desclasificación queda solo en local;
  - `back: services/sales.service.ts:795, 842`: acepta cualquier `unitPrice`.
- **Escenario A:** baja el precio, vende y lo regresa antes del push. No queda auditoría y el descuento esquiva el tope del 20 %.
- **Escenario B:** desclasifica un controlado y lo vende sin receta.
- **Cambio:**
  - precio y `controlledGroup` editables solo por admin o gerente;
  - en el backend, un `unitPrice` menor al catálogo cuenta como descuento sujeto al tope y se audita.
- **Requiere decisión de negocio.**

### D4 (P1): turno rezagado

- **Dónde:** `pos: src/app/features/pos/services/cash-session.service.ts:231-270` (cierra con contado = esperado), `electron/db/cash-sessions.js:339` (el fondo siguiente hereda ese contado) y `cash-session-dialog.html:61-71` (fondo de solo lectura).
- **Impacto:** el faltante del cajero A aparece en el Z del cajero B.
- **Cambio:** que B cuente el fondo al abrir y se registre la diferencia; marcar los turnos cerrados automáticamente para revisión.

### D5 (P1): Mercado Pago

- **Orden cobrada sin venta** (`back: services/sales.service.ts:1093-1109`):
  - Si `createSale` falla después de `resolvePointPayment`, nadie la detecta.
  - El webhook solo hace `logger.error` y en producción está sin secreto.
  - **Cambio:** un cron que cruce `pointOrders` de más de 15 min contra `sales.pointPayment.orderId` y `directCharges`, y escriba las huérfanas en una colección.
- **Doble reembolso** (`back: services/sale-returns.service.ts:389-398, 476-478`):
  - Dos devoluciones concurrentes reembolsan las dos, porque la llave depende de `refundedTotal`.
  - **Cambio:** derivar la llave de MP de la `idempotencyKey` de la devolución, o reservar en el doc de la venta antes de reembolsar.
- **Unicidad de la orden** (`sales.service.ts:312-315`):
  - La unicidad de `orderId` se revisa fuera de la transacción.
  - **Cambio:** `transaction.create(pointOrderSales/{orderId})`.

### D6 (P1): reloj de la caja sin validar

- **Dónde:** `back: services/sales.service.ts:631-633` (solo limita el reloj adelantado) y `pos: src/app/features/pos/services/cash-session.service.ts:239`.
- **Escenario:**
  - un reloj adelantado autocierra el turno vivo sin arqueo;
  - un reloj atrasado aplica promociones o cupones vencidos sin marca de revisión.
- **Cambio:** comparar contra el header `Date` de las respuestas y avisar o bloquear si hay más de 5 min de desfase.

### D7 (P2): "Descartar" no deja rastro

- **Dónde:** `pos: electron/db/sales.js:1063-1083`.
- **Cambio:** borrado lógico, `SyncLog` y aviso al servidor, por ejemplo como `unreconciled` con motivo "descartada". Rechazar el descarte de ventas anuladas que pudieron llegar al servidor.

## E. Observabilidad

### E1 (P0): `unreconciledSales` es invisible

- **Visibilidad:**
  - el panel admin nunca llama `GET /sales/unreconciled` (solo aparece el comando de caja en `pos-health-detail`);
  - ningún schedule, correo ni reporte la menciona.
- **Fragilidad** (`back: repositories/unreconciled-sales.repository.ts:31-43`):
  - no asienta el libro de controlados;
  - el id es el `localId` sin la caja;
  - `set(merge)` reabre una venta ya resuelta;
  - un `/` en el id provoca un 500;
  - el efectivo no aparece en el corte.
- **Cambio:**
  - pantalla de conciliación con la acción "aplicar al inventario";
  - conteo y monto en el correo diario y alerta inmediata;
  - id `deviceId:localId` con `create`;
  - asentar el libro al resolver;
  - `unreconciledCash` en el resumen del turno.

### E2 (P1): errores sin código

- **Dónde:** `back: modules/sales/sales.controller.ts:127-135`. `ABORTED` o una caída de MP salen sin `code`, y "stock insuficiente" y "turno cerrado" salen los dos como `BAD_REQUEST`.
- **Cambio:** aplicar el principio 2.

### E3 (P2): sin conciliación de stock caja vs servidor

- **Cambio:** que el diagnóstico diario mande un checksum, o las diferencias de los productos sin pendientes; el backend alerta si la diferencia se sostiene.

### E4 (P2): el auto-update de macOS falla en silencio

- **Dónde:** `pos: package.json:92` (`identity: null`) y `electron/main.js:374-386`, que solo escribe en `console`. `docs/INSTALACION_CAJA.md` dice que la caja se actualiza sola.
- **Cambio:**
  - registrar el error en `SyncLog`;
  - marcar en el panel las cajas con versión menor a la mínima;
  - firmar la app o corregir el documento.

### E5 (P2): nadie lee `catalogUnitPrice`

- **Cambio:** reporte o alerta "cobrado ≠ catálogo" en el panel admin.

### E6 (P2): documentos calientes

- **Dónde:** `back: services/sales.service.ts:1237-1239, 1294-1326`. Cada venta lee y escribe `counters/sales`, el producto popular y el `usedCount` del cupón. Bajo carga eso puede terminar en `ABORTED`.
- **Cambio a corto plazo:** marcar el error como reintentable (E2).
- **Si crece:** folio por caja.

## Orden sugerido

1. **Sprint 1, backend sin romper contrato:**
   - A1, A2, A3;
   - B1, B2, B3;
   - E2: códigos de error y su lectura en el POS.
   - Es lo que hoy manda ventas y entradas legítimas a atorarse o a no conciliadas.
2. **Sprint 2, la venta cobrada siempre entra:**
   - principio 1: A5, A6, A7, C1;
   - E1: conciliación visible.
3. **Sprint 3, sync, catálogo y entradas:**
   - A4: identidad en el sync;
   - C2-C6: catálogo;
   - B4-B10: entradas.
4. **Sprint 4, producto y negocio:**
   - D1-D4: antifraude;
   - D5: Mercado Pago;
   - B9: libro de entradas de controlados.

D1, D2 y D3 requieren decisión de negocio: política de supervisor y permisos del cajero. Lo demás es técnico.

## Notas

- **Verificado a mano:**
  - FEFO corre antes de la revisión de idempotencia (A1);
  - el bulk valida con Zod el lote completo (A2);
  - `soldAt` solo va a la bitácora (A5);
  - el panel no consume `unreconciledSales` (E1);
  - la llave de entrada es `userId:key` y se responde 409 ante una reserva reciente (B1, B2);
  - se libera la llave ante cualquier error (B3);
  - `ControlledLedgerType` no admite `entry` (B9);
  - `createStockEntry` no lleva `expiresAt` (B11).
- **Verificado por los auditores**, citando el código, pero sin revisión manual: el resto.
- **GOALS del POS desactualizado:** sigue como pendiente "sin pruebas sobre `electron/db`", pero ya existen en `electron/test/` (34 casos en `sales.spec.mjs` y 69 en `e2e-real-sqlite.spec.mjs` sobre SQLite real). Se puede cerrar.

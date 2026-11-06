# MEMORY.md

Contexto persistente del proyecto **FarmaJyV Backend** para retomar trabajo rápidamente. Hechos derivados del código; actualízalo cuando cambien. Detalle de arquitectura en [CLAUDE.md](CLAUDE.md), objetivos en [GOALS.md](GOALS.md).

## Datos clave

- **Proyecto Firebase:** `farma-jyv` (ver [.firebaserc](.firebaserc)).
- **Runtime:** Node 22, TypeScript, **NestJS 11** sobre Express 5, Firebase Functions v2 (`onRequest`, región `us-central1`, **512MiB**).
- **Entry point:** todo el código en [functions/](functions/); la función exportada es `api` en [functions/src/index.ts](functions/src/index.ts), más `reportsPdf` (SPEC 38: las 11 rutas PDF con Chromium, 1GiB/120s/concurrencia 1, misma configuración HTTP vía `common/http-pipeline.ts`; RUNBOOK §12). Bootstrap Nest en [functions/src/app.ts](functions/src/app.ts) (`logger: false`) + [functions/src/app.module.ts](functions/src/app.module.ts).
- **Base de datos:** Firestore (`ignoreUndefinedProperties: true` global, ver `utils/firestore.ts`). **Auth:** Firebase Auth (ID tokens + custom claims). **Archivos:** Cloud Storage.
- **Rama actual:** `feature/prducts`.

## Colecciones de Firestore

| Colección | Contenido |
|---|---|
| `products` | Catálogo (SKU, barcode, precio **con impuestos incluidos**, `iepsRate`, `suppliers`, `lastCostPriceBySupplier`, **`totalStock`** denormalizado) |
| `categories` | Categorías de productos |
| `batches` | Lotes: producto + lote + caducidad + cantidad (+ **`supplierId`** en altas nuevas) |
| `stockMovements` | Auditoría de movimientos de stock |
| `inventoryEntries` | Entradas (+ **`productIds[]`** en altas nuevas) |
| `invoices` | Facturas de compra (archivo en Storage) |
| `suppliers` | Proveedores |
| `sales` | Ventas (+ **`productIds[]`** en altas nuevas); list default últimos 30 días |
| `users` | Perfiles de usuario (`roleId`, `isActive`) |
| `roles` | Roles con permisos `{ área, nivel }` |
| `cashSessions` | Turnos de caja |
| `inventoryCounts` | Conteos físicos (folio `C-`, items con esperado/contado/diferencia) |
| `controlledSalesLedger` | Libro de control COFEPRIS (movimientos `sale`/`void`/`return`, cantidad con signo) |
| `auditLogs` | Bitácora de dinero, precios y accesos |
| `cashReadings` | Lecturas X registradas (folio `X-`, snapshot del resumen del turno) |
| `saleReturns` | Devoluciones parciales de venta (folio `D-`, items con lote de origen, `refundMethod`, `taxSummary`, `pointRefund`) |
| `saleIdempotencyKeys` | Llaves de idempotencia de venta (doc id `<cashierId>:<key>`; `saleId`, `requestFingerprint`, `expiresAt` 48h para TTL) |
| `patients` | Padrón del consultorio (folio `EXP-`, CURP única, alergias, padecimientos crónicos, `customerId` opcional hacia `customers`); baja **lógica** (`isActive`), nunca borrado |
| `medicalRecords` | Notas del expediente clínico (paciente/doctor denormalizados, `visitedAt`, `vitals` con `bmi` calculado en servidor, `attachments[]` con ruta de Storage) |
| `appointments` | Citas (`startAt`/`endAt`, `durationMinutes`, `status`, `cancelReason`, `medicalRecordId`) |
| `promotions` | Promociones por cantidad (`rule` inmutable: `tiered`/`nxm`/`percent`, `productIds[]`, `startsAt`/`endsAt`, `isActive`, `deactivatedAt`); baja lógica |
| `coupons` | Cupones (SPEC 47). **Id = código normalizado** (`[A-Z0-9-]{4,20}`, no reciclable); `scope` `product`/`sale`, `productIds[]`, `discount` `{percent}`/`{amount}`, `minPurchase`, `startsAt`/`endsAt`, `maxUses`, `usedCount` (lo sube la transacción de la venta), `isActive`/`deactivatedAt`. Inmutables salvo la baja. Solo API |
| `posDiagnostics` | Salud de cajas: un doc por caja (`{deviceId}`), **sobrescrito** en cada reporte (ventas bloqueadas, turnos/productos sin subir, corridas y bitácora de sync) + `receivedAt` (servidor), `reportedBy`, `openCashSessionId` (lo informa el POS; ausente en POS viejo) y `silenceAlertedAt` (aviso de silencio dado; cada reporte lo pone en `null`); opcional `lastLocalBackupAt` (última copia local de rutina, SPEC 37; ausente se lee `null`). Solo API |
| `posCommands` | Comandos remotos admin → caja (`retrySale`/`retryCashSession`/`retryProduct`/`sendSaleToUnreconciled`), `status` `pending`→`done`/`failed`, `completedBy`. Solo API |

## Endpoints (montados bajo `/v1`, servidos por controllers Nest en `src/modules/`)

`auth`, `categories`, `products`, `inventory`, `invoices`, `uploads`, `sales`, `sale-returns`, `suppliers`, `users`, `roles`, `doctor`, `internal`, `cash-sessions`, `payments`, `patients`, `medical-records`, `appointments`, más `GET /v1/health`.

Consultorio (`modules/clinic`, áreas de permiso `patients` / `medicalRecords` / `appointments`):
- `GET|POST /v1/patients`, `GET|PATCH /v1/patients/:id`, `GET /v1/patients/:id/overview` (conteos para la ficha), `GET /v1/patients/:id/records` (línea de tiempo, exige `medicalRecords:read`).
- `GET|POST /v1/medical-records`, `GET|PATCH /v1/medical-records/:id`, `POST /v1/medical-records/:id/attachments` (multipart campo `file`, guarda en `clinical/<patientId>/<recordId>/`), `GET /v1/medical-records/:id/attachments/:attachmentId/url` (URL firmada bajo demanda, no persistida), `DELETE` del adjunto.
- `GET /v1/doctor/inventory?updatedSince=` (`medicalRecords:read`, admin/doctor): `{ data: Item[], meta: { serverTime, full, total } }`; Item sin precios/costos/proveedores/lotes. Sin `updatedSince` = activos completos (caché 60 s); con él = delta incluyendo inactivos (`full:false`).
- `GET|POST /v1/appointments`, `GET /v1/appointments/calendar?from&to&doctorId` (rango completo, tope 92 días), `GET /v1/appointments/availability?date&doctorId&durationMinutes` (huecos libres), `GET /v1/appointments/doctors` (existe porque `GET /users` exige `users:read`, que el doctor no tiene), `GET /v1/appointments/:id`, `PATCH /v1/appointments/:id`, `POST :id/reschedule`, `POST :id/status`.

Caja: `GET|POST /v1/cash-sessions/:id/x-report` (vista previa / lectura registrada), `GET /v1/cash-sessions/:id/x-readings`; `POST :id/close` (Z) devuelve también `html`.
Reportes: `GET /v1/reports/{sales-summary,profit,top-products,by-cashier,dead-stock}` (permiso **`dashboard:read`**).
Análisis de producto: `GET /v1/products/:id/analytics?months=12` (permiso **`inventory:write`**: gerente y admin, no cajero; costos y márgenes). Una respuesta con ventas mes/año, precio (cambios de `auditLogs`), costo, stock reconstruido desde `stockMovements`, valor de inventario y compras recientes (`product-analytics.service`, caché 60 s). Requiere el índice `inventoryEntries [productIds CONTAINS, createdAt DESC]`; sin él responde con `unavailable: ['entries']`. La comparativa por principio activo la hace el panel con `/products/sync`.
Análisis de servicio: `GET /v1/pharmacy-services/:id/analytics?months=12` (**`dashboard:read`**; comisiones por doctor; `service-analytics.service`; índice `sales [serviceIds CONTAINS, createdAt ASC]`). Un servicio no tiene costo ni devoluciones: neto = ingreso − comisión.
PDFs del módulo Reportes: `GET /v1/reports/exports/{sales-daily,sales-monthly,inventory,invoices}.pdf` (**`dashboard:read`**, `module-reports.service` + `report-exports.controller`, `?scope=pharmacy|clinic|financial`, `date=`/`month=` opcionales; sin ellos hoy / este mes en hora de México). Farmacia = solo partidas de mercancía, consultorio = solo servicios, financiero = venta completa; cada fila lleva quién cobró y la hora. Facturas = de proveedores (`invoiceDate` del mes). Análisis de producto/servicio aceptan `granularity=day|week` + `periods` y devuelven `series` (analytics-series.ts).
Descarga genérica PDF/Excel/CSV: `GET /v1/reports/exports/:report?format=pdf|xlsx|csv|json` (**`dashboard:read` o `reportDownloads:read`**, `services/report-export/`). Con solo `reportDownloads` (contador, SPEC 45) `assertCanExportReport` abre únicamente `ventas` con `scope=pharmacy|clinic`, `facturas` e `iva-por-producto`; lo demás es 403 «No tienes permiso para este reporte». `format=json` (solo en `api`) es la vista previa: `{ data: { columns: [{key,label,type}], rows (tope 500, o `previewMaxRows` de la definición: 5000 en `iva-por-producto`), totals (columnas money/int/decimal sobre todas las filas), truncated, rowCount } }`. Un reporte = una `ReportDefinition` (columnas tipadas + `load`) registrada en `registry.ts`; la misma definición alimenta los tres formatos (filas con números crudos, solo el PDF formatea). Periodo: `from`/`to` (rango libre, máx. 366 días) > `date` > `month` > mes en curso; `scope` en `ventas`, `days` en `sin-movimiento`. Claves: `ventas`, `utilidad`, `corte-caja`, `gastos`, `gastos-categoria`, `impuestos`, `iva-por-producto` (renglón por producto/servicio y régimen; bases 16 %/0 %/exento en columnas separadas; 0 % vs exento según la ficha actual), `devoluciones`, `cancelaciones`, `metodos-pago`, `inventario`, `existencias-categoria`, `stock-bajo`, `caducidad`, `sin-costo`, `sin-movimiento`, `mermas`, `reabasto`, `conteos`, `top-productos`, `por-cajero`, `ventas-por-hora`, `ventas-por-dia-semana`, `promociones`, `libro-controlados` (además solo admin/manager), `bitacora`, `comisiones`, `servicios`, `citas`, `facturas`, `compras-proveedor`, `cuentas-por-pagar`. Las rutas `*.pdf` anteriores siguen vivas. `exceljs` se importa con `await import()` dentro de `render-xlsx.ts` (cold start). Huecos conocidos: Mercado Pago se cuenta como Tarjeta (sin comisiones), la cancelación no guarda motivo, el Z de caja no tiene folio, la cita no tiene monto.
Resumen semanal/mensual: `GET /v1/reports/business-summary?period=week|month&scope=all|pharmacy|services&anchor=YYYY-MM-DD` (**`dashboard:read`**, `business-summary.service`, sin IA, caché 2 min): periodo vs anterior (mismos días si está en curso), margen solo sobre partidas con costo + cobertura de costo, rama consultorio (ingresos, comisiones, por doctor, top servicios), avisos por reglas. Asistente: herramientas `business_summary` (con `scope`), `find_product`/`product_analytics`, `find_service`/`service_analytics`, `top_services`, `commissions`.
Escaneo: `POST /v1/inventory/scan` (GS1-128 / DataMatrix o código plano).

Exportación: `GET /v1/inventory/controlled-ledger/export?from&to&group&productId` → CSV del periodo completo (archivo, sin envoltorio `{ data }`), solo admin/manager.

Inventario: `GET /v1/inventory/alerts?windows=30,60,90`, `POST|GET /v1/inventory/counts`, `GET /v1/inventory/counts/:id`, `GET /v1/inventory/controlled-ledger`. Bitácora: `GET /v1/audit-logs` (permiso `users:read`).

Ticket imprimible: `GET /v1/sales/:id/receipt` y `GET /v1/sale-returns/:id/receipt` (`?width=58|80`) devuelven `{ receipt, html }` (JSON + HTML para rollo térmico, sin Puppeteer).

Promociones (área **`promotions`**: admin/manager escriben, cajero lee): `GET|POST /v1/promotions`, `GET /v1/promotions/sync?updatedSince` (sin paginar, incluye inactivas, para el POS), `GET|PATCH|DELETE /v1/promotions/:id` (PATCH no acepta `rule` ni `productIds`), `GET /v1/promotions/:id/performance` (desempeño vs ventana previa), `GET /v1/promotions/suggestions/expiring?days=90` (lotes por caducar con % sugerido), `POST /v1/promotions/:id/replace` (crea la nueva y luego da de baja la vieja). La venta acepta `items[].promotionId` y `soldAt`; `items[].saleUnit: 'box'` vende por caja completa (SPEC 46: `quantity` = cajas, `unitPrice` = precio por caja; se guarda `quantity` en piezas, `unitPrice` por pieza y `saleUnit { type, boxes, piecesPerBox, boxPrice }`; promo en caja → 400); `GET /v1/sales?promotionReview=true` lista las ventas offline aceptadas con promo fuera de vigencia. Cambiar el precio de un producto da de baja las promos que ese precio invalida.

Cupones (SPEC 47, área **`promotions`**): `GET /v1/coupons?isActive&page&limit`, `GET /v1/coupons/sync?updatedSince` → `{ data, meta: { serverTime } }` (incluye inactivos), `GET /v1/coupons/:code`, `POST /v1/coupons` (409 si el código existe), `DELETE /v1/coupons/:code` (baja). Fechas en ISO. La venta acepta `couponCode`; guarda `Sale.coupon`, `couponDiscountTotal`, `couponReview { reason: out_of_window|over_limit|not_found, code }` y `SaleItem.coupon`. Exporte `cupones`. Motor `utils/coupons.ts` + `test/coupons-engine.cases.json` (copia byte a byte en el POS; `check:promo-engine`).

Asistente de análisis (`modules/assistant`, permiso **`dashboard:read`**): `POST /v1/assistant/chat` con `{ messages: [{ role, content }] }` (máx. 20, el último del usuario) → `{ data: { reply, model, toolsUsed } }`. Chat por OpenRouter (`OPENROUTER_CHAT_MODEL`, debe soportar tool calling) con herramientas de solo lectura sobre los reportes existentes (ventas, utilidad, top productos, cajeros, horas, dead stock, inventario, alertas, resurtido); máx. 4 rondas de herramientas, 15 mensajes/min por usuario, sin historial en servidor. Sin `OPENROUTER_API_KEY` responde 503.

Salud de cajas (`modules/pos-health`): la caja usa **`pos:write`** — `POST /v1/pos/diagnostics` (sobrescribe su snapshot y responde `{ commands }` pendientes, una escritura + una consulta) y `POST /v1/pos/commands/:id/result` (`done`/`failed`, idempotente con el mismo status, 409 si cambia). El admin usa el área **`posHealth`** (admin/manager escritura, cajero nada): `GET /v1/pos/diagnostics`, `GET /v1/pos/diagnostics/:deviceId` (snapshot + últimos 50 comandos), `POST /v1/pos/commands` (exige snapshot, no duplica un pendiente igual, audita `pos.command_created`). Textos y listas del diagnóstico se **recortan**, no se rechazan; si el doc pasara de ~900 KB se recorta bitácora antes que ventas. Alertas por correo (SPEC 44): `reportDiagnostics` lee el `blockedSales` previo (1 lectura) y, si las bloqueadas aparecen o suben (`evaluateBlockedSalesAlert`), manda `Caja <n>: <k> ventas bloqueadas` con import diferido, error tragado y espera tope de 5 s. `hourlyPosSilenceCheck` (cada hora, 256MiB) avisa una sola vez por caída de cada caja con turno abierto (`openCashSessionId`) y más de 2 h sin reportar, marcando `silenceAlertedAt` con precondición antes de mandar. Destino `REPORTS_EMAIL_TO`.

Alta canónica de personal: `POST /users`. `POST /auth/register-staff` es alias. Ambos y `PATCH /users/:id` aceptan `monthlyReportEmail?: boolean` (SPEC 45; el PATCH lo audita como `user.updated`); `GET /users` y `GET /users/:id` lo devuelven tal como está guardado (ausente = `false`).

Rol **`accountant`** («Contador», SPEC 45): solo `reportDownloads:read`. Ve y descarga ventas de farmacia, ventas de consultorio, compras (`facturas`) e IVA por producto (`iva-por-producto`); 403 en `/reports/*`, `/invoices` y cualquier otro exporte. El gerente **no** tiene `reportDownloads`. Rutas que entran con varias áreas usan `@RequireAnyPermission(...)` (`{ anyOf }`); hoy solo `GET /reports/exports/:report` (api y reportsPdf).

## Estructura de `functions/src/`

```
app.ts, app.module.ts, index.ts, dev-server.ts   — bootstrap
common/                                            — ZodValidationPipe, AppExceptionFilter, ResponseEnvelopeInterceptor
modules/<dominio>/                                 — controllers Nest
schemas/                                           — Zod por dominio (common, identity, catalog, inventory, sales) + barrel index
services/ repositories/ types/ constants/ utils/   — capa de dominio (funciones planas)
```

## Convenciones que hay que recordar

- Capas: `modules/*.controller.ts → Guards/ZodValidationPipe → services → repositories`.
- `services/` y `repositories/` son funciones exportadas planas (no `@Injectable`).
- Escrituras multi-colección **siempre** en `firestore.runTransaction` (lecturas antes que escrituras).
- Errores vía `AppError`; repos usan `notFound`/`conflict`, no `throw new Error` crudo.
- **Códigos de sincronización (SPEC 49).** Catálogo en `constants/sync-error-codes.ts` (copiado tal cual en el POS). `AppError` lleva `syncCode` y `retryable` opcionales; el filtro responde `error.details: { code, retryable }` junto al `{ code, message }` de siempre (≥ 500 o inesperado → `INTERNAL` reintentable). `createSale`/`voidSale`/`createStockEntry` etiquetan el 4xx sin código como `VALIDATION`; `/sales/bulk` devuelve `{ ok: false, code, error, retryable }` por índice. Reserva de entrada reciente → 409 `ENTRY_IN_PROGRESS` reintentable; partida dudosa → `ENTRY_AMBIGUOUS`. Los mensajes no cambiaron.
- **Entradas de la caja (SPEC 54/55).** Llave `stockEntryIdempotencyKeys/<deviceId>:<llave>` si la caja manda `deviceId` (`POST /v1/inventory/stock-entries`), si no `<uid>:<llave>`; con `deviceId` también se busca la vieja `<uid>:<llave>`. El doc lleva `reservedAt` (estable al retomar), `attemptAt`, `productId` (anotado tras `createProduct`, el reintento lo reutiliza), `released` (4xx tras el alta: conserva el producto) y `expiresAt` a 30 días (TTL en `firestore.indexes.json`). Proveedor activo, partida y unicidad (`assertProductsCreatable`) se validan antes del alta; `recordDirectEntry` revisa todos los productos en línea antes de crear el primero. `inventoryEntries.idempotencyKey` guarda la llave y `findAppliedEntry` solo empareja la misma llave o ninguna. Entradas y abonos a proveedor liberan la llave solo ante `AppError` < 500 (`isReleasableError`). `items` de las entradas: máx. 200.
- **Lotes de entrada (SPEC 59).** `batches.lotKey` = lote en mayúsculas sin espacios; el lote existente se decide dentro de la transacción de la entrada (consulta por `lotKey` y por las formas escritas para lotes viejos) y los nuevos usan id determinista `sha256(productId, lotKey, caducidad)` (`utils/batch-lot.ts`), así dos entradas simultáneas no parten el lote. Costo al sumar = promedio ponderado a 4 decimales. Mismo lote con otra caducidad: se acepta con `warnings: ['LOT_EXPIRY_MISMATCH']` (también `details.warnings` en `POST /v1/stock-entries`). Caducidad y fecha de pago se validan en el día de México; la caja manda `capturedAt` y la caducidad se compara contra ese día. Índice `batches [productId, lotKey]`. El prompt de facturas-RAG pide fechas DD/MM/AAAA (MM/AAAA = fin de mes) y el `cfdiUuid`.
- **Factura recapturada y cancelación de entrada (SPEC 58).** `POST /v1/stock-entries` responde 409 `ENTRY_POSSIBLE_DUPLICATE` (`details.existing = { entryId, createdAt }`) si la factura ya tiene una entrada no cancelada con el mismo producto, `lotKey` y cantidad con otra llave o sin llave; se reenvía con `confirmDuplicate: true` y la misma llave. `POST /v1/inventory/entries/:id/cancel` `{ reason ≥5 }` (admin/gerente): contramovimientos `entry_cancel` negativos por partida, baja `totalStock`, marca `cancelledAt/cancelledBy/cancelReason`, audita `inventory.entry_cancelled`; 400 si ya salieron piezas, 409 si ya estaba cancelada. Las canceladas no cuentan en compras, historial del producto ni duplicados. `invoices.folioKey` normalizado con unicidad por proveedor dentro de la transacción (las viejas siguen por texto). Contra-asiento en el libro de controlados: pendiente de SPEC 61.
- Paginación: `parsePagination` con **máx. 100** (excepción: el libro de control `GET /v1/inventory/controlled-ledger` admite hasta **1000** vía `parsePagination(..., { maxLimit })`). Para periodos más grandes existe la exportación CSV, no subir más el tope.
- CSV: siempre con `utils/csv.ts` (neutraliza fórmulas `=`/`+`/`-`/`@`, BOM + CRLF para Excel). Exportar el libro completo es admin/manager (`assertCanExportControlledLedger`). Listados empujan `from`/`to` a Firestore cuando aplica; enriquecer solo la página.
- Stock de producto: preferir `product.totalStock`; fallback a sumar lotes si falta el campo (docs viejos).
- Auth: `AuthGuard` exige `roleId` en perfil (migración legacy solo vía script/`internal/migrate-roles`). El guard **sí** arma `req.authUser` desde los custom claims para ahorrarse una lectura de `roles` por request, pero solo si el claim trae `roleId` y `permissionsVersion` iguales a los del perfil; si no coinciden, cae a Firestore. Sesión caduca a las **24:00 America/Mexico_City** del día de `auth_time` (refresco de ID token no la prolonga; hay que volver a iniciar sesión).
- **Caché del perfil en memoria del proceso.** `users.repository.ts` envuelve `getUserProfile` en `MemoryCache` ([utils/memory-cache.ts](functions/src/utils/memory-cache.ts)), TTL 60 s: el guard lee el perfil en **cada** request autenticada y eso solo era la mayor fuente de lecturas. Vive lo que viva la instancia (arranque en frío = vacía; dos instancias pueden discrepar hasta que expira el TTL). `createUserProfile` la llena y `updateUserProfile` la invalida. Toda ruta nueva que escriba un documento de usuario debe invalidar también (`invalidateUserProfileCache`): un `isActive` rancio es alguien recién revocado entrando igual. `MemoryCache` distingue `null` cacheado de ausencia de entrada (si no, cada uid inexistente releería Firestore) y tiene tope de entradas.
- **`permissionsVersion` (sello anti-claims-viejos).** Vive en `Role` y se copia a `UserProfile` y a los claims. Sube cuando cambian los permisos del rol (`updateRole` y `seedSystemRoles`, comparando con `permissionsEqual`, insensible al orden) y entonces `syncRoleUsersClaims` reemite claims y resella perfiles (`applyRoleToUser`). Sin el sello, quitar un permiso no surtía efecto hasta que el token expirara (hasta 1 h con el acceso ya retirado). Docs previos a la migración no traen el campo: valen 1, y mientras el perfil no esté sellado el guard simplemente no confía en los claims (degrada a una lectura, nunca a un permiso de más).
- **Área `pos` (mostrador) separada de `sales` (administración).** `pos:write`: `POST /v1/sales`, órdenes Point (`POST`/`DELETE /v1/payments/mercadopago/orders`), turno de caja completo (abrir, movimientos, lectura X, corte Z) y alta/edición de cliente en caja. `sales:write` se queda con anular, devoluciones, reembolso MP y configuración de terminales; `sales:read` con todos los listados. Motivo: con un área sola, habilitar la caja al cajero le daba también cancelar y reembolsar. `cashier` = `pos:write` + `sales:read` + `products/categories/inventory:read`; `manager` recibe `pos` por `buildAllWritePermissions()`; `admin` cortocircuita. Sigue vigente `assertCanAccessSession` (turno propio) y el gate por slug en anulación/devolución.
- **`permissionAreaSchema` (Zod) se deriva de `ALL_PERMISSION_AREAS`**, no es una lista aparte: cuando lo era, se quedó sin `patients`/`medicalRecords`/`appointments`/`directCharges` y la API devolvía 400 al crear un rol con esas áreas.
- **Arranque en frío del API:** la cadena de correo/reportes (`resend`, `react`, `@react-email/*`, ~6 MB) y Puppeteer/chromium entran solo con `await import()` dentro de los handlers. `index.ts` reexporta las funciones programadas, así que un import estático en `internal.controller` o `schedules` también lo carga en cada arranque del API. Verificar el grafo de imports antes de agregar imports ahí.
- **`index.ts` cachea la promesa del bootstrap pero no su rechazo:** si `createApp()` falla, se limpia para que el request siguiente reintente (antes esa instancia contestaba el mismo error hasta que Cloud Run la reciclaba). `express.json()` se construye una vez, no por petición.
- **`paginateQuery` (`utils/firestore-pagination.ts`) es la forma de paginar**: recibe una consulta **ya ordenada** (se usa la misma para leer y para `count()`, así `total` no supera lo listable) y lee solo hasta el final de la página. Aplicado en `products`, `patients`, `categories`, `suppliers`, `roles`, `users`, **siempre solo en la rama sin búsqueda** —con término de texto hay que ver el conjunto completo—. Agregar un filtro a esas listas obliga a agregar el índice `[filtro…, campoOrden]`. Orden UTF-8, no `localeCompare`.
- **Cursor (SPEC 08)**: `paginateQuery(query, map, page, limit, { after, order, countCacheKey, keep })` devuelve `{ items, total, nextCursor }`. `order` = los `orderBy` de la consulta; el id del documento desempata (`__name__`, mismo índice). `after` es un cursor opaco (base64url; inválido = 400); sin `after`, `page>1` sigue funcionando (lee `page×limit`). `total` por `count()` cacheado 60 s por `countCacheKey` (`clearPaginationCountCache()` en tests). Migrados: `GET /v1/sales` (sin `search`/`promotionReview`), `GET /v1/products` (sin búsqueda) y `GET /v1/inventory/movements` (sin `search`); `meta.nextCursor` ausente en la última página. Doc completa en el encabezado de `utils/firestore-pagination.ts`.
- **TTL declarado en `firestore.indexes.json` (`fieldOverrides`)**, no con `gcloud`: `saleIdempotencyKeys` (48 h, compartida por ventas y devoluciones), `mercadoPagoWebhookEvents` (72 h) y `directChargeIdempotencyKeys`. Los tres con `indexes: []` (nada consulta `expiresAt`; indexarlo sería una escritura de índice por documento a cambio de nada). **Ojo: `directCharges.expiresAt` es otro campo con el mismo nombre** —la caducidad del link de Checkout Pro, guardada en el cobro— y ponerle TTL borraría registros de pago.
- **Índices compuestos: 43 declarados.** Lo que hace falta lo decide qué filtros pueden aplicarse *juntos*. `listAuditLogs`, `listLedgerEntries`, `listInventoryCounts` y `listSaleReturns` usan `if/else if/else` a propósito para que solo una igualdad llegue a la consulta; convertirlos en `if` independientes obliga a declarar índices nuevos. `listStockMovements` sí combina (`productId` + `type` + orden) y por eso lleva el de tres campos.
- **Comprobantes de factura en Cloudflare R2** (`utils/r2.ts`, API compatible con S3). Enrutado **por prefijo**: `facturas/` → R2, cualquier otro → Firebase Storage; `isR2Path()` es el único interruptor y `uploadFile`/`getFileUrl`/`getSignedFileUrl`/`getFileMetadata` se ramifican ahí. Los comprobantes viejos siguen en `uploads/` y se abren igual, sin migrar. **Lo clínico NO se mueve** (dato de paciente, NOM-004). Ruta: `POST /v1/uploads/facturas` (permiso `uploads`, mismo interceptor). Sin las 4 variables `R2_*` cae a Firebase en vez de tumbar la caja. Endpoint derivado del `accountId`, región `auto` obligatoria, lecturas siempre por URL firmada (15 min) → **el bucket tiene que estar privado**. `@aws-sdk/client-s3` se carga con `await import()`: estático costaba ~47 ms en cada arranque en frío del API. Pruebas: `test/r2-storage.spec.ts`.
- **Storage: una llamada, no dos.** `getFileMetadata` valida existencia (mapea el 404 de GCS a `badRequest`) y devuelve los datos; ya no existe `assertFileExists`. `uploadFile` usa `resumable: false` (el archivo está acotado a 10 MB por el interceptor).
- **Catálogo paginado en Firestore** (`productsRepo.listProductsPage`): sin término de búsqueda no se lee la colección completa; orden por `name` (UTF-8, acentos después de la Z, ya no `localeCompare`) y `total` con `count()`. Depende de los índices `products [isActive, name]`, `[isActive, categoryId, name]`, `[categoryId, name]`. La rama `updatedSince` (sync del POS) sigue leyendo todo el delta a propósito. Cubierto por `test/products-list.spec.ts`.
- **TTL declarado en `firestore.indexes.json`** (`fieldOverrides`, `ttl: true`) para `saleIdempotencyKeys.expiresAt` (48 h) y `mercadoPagoWebhookEvents.expiresAt` (72 h) — ya no es un paso manual de `gcloud`; sin él ambas colecciones crecían sin tope.
- **Índices compuestos que faltaban** y ahora están en el repositorio: `auditLogs [entityId|userId, createdAt]`, `saleReturns [cashSessionId, createdAt]`, `controlledSalesLedger [saleId|productId, createdAt]`, `inventoryCounts [productIds CONTAINS, createdAt]`. El rango de `createdAt` entra siempre porque `from` tiene default.
- **`multer` no es dependencia; `busboy` sí** (era una dependencia fantasma que resolvía solo a través de multer). El archivo subido lo tipa `types/uploads.ts` (`UploadedFile`), no `Express.Multer.File`. Límites de Busboy: `fileSize`, `files`, `fields`, `parts`.
- **`firebase.json` solo despliega `lib/` + `package.json`**; `src`, `test`, `graphify-out`, configs y `service-account.json` quedan fuera (esta última también git-ignored en la raíz y en `functions/`).
- **Migración de roles:** `runRoleMigration()` = sembrar roles del sistema → backfill de `permissionsVersion` (también en roles personalizados) → sellar usuarios. Idempotente. `POST /v1/internal/migrate-roles` y `npm run migrate:roles` la corren y devuelven reporte (`rolesCreated`, `rolesUpdated`, `rolesBackfilled`, `rolesGrantedPos`, `usersMigrated`, `usersSkipped` con motivo). Slugs legados en un solo `LEGACY_ROLE_SLUG_MAP` (`inventory`→`manager`; admin/cashier/manager/doctor idénticos). **Cambiar `SYSTEM_ROLE_DEFINITIONS` obliga a correr la migración después de desplegar**, o los usuarios se quedan con el alcance viejo.
- Anular venta: solo rol slug `admin` (`assertCanVoidSale`); se rechaza si la venta ya tiene devoluciones.
- **Precios con impuestos incluidos.** `salePrice` es precio al público; el desglose se calcula hacia atrás en `utils/taxes.ts` (IEPS sobre la base, IVA sobre base+IEPS, residuo de redondeo a la base para que `base+iva+ieps === cobrado`). IVA 16%/0% por `hasIva`/`hasIvaZero`; IEPS con `product.iepsRate` obligatorio si `hasIeps` (se rechaza en catálogo y en venta). Descuento de venta se prorratea antes de impuestos. Resultado en `SaleItem.taxes`/`netAmount`/`saleDiscountShare` y `Sale.taxSummary` (`null` en ventas viejas, sin backfill).
- **Devoluciones parciales:** `POST /v1/sale-returns`, solo slugs `admin`/`manager` (`assertCanReturnSale`). Reingresa a los lotes originales, movimiento `return_in`, `sales.refundedTotal` acumulado y revalidado dentro de la transacción. Reembolso `card` llama a MP **antes** de la transacción con `idempotencyKey = refund:<fingerprint>` (retry seguro). Efectivo devuelto baja `cashInDrawer`; tarjeta/transferencia no. Devolver el resto paga el remanente exacto.
- **`outOfStock` = solo agotados con `minStock > 0`**, ordenados por mínimo descendente; los que están en cero sin mínimo van en **`unstocked`** (alfabético: es lista para depurar catálogo, no para actuar). Antes `outOfStock` no filtraba por mínimo y recogía todo el catálogo en cero: 211 renglones contra media docena de faltantes reales. `hasActionableAlerts` ignora `unstocked` a propósito (si no, el correo llegaba a diario sin nada que hacer). **Cambió el contrato de `GET /v1/inventory/alerts`**: `totals.outOfStockProducts` cuenta solo faltantes y se agregó `totals.unstockedProducts`. Pruebas: `test/inventory-controls.spec.ts` y `test/inventory-alerts-email.spec.tsx`.
- **Correos, tres reglas.** Un conteo sin dinero no se puede juzgar (anuladas van con importe); un porcentaje sin pesos no se puede accionar (el vs-mes-anterior lleva diferencia absoluta y total del mes previo); una columna larga de números es un muro y una barra es una forma (`byDay` con barra proporcional al mejor día, y dice que solo lista días con ventas).
- **Jest corre `*.spec.tsx`.** Las plantillas de correo se prueban renderizándolas con `react-dom/server` (devDependency): `@react-email/render` hace un `await import()` interno que el runtime CJS de Jest no resuelve sin `--experimental-vm-modules`.
- **Alertas de inventario:** `inventory-alerts.service` (vencidos, ventanas 30/60/90, stock bajo/agotado). Un lote cae solo en la ventana más chica que lo cubre. Función programada `dailyInventoryAlerts` 07:00 MX (256MiB, sin Puppeteer); no manda correo si no hay nada. Disparo manual `POST /v1/internal/reports/inventory-alerts?force=true`.
- **Conteo físico:** `POST /v1/inventory/counts` (admin/manager). Movimiento `adjustment_count` con cantidad **con signo**, nunca `exit_waste`. Lotes que cuadran quedan en el acta sin ajuste. Bitácora dentro de la misma transacción.
- **Controlados COFEPRIS:** `product.controlledGroup` I–VI (tabla de reglas en `constants/controlled.ts`). I–III exigen receta + folio + `prescriptionRetained: true`; IV solo receta; V/VI libres. `doctorLicense` = cédula de 7-8 dígitos. Libro de control en `controlledSalesLedger`, escrito en la transacción de la venta; anulación y devolución **contra-asientan** con cantidad negativa (nunca se borra un renglón).
- **Bitácora:** `audit.service` audita dinero, precios y accesos (no altas rutinarias). `recordAudit` traga su propio error para no tumbar la operación ya confirmada; `writeAuditInTransaction` cuando puede ser atómica; `diffFields` evita bitácoras vacías.
- **Pago mixto:** tarjeta paga `cardAmount` (monto de la order Point) y el efectivo cubre `total - cardAmount`; el cambio se calcula contra la parte en efectivo. `resolvePointPayment` corre **antes** de `resolveTender` (el monto de la order define la parte en efectivo). Se persisten `Sale.cashAmount` y `Sale.cardAmount`; al cajón solo entra `cashAmount` (ventas viejas: `amountReceived - change`).
- **El turno de caja es de quien lo abrió.** `assertCanAccessSession` (exportada desde `cash-sessions.service`) se aplica en consultas, movimientos, corte X/Z **y** en `createSale` / `createSaleReturn`: solo el cajero que abrió el turno o un admin puede cargarle ventas o devoluciones. En la venta se valida con el documento ya leído dentro de la transacción.
- **Corte X vs Z:** `GET :id/x-report` no deja rastro; `POST :id/x-report` persiste en `cashReadings` con folio `X-`. Ambos rechazan turno cerrado. HTML térmico 58/80mm en `cash-reports.service` (mismo formato que el ticket).
- **Reportes de gestión** (`analytics.service`, permiso `dashboard:read`): margen sobre `taxSummary.base` (el IVA no es ingreso), devoluciones restadas siempre, COGS desde `SaleItem.costAmount` (snapshot del `costPrice` del lote al vender; `null` si algún lote no tenía costo → cae en `salesWithoutCost`, no en utilidad 100%). `dead-stock` solo mira movimientos de **salida**.
- **GS1:** `utils/gs1.ts` parsea FNC1 / paréntesis / longitud fija; AI 17 con `DD=00` = fin de mes; GTIN-14 se normaliza a EAN-13. `POST /v1/inventory/scan` devuelve producto + ítem de entrada precargado + `existingBatchId`.
- Venta idempotente: `idempotencyKey` en body o header `Idempotency-Key` (opcional hoy). Doble chequeo — antes de consultar Mercado Pago y dentro de `runTransaction` (`transaction.create` de la llave junto con la venta). Misma llave + cobro distinto = `CONFLICT`. TTL de `expiresAt` se habilita con `gcloud firestore fields ttls update expiresAt --collection-group=saleIdempotencyKeys --enable-ttl`.
- Respuestas `{ data, meta? }` (interceptor global passthrough si ya viene envuelto).
- Textos en **español**. ESLint: comillas simples, indent **4**, máx. 100 cols.
- Validación Zod endurecida (nivel farmacia MX, helpers en `schemas/common.ts`): dinero a 2 decimales (`money`/`positiveMoney`), cantidades enteras positivas (`qty`), fechas `YYYY-MM-DD` (`isoDate`), `rfc` (regex 12-13, uppercase), `phoneMx` (10 dígitos), `usoCfdiSchema` (enum G01/G02/G03/I01/D01/S01). Contratos que cambiaron: **`lotNumber` obligatorio** en entradas de inventario, caducidad no puede estar en el pasado, `barcode` 8-14 dígitos, password requiere un número, slug de rol `^[a-z0-9-]+$`, pago `mixed` exige `amountReceived > 0` (el efectivo recibido, no el total).

## Firestore rules

Staff read / Admin-SDK write (`allow write: if false`) para catálogo, inventario, ventas, **saleReturns**, **inventoryCounts**, **controlledSalesLedger** (ambos solo admin/manager), **auditLogs** (solo admin), **cashReadings**, **invoices**, **cashSessions**. **`roles` y `pointOrders` niegan también la lectura** (el cliente no baja la matriz de permisos ni el dueño de una orden Point). Cliente SDK no escribe; todo muta por la Function `api`.

## Testing

- Jest + emulador Firestore (`npm test`). Tests en [functions/test/](functions/test/). **`maxWorkers: 1`**: en paralelo las suites se pelean por los locks de transacción del emulador (`ABORTED: Transaction lock timeout`).
- **Aislamiento entre suites**: [test/teardown-admin.ts](functions/test/teardown-admin.ts) vacía la base antes de cada archivo (`DELETE /emulator/v1/projects/<id>/databases/(default)/documents`). El emulador bloquea de forma *pesimista* (producción es optimista), así que con la base cargada dos transacciones sobre el mismo documento se serializan hasta agotar los 5 intentos del SDK. Ninguna suite debe depender de datos escritos por otra.
- `test/reports.spec.ts`: corte X/Z, reportes de gestión, escaneo GS1. `test/gs1.spec.ts`: parser puro.
- `test/inventory-controls.spec.ts`: alertas de caducidad/stock, conteo físico, reglas COFEPRIS + libro de control, bitácora.
- Cubre TX de inventario (entrada/salida, oversell concurrente), ventas FEFO, idempotencia de venta (retry, concurrencia, llave reciclada, aislamiento por cajero, retry con Point), desglose de impuestos (`test/taxes.spec.ts`, puro sin emulador), devoluciones parciales y tickets (`test/sale-returns.spec.ts`).
- Identidad y acceso: `test/auth-guard.spec.ts` (claims aceptados/descartados por `roleId` y `permissionsVersion`, sesión expirada, usuario desactivado, rutas públicas), `test/roles.spec.ts` (versionado de permisos, resincronización de claims, protecciones de `updateRole`), `test/users.spec.ts` (no desactivarse a sí mismo, no dejar la instalación sin admin, sellado de `permissionsVersion` al cambiar rol), `test/memory-cache.spec.ts` (TTL, `null` cacheado vs miss, tope de entradas).
- `npm run test:coverage` aplica `coverageThreshold` de `jest.config.js`. Con las suites aisladas la cifra es reproducible (±0.02 entre corridas), así que el piso global va justo por debajo de lo medido en vez de los 2 puntos de holgura que hacían falta antes. Gates estrictos donde importa: `auth.guard.ts` y `memory-cache.ts` al 100% de líneas, `users.service.ts` al 80%. `src/scripts/**` excluido.
- Resuelto (antes flake ~1/4): `sales.spec.ts › dos requests concurrentes con la misma llave produce una sola venta`. Era contención del emulador, no la lógica de idempotencia — confirmado forzando `maxAttempts: 1`, que lo hace fallar el 100% con `ABORTED: Transaction lock timeout`. Lo cerró el aislamiento entre suites; **no** se tocó `maxAttempts` en producción.
- CI: `.github/workflows/ci.yml` — `npm ci` → `lint` → `build` → `test:coverage` → `test:rules` desde la raíz (SPEC 33), con JDK 21 (Temurin) porque el emulador necesita JVM. Cobertura como artefacto 14 días.
- Deploy: `.github/workflows/deploy.yml` (SPEC 39) — CI verde en `main` → `farma-jyv-dev`; tag `v*` → CI de nuevo + resumen de PRs `requiere-paso-manual` + aprobación de `dev-jyv` (environment `production`) → `farma-jyv`. Índices primero con espera. WIF (sin llaves); variables por environment: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `FUNCTIONS_ENV_FILE` (sin credenciales; bloquea hasta que SPEC 35 declare los siete `defineSecret`). Liberación: RUNBOOK §10.
- `simulacro-restauracion.yml` (SPEC 43): día 1 de cada mes abre el issue del simulacro asignado a `dev-jyv` (checklist en `.github/simulacro-restauracion.md`).

## Secretos (Cloud Secret Manager, SPEC 35)

Declarados una vez en `functions/src/config/secrets.ts` (`defineSecret`), leídos con `.value()` en tiempo de ejecución vía los getters de `config/env.ts`. Nunca en un `.env` desplegable (`check-env-split.mjs` lo bloquea; `check-secrets.mjs` frena el deploy si falta alguno en el proyecto). Crear/rotar/acceso: RUNBOOK §11. Local: `functions/.secret.local`.

- `MIGRATE_SECRET` — protege `POST /v1/internal/*` (`api`).
- `MERCADOPAGO_ACCESS_TOKEN` — Access Token de Mercado Pago (Point / órdenes) (`api`).
- `MERCADOPAGO_WEBHOOK_SECRET` — valida firmas `x-signature` del webhook `orders` (`api`). Sin valor todavía: el espacio reservado tiene un blanco y en producción el webhook se rechaza.
- `RESEND_API_KEY` — reportes por correo (`api` + las 4 programadas que mandan correo).
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — token de R2 para facturas (`api`); sin ellas, `uploads/`.
- `OPENROUTER_API_KEY` — asistente y facturas-RAG (`api`); sin ella, 503.

## Variables de entorno ([functions/.env](functions/.env) / `.env.<proyecto>`, no versionados, sin secretos)

- `CORS_ORIGINS` — allowlist separado por comas.
- `APP_CHECK_MODE` — `off` | `log` (SPEC 41). `AppCheckGuard` solo registra peticiones sin `X-Firebase-AppCheck` válido, nunca rechaza. Sin la variable: `log` desplegado, `off` en emulador. Consulta guardada: `docs/logging/app-check-sin-token.sql` (RUNBOOK §13).
- `FIRESTORE_BACKUP_BUCKET` — bucket destino del respaldo nocturno, sin `gs://`. Sin él `dailyFirestoreBackup` truena en vez de adivinar. Hoy: `farma-jyv-respaldos-firestore`.
- `MERCADOPAGO_PUBLIC_KEY` — Public Key (frontend); el backend no la consume.
- `MERCADOPAGO_USER_ID` — User ID de la cuenta (crear sucursales vía API). Solo en `.env.<proyecto>`.
- `R2_ACCOUNT_ID` / `R2_BUCKET` — cuenta y bucket de R2 (no secretos).
- `RECEIPT_STORE_NAME` / `RECEIPT_STORE_RFC` / `RECEIPT_STORE_ADDRESS` / `RECEIPT_STORE_PHONE` / `RECEIPT_FOOTER` — encabezado y pie del ticket (opcionales; el nombre cae a `Farmacia JyV`).
- `REPORTS_EMAIL_FROM` — remitente verificado en Resend (pruebas: `onboarding@resend.dev`).
- `REPORTS_EMAIL_TO` — destinatarios de reportes, separados por comas.

## Mercado Pago Point

Endpoints bajo `/v1/payments/mercadopago` (permiso `sales`):

| Método | Ruta | Uso |
|---|---|---|
| GET | `/devices` | Listar terminales (`?storeId=&posId=`) |
| PATCH | `/devices/operating-mode` | Activar `PDV` / `STANDALONE` |
| POST | `/stores` | Crear sucursal |
| POST | `/pos` | Crear caja |
| POST | `/orders` | Enviar cobro a la TPV (`Idempotency-Key` / `idempotencyKey` recomendado en retries; `externalReference` solo `[A-Za-z0-9_-]`) |
| GET | `/orders/:id` | Consultar estado |
| DELETE | `/orders/:id` | Cancelar order |
| POST | `/orders/:id/refund` | Reembolso total o parcial |
| POST | `/webhooks` | Público; topic `orders` |

Flujo físico: crear sucursal + caja → asociar terminal (app MP / QR) → `operating-mode: PDV` → reiniciar TPV → crear orders.

Al registrar venta `card`/`mixed`, `cardPaymentReference` **debe ser el id de la order Point**. El backend:
1. Verifica que no esté ya ligada a otra venta.
2. Consulta MP y exige `status=processed`.
3. Valida monto (`card` = total; `mixed` ≤ total).
4. Persiste `pointPayment: { orderId, paymentId, status, amount, terminalId, externalReference }` además de `cardPaymentReference`.

## Reportes de ventas por correo

- Funciones programadas (v2 `onSchedule`, TZ `America/Mexico_City`) exportadas en `index.ts`:
  `dailySalesReport` (00:10, día anterior) y `monthlySalesReport` (00:20 día 1, mes anterior).
  `dailyStatsIntegrityCheck` (07:10, 256MiB, `schedules/daily-stats.schedule.ts`): compara `dailyStats` con las ventas de los últimos 7 días y deja un log ERROR `ALERTA dailyStats: diferencia en <ymd>` por día con diferencia (`checkDailyStatsIntegrity`). El total del mes anterior del reporte mensual sale de `dailyStats`. Rollout (SPEC 04, operativo): tras 3 días de ventas reales, `npm run backfill:daily-stats -- --dry-run` debe imprimir `Días con diferencia: 0`; entonces activar `DASHBOARD_SALES_FROM_STATS=true` en `functions/.env.farma-jyv` y desplegar. Cuando el job lleve 30 días sin alertas, retirar el flag y la ruta por ventas.
  Aparte, `dailyPromotionsMaintenance` (07:05, 256MiB, `schedules/promotions.schedule.ts`): baja de promos vencidas + correo con su desempeño y las que terminan en 24 h.
- Contenido de ambos: **farmacia vs consultorio** (`branches`, desde `pharmacyTotal`/`servicesTotal`/`commissionTotal` denormalizados; una venta mixta cuenta en las dos ramas), **gastos desglosados por categoría** (solo `cashMovements` con `type: 'expense'`; retiros y depósitos NO son gasto), `netResult = vendido − devuelto − gastado`, ticket promedio top 10 de productos y folios de ventas con `promotionReview` (promo aceptada fuera de vigencia). El mensual suma comparativo contra el mes anterior (`changeRate: null` si aquel fue cero), mejor día, promedio por día **con ventas** y top 5 de servicios. El diario suma el detalle de cada gasto.
- Etiquetas y orden de las categorías de gasto: `constants/expenses.ts` (`EXPENSE_CATEGORY_LABELS` / `EXPENSE_CATEGORY_ORDER`), compartido con el POS.
- Componentes de correo en `emails/components/report-ui.tsx` (estilos inline y tablas: Gmail borra `<style>` y Outlook no soporta flex/grid).
- Pipeline: `sales-reports.service` (agregación) → `report-pdf.service` (Puppeteer: local `puppeteer`, Cloud Functions `puppeteer-core` + `@sparticuz/chromium`, 1GiB) → `emails/sales-report.email.tsx` (React Email) → `email.service` (Resend, PDF adjunto).
- Disparo manual para pruebas: `POST /v1/internal/reports/daily?date=YYYY-MM-DD` y `POST /v1/internal/reports/monthly?month=YYYY-MM`, guardados con `x-migrate-secret`.
- **Correo del contador (SPEC 45):** `monthlyAccountantReport` (00:40 día 1, 1GiB, 300 s, `schedules/accountant-report.schedule.ts`) → `accountant-report-sender.service` (import diferido). Destinatarios: usuarios activos con `monthlyReportEmail == true` (una consulta de igualdades, sin índice compuesto) cuyo rol concede `reportDownloads:read` (admin cuenta por slug); **no** usa `REPORTS_EMAIL_TO`. Un correo por destinatario con 7 adjuntos (`ventas-farmacia-`, `ventas-consultorio-`, `compras-AAAA-MM.{pdf,xlsx}` e `iva-por-producto-AAAA-MM.xlsx`, solo Excel para no lanzar Chromium otra vez; su renglón en el cuerpo es el IVA trasladado y el número de conceptos) generados con `exportReportBundle` (una carga por reporte, `roleSlug: 'admin'`, `generatedBy: 'Sistema'`) y cuerpo `emails/accountant-report.email.tsx`. Sin destinatarios no genera ni envía; un envío fallido se registra, sigue con los demás y el job termina con error. Disparo manual: función HTTP aparte `accountantReportTrigger` (1GiB, 300 s, `maxInstances: 1`), `POST ?month=YYYY-MM` con `x-migrate-secret`; reenvía a todos. Antes era ruta de `api` y en 512MiB/60 s los tres PDF tiraban la instancia (`Internal Server Error` sin cuerpo). `sendReportEmail` acepta `to?` y `attachments?`.
- `tsconfig` compila JSX (`react-jsx`); lint incluye `.tsx`.

## Respaldo de Firestore

- `dailyFirestoreBackup` ([functions/src/schedules/backup.schedule.ts](functions/src/schedules/backup.schedule.ts)): 02:00 CDMX, 256 MiB, `retryCount: 1`.
- Usa la **exportación gestionada** (`v1.FirestoreAdminClient.exportDocuments`), no lee documentos. Solo lanza la operación; el volcado corre del lado de Google, por eso basta `timeoutSeconds: 120`. Import dinámico dentro del handler para no cargar el cliente admin en cada arranque en frío de la API.
- Base completa (sin `collectionIds`): con una lista, cada colección nueva nace sin respaldo.
- Destino `gs://$FIRESTORE_BACKUP_BUCKET/firestore-backups/<ISO>`.
- **Retención fuera del código**: regla de ciclo de vida del bucket, 30 días, solo sobre el prefijo `firestore-backups/` — así los respaldos manuales (`manual/`, `pre-borrado-*`) sobreviven.
- Se factura como una lectura por documento exportado: es un costo diario fijo proporcional al tamaño de la base. Un escalón de lecturas de madrugada es esto.
- Restauración, permisos IAM y respaldo manual: [RUNBOOK.md](RUNBOOK.md) §4.
- **SPEC 31/43 (declarado, sin aplicar):** PITR 7 días (`scripts/ops/31-pitr.sh`), copia diaria de `firestore-backups/` a un bucket de un proyecto aislado (`farma-jyv-respaldos`, nombre a confirmar) por Storage Transfer con rol sin `delete`, recuperación por PITR documento a documento (`npm run pitr:restore`, en seco por defecto) y simulacro mensual (`scripts/ops/restore-drill.mjs`, rechaza `farma-jyv`/`farma-jyv-dev` como destino).
- **Log de funciones programadas:** todas van envueltas en `monitoredJob` (`schedules/scheduled-job.ts`) → `scheduled_job.finished` con `job`/`outcome`; de ahí salen las alertas de SPEC 32 (métrica `farmajyv_scheduled_job_runs`, `scripts/ops/scheduled-jobs.json`). RUNBOOK §7.
- **SPEC 34/42:** consulta de arranques en frío y dashboard de instancias en `scripts/ops/`; reportes de solo lectura `node scripts/ops/reports.mjs cold-start|instances`. RUNBOOK §8–§9.

## Pendientes conocidos

- Módulo `doctor` stub (el consultorio real vive en `modules/clinic`).
- Horario de atención del consultorio hardcodeado en `constants/clinic.ts` (lun-vie 9-14 y 16-20, sáb 9-13, dom cerrado). Si se vuelve configurable por doctor, mover a una colección `clinicSettings`.
- `medicalRecordAttachment.sizeBytes` queda en `0` cuando el archivo se adjunta por ruta ya subida a `/v1/uploads` (Storage no lo reporta en ese flujo); la subida directa a la nota sí lo guarda.
- `resolveTender` exige que el efectivo recibido cubra el total completo incluso en pago `mixed` (donde parte la paga la tarjeta). Revisar la semántica de mixto antes de tocar el cálculo de cambio y el cajón.
- `idempotencyKey` de venta es opcional por compatibilidad; volverla obligatoria cuando el frontend la envíe siempre. Falta habilitar la política TTL en `saleIdempotencyKeys`.
- Backfill de `totalStock` / `productIds` / `batches.supplierId`: script listo (`npm run backfill:denormalized`, idempotente, `--dry-run` / `--force` / `--only=`). **Falta ejecutarlo en producción** y luego quitar los fallbacks.
- `products.service` lee `salesRepo`/`entriesRepo`/`invoicesRepo` para el historial de producto (frontera de dominio borrosa, sin ciclo). Extraer a `product-history.service.ts` si crece.

### Tras specs 31–44 (desplegados el 2026-11-02)

- **Rotar credenciales de producción (SPEC 35, RUNBOOK §11.3).** Las de Mercado Pago, Resend, R2 y OpenRouter se **copiaron** del `.env` a Secret Manager sin rotar; `MIGRATE_SECRET` sí es nuevo. Emitir valores nuevos en cada proveedor → `secrets:set` → deploy → verificar → revocar el viejo. SPEC 35 no queda cerrado hasta entonces.
- **`TOKEN_API` en `functions/.env.farma-jyv`:** el código no lo usa y no está entre los siete secretos. Decidir si se borra o se migra.
- **Publicar la actualización del POS a las cajas** (`release:win` / `release:mac`). Sin ella no llegan el diagnóstico (SPEC 36), la última copia local (SPEC 37) ni `openCashSessionId` (SPEC 44).
- **App Check (SPEC 41, RUNBOOK §13):** crear la clave de reCAPTCHA Enterprise, registrar el panel en App Check, poner `appCheck.siteKey` en los `environment*.ts` del panel y guardar la consulta de Log Analytics.
- **Arranque en frío (SPEC 34, RUNBOOK §8):** la medición de 14 días empezó el 2026-11-02; decidir `minInstances` al cerrarla (`node scripts/ops/reports.mjs cold-start`).
- **Borrar las rutas PDF viejas de `api` (SPEC 38 req. 7, RUNBOOK §12):** cuando el panel con `pdfApiUrl` lleve días en producción, PR aparte con la prueba del grafo de imports.
- **Primer simulacro de restauración (SPEC 43, RUNBOOK §4):** confirma que los respaldos sirven; con él, SPEC 31, 32 y 43 pasan a Implemented. El issue mensual lo abre `simulacro-restauracion.yml`.
- **Canal de correo duplicado en `farma-jyv-respaldos`:** la alerta de la copia externa notifica dos veces al mismo correo; dejar un solo canal.
- **Presupuesto en MXN 95** (≈ US$5; la cuenta factura en pesos): revisar el monto si el aviso del 50 % llega todos los meses.

### Tras SPEC 45 (rol contador, pendiente de desplegar)

- `npm run migrate:roles` tras el deploy (área `reportDownloads`, rol `accountant`; el gerente no cambia de versión porque su lista no cambia).
- Política de alerta de `monthlyAccountantReport`: `node scripts/ops/gcp.mjs alerts --project <p> --apply` (dev primero) y pegar el id en RUNBOOK §7.
- **Verificar un dominio en Resend**: `REPORTS_EMAIL_FROM` de producción es `onboarding@resend.dev`, que solo entrega al dueño de la cuenta Resend; sin dominio verificado el correo del contador falla (y el job alerta). RUNBOOK §16.
- Las reglas de Firestore (`isStaff()`) dejan al contador, como a cualquier rol con claim, leer `categories`/`suppliers`/`products` desde el SDK cliente. El panel no lo usa para él; si se quiere cerrar, es un cambio de reglas aparte.

## Hallazgos de seguridad abiertos (revisión 2026-08-04)

- `verifyWebhookSignature` sin `MERCADOPAGO_WEBHOOK_SECRET` (o con el espacio reservado en blanco) rechaza en producción y acepta sin firma solo fuera de producción; la ruta del webhook es `@Public()`.
- El id de order de MP se interpola sin codificar en la ruta de la API (`mpRequest`); no explotable hoy porque `mapOrder` proyecta solo siete escalares, pero falta `encodeURIComponent` o regex en el schema.

## Decisiones cerradas

- **CFDI 4.0: no se construye todavía** (2026-08-04). Los datos ya están listos (desglose por partida, `usoCfdi`, `billing`). Al retomar: elegir PAC (Facturama recomendado por API REST y sandbox) y meter los datos del emisor en `.env` con el patrón `RECEIPT_*` (RFC, régimen fiscal, CP de expedición, serie/folio).

- **Fachadas Nest `@Injectable`: descartado** (medido 2026-08-03). Cero ciclos entre services; 5 aristas cross-service, todas unidireccionales (`auth→roles`, `users→roles`, `inventory→products` solo para producto inline, `sales→mercado-pago`, `sales-report-sender→email`/`report-pdf`); cada controller importa 1 service (2 en `users` e `internal`). La capa de dominio sigue siendo funciones planas. Reabrir solo si aparece un ciclo de imports o si hace falta sustituir/mockear un service en tests.

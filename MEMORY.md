# MEMORY.md

Contexto persistente del proyecto **FarmaJyV Backend** para retomar trabajo rápidamente. Hechos derivados del código; actualízalo cuando cambien. Detalle de arquitectura en [CLAUDE.md](CLAUDE.md), objetivos en [GOALS.md](GOALS.md).

## Datos clave

- **Proyecto Firebase:** `farma-jyv` (ver [.firebaserc](.firebaserc)).
- **Runtime:** Node 22, TypeScript, **NestJS 11** sobre Express 5, Firebase Functions v2 (`onRequest`, región `us-central1`, **512MiB**).
- **Entry point:** todo el código en [functions/](functions/); la función exportada es `api` en [functions/src/index.ts](functions/src/index.ts). Bootstrap Nest en [functions/src/app.ts](functions/src/app.ts) (`logger: false`) + [functions/src/app.module.ts](functions/src/app.module.ts).
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

## Endpoints (montados bajo `/v1`, servidos por controllers Nest en `src/modules/`)

`auth`, `categories`, `products`, `inventory`, `invoices`, `uploads`, `sales`, `sale-returns`, `suppliers`, `users`, `roles`, `doctor`, `internal`, `cash-sessions`, `payments`, `patients`, `medical-records`, `appointments`, más `GET /v1/health`.

Consultorio (`modules/clinic`, áreas de permiso `patients` / `medicalRecords` / `appointments`):
- `GET|POST /v1/patients`, `GET|PATCH /v1/patients/:id`, `GET /v1/patients/:id/overview` (conteos para la ficha), `GET /v1/patients/:id/records` (línea de tiempo, exige `medicalRecords:read`).
- `GET|POST /v1/medical-records`, `GET|PATCH /v1/medical-records/:id`, `POST /v1/medical-records/:id/attachments` (multipart campo `file`, guarda en `clinical/<patientId>/<recordId>/`), `GET /v1/medical-records/:id/attachments/:attachmentId/url` (URL firmada bajo demanda, no persistida), `DELETE` del adjunto.
- `GET|POST /v1/appointments`, `GET /v1/appointments/calendar?from&to&doctorId` (rango completo, tope 92 días), `GET /v1/appointments/availability?date&doctorId&durationMinutes` (huecos libres), `GET /v1/appointments/doctors` (existe porque `GET /users` exige `users:read`, que el doctor no tiene), `GET /v1/appointments/:id`, `PATCH /v1/appointments/:id`, `POST :id/reschedule`, `POST :id/status`.

Caja: `GET|POST /v1/cash-sessions/:id/x-report` (vista previa / lectura registrada), `GET /v1/cash-sessions/:id/x-readings`; `POST :id/close` (Z) devuelve también `html`.
Reportes: `GET /v1/reports/{sales-summary,profit,top-products,by-cashier,dead-stock}` (permiso **`dashboard:read`**).
Escaneo: `POST /v1/inventory/scan` (GS1-128 / DataMatrix o código plano).

Exportación: `GET /v1/inventory/controlled-ledger/export?from&to&group&productId` → CSV del periodo completo (archivo, sin envoltorio `{ data }`), solo admin/manager.

Inventario: `GET /v1/inventory/alerts?windows=30,60,90`, `POST|GET /v1/inventory/counts`, `GET /v1/inventory/counts/:id`, `GET /v1/inventory/controlled-ledger`. Bitácora: `GET /v1/audit-logs` (permiso `users:read`).

Ticket imprimible: `GET /v1/sales/:id/receipt` y `GET /v1/sale-returns/:id/receipt` (`?width=58|80`) devuelven `{ receipt, html }` (JSON + HTML para rollo térmico, sin Puppeteer).

Alta canónica de personal: `POST /users`. `POST /auth/register-staff` es alias.

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
- Paginación: `parsePagination` con **máx. 100** (excepción: el libro de control `GET /v1/inventory/controlled-ledger` admite hasta **1000** vía `parsePagination(..., { maxLimit })`). Para periodos más grandes existe la exportación CSV, no subir más el tope.
- CSV: siempre con `utils/csv.ts` (neutraliza fórmulas `=`/`+`/`-`/`@`, BOM + CRLF para Excel). Exportar el libro completo es admin/manager (`assertCanExportControlledLedger`). Listados empujan `from`/`to` a Firestore cuando aplica; enriquecer solo la página.
- Stock de producto: preferir `product.totalStock`; fallback a sumar lotes si falta el campo (docs viejos).
- Auth: `AuthGuard` exige `roleId` en perfil (migración legacy solo vía script/`internal/migrate-roles`). El guard **sí** arma `req.authUser` desde los custom claims para ahorrarse una lectura de `roles` por request, pero solo si el claim trae `roleId` y `permissionsVersion` iguales a los del perfil; si no coinciden, cae a Firestore. Sesión caduca a las **24:00 America/Mexico_City** del día de `auth_time` (refresco de ID token no la prolonga; hay que volver a iniciar sesión).
- **`permissionsVersion` (sello anti-claims-viejos).** Vive en `Role` y se copia a `UserProfile` y a los claims. Sube cuando cambian los permisos del rol (`updateRole` y `seedSystemRoles`, comparando con `permissionsEqual`, insensible al orden) y entonces `syncRoleUsersClaims` reemite claims y resella perfiles (`applyRoleToUser`). Sin el sello, quitar un permiso no surtía efecto hasta que el token expirara (hasta 1 h con el acceso ya retirado). Docs previos a la migración no traen el campo: valen 1, y mientras el perfil no esté sellado el guard simplemente no confía en los claims (degrada a una lectura, nunca a un permiso de más).
- **Área `pos` (mostrador) separada de `sales` (administración).** `pos:write`: `POST /v1/sales`, órdenes Point (`POST`/`DELETE /v1/payments/mercadopago/orders`), turno de caja completo (abrir, movimientos, lectura X, corte Z) y alta/edición de cliente en caja. `sales:write` se queda con anular, devoluciones, reembolso MP y configuración de terminales; `sales:read` con todos los listados. Motivo: con un área sola, habilitar la caja al cajero le daba también cancelar y reembolsar. `cashier` = `pos:write` + `sales:read` + `products/categories/inventory:read`; `manager` recibe `pos` por `buildAllWritePermissions()`; `admin` cortocircuita. Sigue vigente `assertCanAccessSession` (turno propio) y el gate por slug en anulación/devolución.
- **`permissionAreaSchema` (Zod) se deriva de `ALL_PERMISSION_AREAS`**, no es una lista aparte: cuando lo era, se quedó sin `patients`/`medicalRecords`/`appointments`/`directCharges` y la API devolvía 400 al crear un rol con esas áreas.
- **Arranque en frío del API:** la cadena de correo/reportes (`resend`, `react`, `@react-email/*`, ~6 MB) y Puppeteer/chromium entran solo con `await import()` dentro de los handlers. `index.ts` reexporta las funciones programadas, así que un import estático en `internal.controller` o `schedules` también lo carga en cada arranque del API. Verificar el grafo de imports antes de agregar imports ahí.
- **`index.ts` cachea la promesa del bootstrap pero no su rechazo:** si `createApp()` falla, se limpia para que el request siguiente reintente (antes esa instancia contestaba el mismo error hasta que Cloud Run la reciclaba). `express.json()` se construye una vez, no por petición.
- **`paginateQuery` (`utils/firestore-pagination.ts`) es la forma de paginar**: recibe una consulta **ya ordenada** (se usa la misma para leer y para `count()`, así `total` no supera lo listable) y lee solo hasta el final de la página. Aplicado en `products`, `patients`, `categories`, `suppliers`, `roles`, `users`, **siempre solo en la rama sin búsqueda** —con término de texto hay que ver el conjunto completo—. Agregar un filtro a esas listas obliga a agregar el índice `[filtro…, campoOrden]`. Orden UTF-8, no `localeCompare`.
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
- **El correo de alertas separa agotado-con-mínimo de agotado-sin-mínimo.** `outOfStock` del servicio no filtra por `minStock` (`lowStock` sí), así que recoge todo el catálogo en cero —211 en producción—. La plantilla lista como pedido solo lo que tiene mínimo, ordena por faltante (`minStock - totalStock`) y resume el resto en una cifra. Truncado explícito en todas las secciones. Prueba: `test/inventory-alerts-email.spec.tsx` (Jest ya corre `*.spec.tsx`; se renderiza con `react-dom/server` porque `@react-email/render` hace un `await import()` que el runtime CJS de Jest no resuelve).
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

Staff read / Admin-SDK write (`allow write: if false`) para catálogo, inventario, ventas, **saleReturns**, **inventoryCounts**, **controlledSalesLedger** (ambos solo admin/manager), **auditLogs** (solo admin), **cashReadings**, **invoices**, **cashSessions**. Cliente SDK no escribe; todo muta por la Function `api`.

## Testing

- Jest + emulador Firestore (`npm test`). Tests en [functions/test/](functions/test/). **`maxWorkers: 1`**: en paralelo las suites se pelean por los locks de transacción del emulador (`ABORTED: Transaction lock timeout`).
- `test/reports.spec.ts`: corte X/Z, reportes de gestión, escaneo GS1. `test/gs1.spec.ts`: parser puro.
- `test/inventory-controls.spec.ts`: alertas de caducidad/stock, conteo físico, reglas COFEPRIS + libro de control, bitácora.
- Cubre TX de inventario (entrada/salida, oversell concurrente), ventas FEFO, idempotencia de venta (retry, concurrencia, llave reciclada, aislamiento por cajero, retry con Point), desglose de impuestos (`test/taxes.spec.ts`, puro sin emulador), devoluciones parciales y tickets (`test/sale-returns.spec.ts`).

## Variables de entorno ([functions/.env](functions/.env), no versionado)

- `CORS_ORIGINS` — allowlist separado por comas.
- `MIGRATE_SECRET` — protege `POST /v1/internal/migrate-roles`.
- `MERCADOPAGO_ACCESS_TOKEN` — Access Token de Mercado Pago (Point / órdenes).
- `MERCADOPAGO_PUBLIC_KEY` — Public Key (frontend); el backend no la consume.
- `MERCADOPAGO_USER_ID` — User ID de la cuenta (crear sucursales vía API).
- `MERCADOPAGO_WEBHOOK_SECRET` — opcional; valida firmas `x-signature` del webhook `orders`.
- `RECEIPT_STORE_NAME` / `RECEIPT_STORE_RFC` / `RECEIPT_STORE_ADDRESS` / `RECEIPT_STORE_PHONE` / `RECEIPT_FOOTER` — encabezado y pie del ticket (opcionales; el nombre cae a `Farmacia JyV`).
- `RESEND_API_KEY` — API key de Resend para reportes por correo.
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
- Contenido de ambos: **farmacia vs consultorio** (`branches`, desde `pharmacyTotal`/`servicesTotal`/`commissionTotal` denormalizados; una venta mixta cuenta en las dos ramas), **gastos desglosados por categoría** (solo `cashMovements` con `type: 'expense'`; retiros y depósitos NO son gasto), `netResult = vendido − devuelto − gastado`, ticket promedio y top 10 de productos. El mensual suma comparativo contra el mes anterior (`changeRate: null` si aquel fue cero), mejor día, promedio por día **con ventas** y top 5 de servicios. El diario suma el detalle de cada gasto.
- Etiquetas y orden de las categorías de gasto: `constants/expenses.ts` (`EXPENSE_CATEGORY_LABELS` / `EXPENSE_CATEGORY_ORDER`), compartido con el POS.
- Componentes de correo en `emails/components/report-ui.tsx` (estilos inline y tablas: Gmail borra `<style>` y Outlook no soporta flex/grid).
- Pipeline: `sales-reports.service` (agregación) → `report-pdf.service` (Puppeteer: local `puppeteer`, Cloud Functions `puppeteer-core` + `@sparticuz/chromium`, 1GiB) → `emails/sales-report.email.tsx` (React Email) → `email.service` (Resend, PDF adjunto).
- Disparo manual para pruebas: `POST /v1/internal/reports/daily?date=YYYY-MM-DD` y `POST /v1/internal/reports/monthly?month=YYYY-MM`, guardados con `x-migrate-secret`.
- `tsconfig` compila JSX (`react-jsx`); lint incluye `.tsx`.

## Pendientes conocidos

- Módulo `doctor` stub (el consultorio real vive en `modules/clinic`).
- Horario de atención del consultorio hardcodeado en `constants/clinic.ts` (lun-vie 9-14 y 16-20, sáb 9-13, dom cerrado). Si se vuelve configurable por doctor, mover a una colección `clinicSettings`.
- `medicalRecordAttachment.sizeBytes` queda en `0` cuando el archivo se adjunta por ruta ya subida a `/v1/uploads` (Storage no lo reporta en ese flujo); la subida directa a la nota sí lo guarda.
- `resolveTender` exige que el efectivo recibido cubra el total completo incluso en pago `mixed` (donde parte la paga la tarjeta). Revisar la semántica de mixto antes de tocar el cálculo de cambio y el cajón.
- `idempotencyKey` de venta es opcional por compatibilidad; volverla obligatoria cuando el frontend la envíe siempre. Falta habilitar la política TTL en `saleIdempotencyKeys`.
- Backfill de `totalStock` / `productIds` / `batches.supplierId`: script listo (`npm run backfill:denormalized`, idempotente, `--dry-run` / `--force` / `--only=`). **Falta ejecutarlo en producción** y luego quitar los fallbacks.
- `products.service` lee `salesRepo`/`entriesRepo`/`invoicesRepo` para el historial de producto (frontera de dominio borrosa, sin ciclo). Extraer a `product-history.service.ts` si crece.

## Hallazgos de seguridad abiertos (revisión 2026-08-04)

- `verifyWebhookSignature` falla **abierto** si `MERCADOPAGO_WEBHOOK_SECRET` no está configurado; la ruta del webhook es `@Public()`.
- El id de order de MP se interpola sin codificar en la ruta de la API (`mpRequest`); no explotable hoy porque `mapOrder` proyecta solo siete escalares, pero falta `encodeURIComponent` o regex en el schema.

## Decisiones cerradas

- **CFDI 4.0: no se construye todavía** (2026-08-04). Los datos ya están listos (desglose por partida, `usoCfdi`, `billing`). Al retomar: elegir PAC (Facturama recomendado por API REST y sandbox) y meter los datos del emisor en `.env` con el patrón `RECEIPT_*` (RFC, régimen fiscal, CP de expedición, serie/folio).

- **Fachadas Nest `@Injectable`: descartado** (medido 2026-08-03). Cero ciclos entre services; 5 aristas cross-service, todas unidireccionales (`auth→roles`, `users→roles`, `inventory→products` solo para producto inline, `sales→mercado-pago`, `sales-report-sender→email`/`report-pdf`); cada controller importa 1 service (2 en `users` e `internal`). La capa de dominio sigue siendo funciones planas. Reabrir solo si aparece un ciclo de imports o si hace falta sustituir/mockear un service en tests.

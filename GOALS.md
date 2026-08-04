# GOALS.md

Objetivos del proyecto **FarmaJyV Backend**, inferidos del código actual. Este archivo describe el "para qué" del sistema; la arquitectura del "cómo" vive en [CLAUDE.md](CLAUDE.md).

## Objetivo principal

Proveer la API REST que da soporte a la gestión de una farmacia: catálogo de productos, control de inventario por lotes, punto de venta, compras a proveedores y administración de usuarios/roles. Todo corre como una sola Cloud Function de Firebase (`api`) sobre Firestore, con la app NestJS montada sobre Express.

## Objetivos funcionales

- **Catálogo de productos** — alta/edición/baja lógica de productos con SKU, código de barras, ingrediente activo, concentración, precios e impuestos (IVA / IVA cero / IEPS). Búsqueda por múltiples campos.
- **Inventario por lotes (FEFO)** — el stock se controla por lote (`batches`: producto + lote + caducidad + cantidad), no en el producto. Las salidas priorizan el lote que caduca primero (First-Expired-First-Out).
- **Trazabilidad total** — cada movimiento de stock (`entry`, `exit_waste`, `exit_expiry`, `sale_adjustment`, `return_in`, `adjustment_count`) queda registrado en `stockMovements` para auditoría.
- **Alertas de inventario** — caducidades por ventana (30/60/90 días), lotes ya vencidos con existencia, stock bajo y agotados; consulta por API y resumen diario por correo a las 07:00.
- **Conteo físico** — toma de inventario que ajusta cada lote a lo contado con movimiento `adjustment_count` con signo y acta con folio; el descuadre no se disfraza de merma.
- **Medicamentos controlados (COFEPRIS)** — grupos I–VI en el producto, reglas de receta/folio/retención por grupo, cédula profesional validada y libro de control auditable con contra-asientos en anulaciones y devoluciones. El libro se consulta paginado y se exporta completo en CSV para entregarlo en una revisión (exportación reservada a admin/gerente).
- **Corte de caja X y Z** — lectura parcial del turno sin cerrarlo (registrada con folio para saber quién revisó la caja) y cierre con conteo y diferencia; ambos imprimibles en rollo térmico.
- **Reportes de gestión** — resumen de ventas por método y por día, utilidad y margen sobre la base sin impuestos, más vendidos, desempeño por cajero y productos sin movimiento.
- **Captura por escáner** — lectura de códigos GS1-128 / DataMatrix para precargar producto, lote y caducidad en la entrada de inventario en lugar de teclearlos.
- **Bitácora de acciones** — registro de dinero (anulaciones, descuentos sobre el tope, devoluciones, cortes con diferencia, ajustes de conteo), precios y accesos (roles, permisos, estado de usuario).
- **Compras y proveedores** — entradas de inventario ligadas a una factura y proveedor; se registra el último precio de costo por proveedor.
- **Cobro idempotente** — `POST /v1/sales` acepta una llave de idempotencia (campo `idempotencyKey` o header `Idempotency-Key`): un retry de red devuelve la venta original en lugar de duplicarla y volver a descontar stock. La llave se registra en la misma transacción que la venta, está aislada por cajero y se rechaza si se recicla con un cobro distinto.
- **Fiscalidad al día** — el precio del catálogo es precio al público (impuestos incluidos) y cada venta guarda el desglose IVA 16%/0% e IEPS por partida, con la base sin impuestos. El descuento a nivel venta se prorratea antes de calcular impuestos y el desglose siempre suma el total cobrado al centavo (requisito para timbrar CFDI).
- **Devoluciones parciales** — devolución por partida contra una venta: reingresa al lote de origen (FEFO intacto), registra movimiento `return_in`, acumula `refundedTotal` en la venta y reembolsa la order de Mercado Pago Point cuando el pago fue con tarjeta. Reservada a los roles `admin`/`manager`; el efectivo devuelto sale del cajón en el corte.
- **Ticket imprimible** — comprobante de venta y de devolución como JSON estructurado + HTML para rollo térmico de 58/80mm, listo para `window.print()` o para el driver de la impresora.
- **Punto de venta** — ventas transaccionales que descuentan stock vía FEFO, registran método de pago (`cash`/`card`/`transfer`/`mixed`, con el reparto efectivo/tarjeta guardado en la venta), folio, cajero, cliente opcional y receta cuando el producto la exige. Cancelación de venta reservada al rol `admin`.
- **Caja / turnos** — apertura y cierre de `cashSessions` con monto inicial, conteo final, diferencia y resumen por método de pago; movimientos de caja (`deposit`, `withdrawal`, `expense`).
- **Cobro con terminal** — integración Mercado Pago Point (`/v1/payments/mercadopago`): sucursales, cajas, terminales, `orders`, consulta/cancelación/reembolso y webhook. Una venta `card`/`mixed` exige una order `processed` no reutilizada.
- **Clientes** — registro básico (nombre, RFC, contacto) asociable a la venta, más datos de facturación (`billing`: RFC, razón social, uso CFDI, correo) que quedan como snapshot en la venta.
- **Facturas de compra** — carga y almacenamiento de archivos de factura en Cloud Storage.
- **Reportes de ventas** — funciones programadas diaria y mensual que agregan ventas, renderizan PDF y lo envían por correo.
- **Usuarios y roles** — control de acceso por permisos `{ área, nivel }`, roles de sistema (admin, cajero, gerente, doctor) y roles personalizados, con permisos espejados en custom claims de Firebase Auth.
- **Módulo doctor** — área reservada/pendiente para funcionalidad médica.

## Objetivos no funcionales

- **Consistencia** — todos los cambios que tocan varias colecciones (ventas, entradas, salidas) se hacen dentro de transacciones de Firestore.
- **Seguridad** — toda ruta exige token de Firebase válido y verificación de permisos por área; los usuarios inactivos se rechazan.
- **Integridad de datos histórica** — migración transparente de roles legados (`role` string → `roleId`) sin romper sesiones existentes.
- **Localización** — mensajes y textos de cara al usuario en español.

## Estado / trabajo en curso

- Migración Express → NestJS **completa** (detalle abajo). Bootstrap Nest (`app.ts` + `app.module.ts`), módulos de dominio en `modules/`, guards/pipes/filtros globales, tests de caracterización para inventory y sales.
- Módulos posteriores a la migración ya en código: `cash-sessions`, `customers`, `payments` (Mercado Pago Point), reportes de ventas programados (Puppeteer + Resend).
- Deploy: función única `api` (`onRequest`, `us-central1`, 512MiB, 60s) + dos funciones `onSchedule` de reportes (1GiB).
- Pendiente de producto: módulo `doctor` (placeholder) y el roadmap de la siguiente sección.
- Deuda de datos: documentos históricos sin `totalStock` / `productIds` / `batches.supplierId`; el script de backfill existe pero falta correrlo en producción (ver P1.5).

## Roadmap: módulos faltantes vs POS de mercado

Brechas detectadas comparando contra Square, Odoo POS, Lightspeed Retail, Loyverse y POS de farmacia MX (Aspel-CAJA/SAE, MicroSIP, Farmatic). Orden = prioridad.

Los módulos ya implementados salieron de esta lista; lo entregado se describe en "Objetivos funcionales".

### P1 — obligatorio para farmacia formal en México

| Módulo | Qué falta hoy |
|---|---|
| **Facturación CFDI 4.0** | Hay snapshot `billing` + `invoiceStatus: 'pending'` y el desglose de impuestos por partida ya deja los datos listos, pero nada timbra. **Decisión 2026-08-04: no se construye todavía.** Al retomarlo: elegir PAC (Facturama es el camino más corto), factura global de público en general, cancelación con motivo, entrega de PDF+XML, y capturar los datos del emisor (RFC, régimen fiscal, CP de expedición, serie/folio) en `.env` con el patrón `RECEIPT_*`. |

### P1.5 — pendientes residuales de lo ya entregado

| Tema | Qué falta |
|---|---|
| **Correr el backfill en producción** | El script está listo (`npm run backfill:denormalized`, idempotente, `--dry-run` / `--force` / `--only=`) pero no se ha ejecutado contra producción; después hay que quitar los fallbacks de `totalStock`. Es prerequisito de "Devolución a proveedor / canje de caducados" (`batches.supplierId`). |
| **Volver obligatoria la llave de idempotencia** | `createSale` y `POST /v1/sale-returns` aceptan `idempotencyKey`, pero es opcional por compatibilidad: falta que el frontend la envíe siempre y luego exigirla en el schema. |
| **Habilitar el TTL de `saleIdempotencyKeys`** | `gcloud firestore fields ttls update expiresAt --collection-group=saleIdempotencyKeys --enable-ttl`. |

### Seguridad — hallazgos de la revisión del 2026-08-04

Ninguno alcanzó el umbral de reporte de la revisión (severidad alta con explotación confirmada), pero los tres se verificaron como reales y valen arreglo.

| Hallazgo | Qué pasa y cómo se arregla |
|---|---|
| ~~**La venta y la devolución no validan de quién es el turno de caja**~~ | **Corregido (2026-08-04).** `createSale` y `createSaleReturn` aplican `assertCanAccessSession` (ahora exportada desde `cash-sessions.service`): el turno es de quien lo abrió, y solo ese cajero o un admin puede cargarle ventas y devoluciones. En la venta la validación usa el documento ya leído dentro de la transacción, sin lectura extra. |
| **El webhook de Mercado Pago no valida firma si el secreto no está configurado** | `verifyWebhookSignature` hace `if (!secret) return;` y `MERCADOPAGO_WEBHOOK_SECRET` es opcional, así que por omisión la ruta `@Public()` acepta cualquier request sin firmar y queda como proxy de lectura sin autenticar contra la cuenta de MP (estado y existencia de una order). No escribe nada en Firestore. Arreglo: fallar cerrado —rechazar el webhook si el secreto no está configurado. Con el secreto puesto la verificación es correcta (`ts` + `v1` requeridos, `timingSafeEqual`). |
| **Validar el formato del id de order de Mercado Pago** | El id llega como `z.string().min(1)` y se interpola sin codificar en la ruta de la API de MP, que resuelve segmentos `..`. No es explotable como fuga (todo pasa por `mapOrder`, que proyecta siete escalares, y el host no es controlable), pero es endurecimiento barato: `encodeURIComponent` en `mpRequest` y/o un regex `^[A-Za-z0-9_-]{1,64}$` en el schema. |

### P2 — crecimiento y control comercial

| Módulo | Qué falta hoy |
|---|---|
| **Promociones y control de descuento** | `discountAmount` por partida sin reglas: sin 2x1/mix&match, sin % por categoría, sin cupón, sin techo de descuento por rol ni motivo capturado. |
| **Órdenes de compra y cuentas por pagar** | Solo hay entrada ligada a factura; falta PO, recepción parcial contra PO y saldo a proveedor. |
| **Devolución a proveedor / canje de caducados** | No existe; la farmacia devuelve caducado con nota de crédito. |
| **Venta fraccionada** | `Product.unit` es un solo campo; falta unidad de compra vs venta y factor de conversión (caja ↔ blíster ↔ tableta). |
| **Multi-sucursal y traspasos** | `batches` no tiene `locationId`; abrir una segunda sucursal implica remodelar el inventario. |
| **Crédito a cliente y lealtad** | `Customer` es nombre + RFC + contacto: sin límite de crédito, saldo, historial ni puntos. |

## No-objetivos (por ahora)

- El backend no renderiza UI ni sirve el frontend (solo API bajo `/v1`).
- La búsqueda es en memoria dentro de la capa de servicio; no hay motor de búsqueda externo.
- No hay suite unitaria exhaustiva de CRUD trivial; solo tests acotados a las transacciones de mayor riesgo.
- **No hay modo offline.** Todo cobro requiere red (Cloud Function + Firestore); no se contempla cola local ni sincronización posterior en el POS.
- **No se usa DI de Nest en la capa de dominio.** `services/` y `repositories/` son funciones exportadas planas, no `@Injectable`. Medido el 2026-08-03: cero ciclos de imports entre services, 5 aristas cross-service todas unidireccionales y de una capa, cada controller importa un solo service (dos en `users` e `internal`). Convertir a providers tocaría 17 services + todos los controllers + los tests sin beneficio medible. Reabrir solo si aparece un ciclo de imports o si hace falta sustituir/mockear un service en tests.
- No hay integración directa con hardware (cajón de dinero, impresora de etiquetas, báscula); el cliente resuelve la impresión.

## Migración a NestJS (completada)

### Resultado

Backend: **NestJS 11** + Express 5 + Firebase Cloud Functions v2 (función única `api`) + Firestore + Zod + Busboy para multipart. Capas: `modules/*.controller.ts → Guards/ZodValidationPipe → services → repositories`. La lógica de dominio en `services/` y `repositories/` se mantuvo como funciones exportadas planas (no `@Injectable`) a propósito: menos riesgo/ceremonia DI sin beneficio real cross-módulo.

### Módulos Nest

| Módulo | Dominios |
|---|---|
| **IdentityModule** | auth, roles, users + `AuthGuard` / `PermissionsGuard` / decorators |
| **CatalogModule** | categories, products, suppliers |
| **InventoryModule** | inventory (batches/entries/exits/movements), invoices |
| **SalesModule** | sales |
| **CashSessionsModule** | turnos de caja + movimientos de caja (post-migración) |
| **CustomersModule** | clientes (post-migración) |
| **PaymentsModule** | Mercado Pago Point: stores, pos, devices, orders, webhook (post-migración) |
| **UploadsModule** | uploads + `FileUploadInterceptor` (Busboy) |
| **DoctorModule / InternalModule** | doctor (placeholder), internal (migrate-roles) |
| **CommonModule (@Global)** | `FirestoreService`, `ZodValidationPipe`, `AppExceptionFilter` |
| **Health** | `GET /v1/health` (`@Public()`), registrado en `AppModule` |

### Decisiones vs plan original

| Plan original | Qué quedó |
|---|---|
| `SharedModule` + response interceptor global | `CommonModule`; el envoltorio `{ data, meta? }` lo arman los controllers (sin interceptor) para preservar la forma exacta de cada endpoint |
| Services/repos como `@Injectable` + DI cross-módulo | Functions planas importadas por controllers; `FirestoreService` existe pero la capa de dominio sigue usando `db()`/`now()` |
| `nestjs-zod` opcional | Pipe custom `ZodValidationPipe` (~espejo del middleware Express) |
| Multer / `FileInterceptor` de Nest | Busboy custom (soporta `req.rawBody` de Cloud Functions v2) |
| Tests de auth + historial de products antes de migrar | Prioridad a tests dorados de `inventory` y `sales` (`functions/test/`); auth/CRUD trivial sin cobertura dedicada |

### Bootstrap / despliegue

```
// index.ts
if (!admin.apps.length) admin.initializeApp();
export const api = onRequest({ region:'us-central1', memory:'256MiB', timeoutSeconds:60 },
  async (req,res) => { const app = await createApp(); app(req,res); });
```

- `admin.initializeApp()` corre **antes** de `NestFactory.create`.
- `createApp()` cachea la instancia Express+Nest (`cachedApp`) para cold-start en invocaciones cálidas.
- Body-parser JSON se omite para `multipart/form-data`.
- `dev-server.ts` reutiliza el mismo bootstrap.

### Bugs corregidos durante la migración

| | Fix |
|---|---|
| **(a)** | `POST /inventory/direct-entries`: exige `products:write` si hay producto inline; validar ítems antes de crear producto; creación dentro del flujo transaccional correcto |
| **(b)** | GETs de inventory entries/movements, invoices y sales con nivel `'read'` explícito |
| **(c)** | Unicidad SKU/nombre/barcode de productos dentro de `runTransaction` en el repository |
| **(d)** | Comparación constant-time del secreto en `internal` (`crypto.timingSafeEqual`) |

### Testing

Jest + emulador Firestore (`npm test` = `firebase emulators:exec --only firestore "jest"`):

- `functions/test/inventory.spec.ts` — transacciones de entrada/salida.
- `functions/test/sales.spec.ts` — asignación FEFO / `createSale`.
- Sin cobertura unitaria exhaustiva de CRUD trivial (categories, suppliers, doctor, uploads).

### Deuda / limpieza residual

- Middleware Express legacy reducido a `middleware/cors.ts` (aún usado en bootstrap).
- Routes Express eliminadas; no reintroducir capa `routes/`.
- Fachadas de servicio `@Injectable`: **descartado** (medido 2026-08-03, ver No-objetivos). El acoplamiento cross-módulo no duele; la capa de dominio se queda en funciones planas.

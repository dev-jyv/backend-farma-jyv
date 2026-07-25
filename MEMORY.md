# MEMORY.md

Contexto persistente del proyecto **FarmaJyV Backend** para retomar trabajo rápidamente. Hechos derivados del código; actualízalo cuando cambien. Detalle de arquitectura en [CLAUDE.md](CLAUDE.md), objetivos en [GOALS.md](GOALS.md).

## Datos clave

- **Proyecto Firebase:** `farma-jyv` (ver [.firebaserc](.firebaserc)).
- **Runtime:** Node 22, TypeScript, Express 5, Firebase Functions v2 (`onRequest`, región `us-central1`).
- **Entry point:** todo el código en [functions/](functions/); la función exportada es `api` en [functions/src/index.ts](functions/src/index.ts).
- **Base de datos:** Firestore. **Auth:** Firebase Auth (ID tokens + custom claims). **Archivos:** Cloud Storage.
- **Rama actual:** `feature/prducts`.

## Colecciones de Firestore

| Colección | Contenido |
|---|---|
| `products` | Catálogo (SKU, barcode, precios, impuestos, `suppliers`, `lastCostPriceBySupplier`) |
| `categories` | Categorías de productos |
| `batches` | Lotes: producto + lote + caducidad + cantidad (stock real) |
| `stockMovements` | Auditoría de movimientos de stock |
| `inventoryEntries` | Entradas de inventario ligadas a factura/proveedor |
| `invoices` | Facturas de compra (archivo en Storage) |
| `suppliers` | Proveedores |
| `sales` | Ventas del punto de venta |
| `users` | Perfiles de usuario (`roleId`, `isActive`) |
| `roles` | Roles con permisos `{ área, nivel }` |

## Endpoints (montados bajo `/v1`)

`auth`, `categories`, `products`, `inventory`, `invoices`, `uploads`, `sales`, `suppliers`, `users`, `roles`, `doctor`, `internal`, más `GET /v1/health`.

## Convenciones que hay que recordar

- Capas estrictas: `routes → middleware → services → repositories`. Los repos son el único lugar que toca Firestore directamente.
- Escrituras multi-colección **siempre** en `firestore.runTransaction`.
- Errores esperados vía `AppError` de [utils/errors.ts](functions/src/utils/errors.ts); nunca `throw` crudo.
- Firestore vía `db()` / timestamps vía `now()`, `toTimestamp()` de [utils/firestore.ts](functions/src/utils/firestore.ts).
- Validación con Zod centralizada en [schemas/index.ts](functions/src/schemas/index.ts).
- Respuestas con envoltorio `{ data, meta? }`; errores como `{ error: { code, message } }`.
- Rol `admin` (slug) omite toda verificación de permisos.
- Textos de cara al usuario en **español**.
- Estilo ESLint: comillas simples, indentación de **4 espacios**, máx. 100 columnas.

## Variables de entorno ([functions/.env](functions/.env), no versionado)

- `CORS_ORIGINS` — allowlist separado por comas.
- `MIGRATE_SECRET` — protege `POST /v1/internal/migrate-roles` (header `x-migrate-secret`).

## Pendientes conocidos

- Sin suite de pruebas (no hay script `test` ni archivos de test).
- Módulo `doctor` reservado/pendiente de funcionalidad.

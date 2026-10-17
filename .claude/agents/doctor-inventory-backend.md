---
name: doctor-inventory-backend
description: >
  Desarrolla y mantiene el endpoint de consulta de inventario para el médico de FarmaJyV
  (`GET /v1/doctor/inventory`): snapshot compacto + delta por `updatedSince`, caché en memoria,
  acceso solo admin/doctor. Úsalo al cambiar ese endpoint, su caché o su contrato.
tools: Read, Grep, Glob, Bash, Edit, Write
---

Eres un ingeniero backend NestJS/Firestore. Lee `CLAUDE.md` del repo antes de escribir código.

## Contrato (el front del admin depende de él; no lo cambies sin avisar)

`GET /v1/doctor/inventory?updatedSince=<ISO opcional>` → `{ data: Item[], meta: { serverTime, full, total } }`

- `Item`: `{ id, name, activeIngredient|null, concentration|null, unit, categoryId, totalStock, minStock,
  controlledGroup|null, isActive, updatedAt(ISO) }`. Sin precios, costos, proveedores ni lotes.
- Sin `updatedSince` (carga completa): solo activos, orden por nombre, `full: true`.
- Con `updatedSince` (delta): `activeOnly: false` para que el cliente pueda retirar inactivos, `full: false`.
  `meta.serverTime` es el cursor que el cliente reenvía.

## Reglas

- Acceso: `@RequirePermission('medicalRecords', 'read')`. Esa área solo la tienen admin y doctor
  (manager excluido a propósito, cashier no la tiene): evita migración de roles. No uses `products:read`.
- Lecturas baratas: la carga completa se cachea en proceso con `MemoryCache` (60 s, una sola clave);
  el delta lee solo lo cambiado. `updatedAt` ya sube con cada cambio de stock. Nada de leer lotes.
- Capas: controller delgado -> service (función exportada, no @Injectable) -> repository. Zod en
  `schemas/`, errores con `AppError`, mensajes en español, estilo ESLint (4 espacios, 100 col).
- Actualiza `CLAUDE.md` y `MEMORY.md` con el endpoint. Corre `npm run lint` y `npm run build`.

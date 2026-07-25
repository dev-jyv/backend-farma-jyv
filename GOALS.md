# GOALS.md

Objetivos del proyecto **FarmaJyV Backend**, inferidos del código actual. Este archivo describe el "para qué" del sistema; la arquitectura del "cómo" vive en [CLAUDE.md](CLAUDE.md).

## Objetivo principal

Proveer la API REST que da soporte a la gestión de una farmacia: catálogo de productos, control de inventario por lotes, punto de venta, compras a proveedores y administración de usuarios/roles. Todo corre como una sola Cloud Function de Firebase (`api`) sobre Firestore.

## Objetivos funcionales

- **Catálogo de productos** — alta/edición/baja lógica de productos con SKU, código de barras, ingrediente activo, concentración, precios e impuestos (IVA / IVA cero / IEPS). Búsqueda por múltiples campos.
- **Inventario por lotes (FEFO)** — el stock se controla por lote (`batches`: producto + lote + caducidad + cantidad), no en el producto. Las salidas priorizan el lote que caduca primero (First-Expired-First-Out).
- **Trazabilidad total** — cada movimiento de stock (`entry`, `exit_waste`, `exit_expiry`, `sale_adjustment`) queda registrado en `stockMovements` para auditoría.
- **Compras y proveedores** — entradas de inventario ligadas a una factura y proveedor; se registra el último precio de costo por proveedor.
- **Punto de venta** — ventas transaccionales que descuentan stock vía FEFO y registran método de pago.
- **Facturas** — carga y almacenamiento de archivos de factura en Cloud Storage.
- **Usuarios y roles** — control de acceso por permisos `{ área, nivel }`, roles de sistema (admin, cajero, gerente, doctor) y roles personalizados, con permisos espejados en custom claims de Firebase Auth.
- **Módulo doctor** — área reservada/pendiente para funcionalidad médica.

## Objetivos no funcionales

- **Consistencia** — todos los cambios que tocan varias colecciones (ventas, entradas, salidas) se hacen dentro de transacciones de Firestore.
- **Seguridad** — toda ruta exige token de Firebase válido y verificación de permisos por área; los usuarios inactivos se rechazan.
- **Integridad de datos histórica** — migración transparente de roles legados (`role` string → `roleId`) sin romper sesiones existentes.
- **Localización** — mensajes y textos de cara al usuario en español.

## Estado / trabajo en curso

- Rama activa: `feature/prducts` — cambios en curso sobre productos (repositorio, rutas, servicio, esquemas, búsqueda) e índices/reglas de Firestore y Storage.
- No hay suite de pruebas configurada todavía (`firebase-functions-test` está instalado pero sin tests ni script `test`).

## No-objetivos (por ahora)

- El backend no renderiza UI ni sirve el frontend (solo API bajo `/v1`).
- La búsqueda es en memoria dentro de la capa de servicio; no hay motor de búsqueda externo.

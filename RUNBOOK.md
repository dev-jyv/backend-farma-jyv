# RUNBOOK — operación en producción

Procedimientos que tocan el proyecto desplegado. Todo lo de aquí se ejecuta a
mano y con la farmacia avisada; nada corre solo.

Requisitos: `firebase login` y `gcloud auth login` con una cuenta que tenga
acceso al proyecto, y `firebase use <proyecto>` apuntando al correcto. Antes de
cualquier comando, confirma contra cuál estás parado:

```bash
firebase use          # muestra el proyecto activo
gcloud config get-value project
```

---

## Estado al 2026-09-17

| Paso | Estado |
|---|---|
| Respaldo manual de verificación | ✅ `gs://farma-jyv-respaldos-firestore/manual/20260916T181101` |
| Bucket, retención y permisos | ✅ retención de 30 días solo sobre `firestore-backups/` |
| Índice `bankMovements` | ✅ desplegado y `READY` |
| TTL de `saleIdempotencyKeys` | ✅ `ACTIVE` |
| Función `dailyFirestoreBackup` | ✅ desplegada, programada 02:00 CDMX y **probada**: `firestore-backups/2026-09-17T01-25-21` |
| Canal de alertas | ✅ correo a `vitor5608@gmail.com` (`notificationChannels/11603164733489849183`) |
| Política de alerta | ✅ `alertPolicies/15126880163367668267` — más de 5 respuestas 5xx de `api` en 5 min |
| Backfill denormalizado | ✅ corrido (`products`: 192, `entries`: 2); respaldo previo en `manual/pre-backfill-20260916T193414` |
| Integración continua | ✅ `.github/workflows/ci.yml` en ambos repos (§6) |
| Notificaciones de Error Reporting | ⏳ se activan desde la consola (§7) |

### Limpieza de datos de prueba — 2026-09-17

Se vació todo lo transaccional para arrancar la operación real. **Respaldos
previos** (no caducan: la retención de 30 días solo aplica a `firestore-backups/`):

- `manual/pre-borrado-20260916T194704` — Firestore completo antes del borrado.
- `manual/uploads-pre-borrado-20260916T195619` — los 14 archivos de Storage.

Borrado: `sales` (10), `cashMovements` (15), `cashSessions` (14), `invoices`
(11), `inventoryEntries` (22), `batches` (23), `stockMovements` (12),
`controlledSalesLedger` (7), `auditLogs` (62), `unreconciledSales` (1),
`stockEntryIdempotencyKeys` (2). Más los 226 productos con `totalStock: 0`, los
contadores de folio en 0, y los archivos de Storage y R2.

Se conservaron: `products`, `categories`, `suppliers`, `users`, `roles`,
`pharmacyServices`, `serviceProviders`.

Para restaurar algo puntual, importar el volcado a un proyecto aparte y copiar
solo lo que haga falta: `gcloud firestore import` sobre producción sobrescribe.

---

## 1. Desplegar índices de Firestore — **antes que el código**

Un índice compuesto tarda minutos en construirse. Si el código sale primero, la
consulta que lo necesita falla con `FAILED_PRECONDITION` hasta que el índice
termina, y el emulador **no** valida índices, así que las pruebas no lo avisan.

```bash
firebase deploy --only firestore:indexes
# esperar a que todos digan "Enabled" antes de desplegar funciones
firebase firestore:indexes
```

Índice pendiente al 2026-09-17: `bankMovements (accountId ASC, occurredAt DESC)`,
que usa la pantalla de Bancos para el saldo de cada cuenta.

---

## 2. Backfill de campos denormalizados

Rellena `totalStock`, `productIds` y `batches.supplierId` en documentos
históricos. Es idempotente, pero **escribe en producción**: primero en seco.

El script toma las credenciales de `gcloud` si no hay llave de servicio en
disco, que es lo preferible: una llave descargada es un secreto de vida larga
que se queda en el equipo de quien la bajó y nadie rota después.

```bash
gcloud auth application-default login   # una sola vez por equipo

cd functions
npm run backfill:denormalized -- --dry-run          # no escribe; imprime el plan
npm run backfill:denormalized -- --only=totalStock  # por partes, verificando
npm run backfill:denormalized                       # completo
```

Orden sugerido: respaldo (§4) → `--dry-run` → una colección → verificar en la
app → el resto.

Corrido el 2026-09-17. Un segundo simulacro cierra en 0 actualizados en las
cuatro colecciones, así que ya se pueden quitar los *fallbacks* de `totalStock`
del código.

**Lo que el backfill no alcanza** y necesita mano humana:

- **3 lotes sin `supplierId`** y sin entrada rastreable (carga manual o dato
  anterior al campo). Son el prerrequisito de "devolución a proveedor / canje de
  caducados": o se les asigna proveedor a mano, o ese módulo tiene que tolerar
  lotes huérfanos.
- **3 ventas sin `productIds`** cuyas partidas tampoco traen `productId`: no hay
  de dónde reconstruirlas. Quedan fuera de cualquier reporte que filtre por
  producto. Son ventas anteriores al campo.

---

## 3. Llave de idempotencia obligatoria en ventas

Sin llave, un reintento por corte de red vuelve a cobrar y a descontar stock. El
cierre va en dos tiempos porque el POS de escritorio es **otro despliegue**:
exigirla de golpe dejaría a la farmacia sin poder cobrar.

1. Ya desplegado: el admin la manda siempre, y una venta sin llave deja un
   `warn` en los logs con el uid del cajero.
2. Vigilar unos días qué clientes siguen sin mandarla:

```bash
firebase functions:log --only api | grep "sin llave de idempotencia"
```

3. Cuando no aparezcan avisos, encender la exigencia:

```bash
firebase functions:config:unset   # (no aplica: la config va por variable de entorno)
# en .env de despliegue / secret manager:
SALES_REQUIRE_IDEMPOTENCY_KEY=true
firebase deploy --only functions:api
```

Con la bandera encendida, una venta sin llave responde 400 con mensaje explícito.

---

## 4. Respaldo de Firestore

### Automático

`dailyFirestoreBackup` (en `functions/src/schedules/backup.schedule.ts`) exporta
la base completa a Cloud Storage todos los días a las 02:00 (hora de CDMX).

Hecho el 2026-09-17: bucket `farma-jyv-respaldos-firestore` (ya existía, con el
respaldo `pre-borrado-20260905`), retención de 30 días sobre `firestore-backups/`
y permisos a la cuenta de servicio de las funciones. Para reconstruirlo en otro
proyecto:

```bash
PROJECT=$(gcloud config get-value project)
BUCKET="farma-jyv-respaldos-firestore"   # ya existe; no crear otro

# La function exporta con la cuenta de servicio por defecto de App Engine.
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:1066277823355-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.importExportAdmin"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:1066277823355-compute@developer.gserviceaccount.com" \
  --role="roles/storage.admin"

# Retención: 30 días **solo** para los automáticos. Los manuales (`manual/`,
# `pre-borrado-*`) se tomaron a propósito antes de una operación de riesgo:
# borrarlos a los 30 días sería tirar justo la copia que alguien quiso guardar.
cat > /tmp/lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},
          "condition":{"age":30,"matchesPrefix":["firestore-backups/"]}}]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file=/tmp/lifecycle.json
```

Después, declarar `FIRESTORE_BACKUP_BUCKET=<bucket>` en el entorno de las
funciones y desplegar:

```bash
firebase deploy --only functions:dailyFirestoreBackup
```

### Manual, antes de una operación de riesgo

```bash
gcloud firestore export "gs://${BUCKET}/manual/$(date +%Y%m%dT%H%M%S)"
```

### Restaurar

```bash
# ⚠️ Sobrescribe los documentos del volcado. Hacerlo con la app en mantenimiento.
gcloud firestore import "gs://${BUCKET}/firestore-backups/<carpeta>"
```

---

## 5. TTL de `saleIdempotencyKeys`

Las llaves guardan `expiresAt`; sin TTL la colección crece para siempre.

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=saleIdempotencyKeys --enable-ttl
gcloud firestore fields ttls list     # verificar que quedó ACTIVE
```

Firestore borra los documentos vencidos por su cuenta, con hasta 24 h de retraso.
No afecta a las ventas: la llave solo protege el reintento de un cobro reciente.

---

## 6. Integración continua

`.github/workflows/ci.yml` corre en cada push a `main` y en cada pull request:
`npm ci` → `npm run lint` → `npm run build` → `npm run test:coverage`. Instala
Temurin JDK 21 porque las pruebas arrancan el emulador de Firestore, que
necesita JVM, y publica el reporte de cobertura como artefacto durante 14 días
aunque las pruebas fallen.

**No despliega nada.** El despliegue sigue siendo manual (`npm run deploy`, y los
índices *antes* que el código — §1).

El CI corre contra el emulador con el proyecto `farma-jyv-test`: no toca datos
reales ni necesita credenciales.

Dos cosas que conviene saber antes de que alguien lo declare roto:

- La cobertura del backend **oscila alrededor de un punto entre corridas**
  porque las suites comparten un emulador y reutilizan lo que dejaron las
  anteriores. Por eso el piso de `coverageThreshold` va ~2 puntos por debajo de
  lo medido. Si hay que bajarlo, que sea una decisión explícita en el commit.
- `sales.spec.ts › dos requests concurrentes con la misma llave produce una sola
  venta` falla aproximadamente **1 de cada 4 corridas** y pasa en aislamiento.
  Es contención del emulador, no la lógica de idempotencia. Antes de investigar
  un fallo de CI, comprueba si es ese.

En el panel (`farma-jyv-admin`) el flujo es el mismo sin JDK: `npm ci` →
`npm run test:coverage` → `npm run build`. El umbral lo aplica
`scripts/check-coverage.mjs`, porque el builder de Angular genera el reporte pero
no sabe fallar por porcentaje.

---

## 7. Monitoreo de errores

Los 500 se registran con stack completo y contexto (ruta, método, uid) desde
`AppExceptionFilter`, así que **Cloud Error Reporting los agrupa sin instalar
ningún SDK**. Lo que falta es que alguien se entere:

Ya creados el 2026-09-17:

- Canal de correo `Alertas FarmaJyV` → `vitor5608@gmail.com`
  (`projects/farma-jyv/notificationChannels/11603164733489849183`).
- Política `FarmaJyV · errores en la API`
  (`projects/farma-jyv/alertPolicies/15126880163367668267`): avisa cuando `api`
  devuelve más de 5 respuestas `5xx` en 5 minutos, y se cierra sola a las 24 h.

`gcloud beta monitoring …` pide instalar el componente beta y no corre sin
terminal interactiva; los dos se crearon con la API REST:

```bash
TOKEN=$(gcloud auth print-access-token)
curl -s -X POST "https://monitoring.googleapis.com/v3/projects/farma-jyv/notificationChannels" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"type":"email","displayName":"Alertas FarmaJyV",
       "labels":{"email_address":"<correo>"},"enabled":true}'
```

**Falta un paso manual**: en la consola, **Error Reporting → Configure
notifications**, elegir ese canal. Es lo que avisa de un error *nuevo* aunque
ocurra una sola vez; la política de arriba solo se dispara cuando hay volumen.

Revisión rápida desde la terminal:

```bash
firebase functions:log --only api | grep -i "ERROR"
```

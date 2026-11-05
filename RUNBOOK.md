# RUNBOOK — operación en producción

Procedimientos que tocan el proyecto desplegado. Todo lo de aquí se ejecuta a
mano y con la farmacia avisada; nada corre solo.

Para **cómo está construida** la API —módulos, permisos, reglas de dinero,
idempotencia, integraciones y el diagrama del sistema— ver
[`docs/DOSSIER_TECNICO.md`](docs/DOSSIER_TECNICO.md).

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
| Aviso de error nuevo | ✅ `alertPolicies/206274569130471057` — alerta por log; ya no hace falta el paso de consola (§7) |
| Código de contabilidad | ✅ `api` y hosting desplegados el 2026-09-17 |
| PITR en `farma-jyv` (SPEC 31) | ⏳ script listo (`scripts/ops/31-pitr.sh`), sin aplicar — §4 |
| Proyecto de respaldos + copia externa (SPEC 31) | ⏳ scripts listos, sin aplicar — §4 |
| Alertas de operación y presupuesto (SPEC 32) | ⏳ definiciones listas, sin aplicar — §7 |
| Medición de arranque en frío (SPEC 34) | ⏳ consulta y reporte listos; faltan los 14 días — §8 |
| Disparador de límites compartidos (SPEC 42) | ⏳ dashboard y reporte listos, sin aplicar — §9 |
| Simulacro de restauración (SPEC 43) | ⏳ procedimiento listo; falta el primero — §4 |
| Despliegue desde GitHub Actions (SPEC 39) | ⏳ workflows listos; faltan WIF, environments y variables — §10 |
| Secretos en Secret Manager (SPEC 35) | ⏳ código listo; faltan los siete secretos en cada proyecto — §11 |
| Función `reportsPdf` (SPEC 38) | ⏳ código listo, sin desplegar — §12 |
| App Check en modo registro (SPEC 41) | ⏳ guard listo; falta registrar el panel en App Check — §13 |
| Salud de cajas, copia local y alertas (SPEC 36/37/44) | ⏳ código listo; faltan índices, `migrate:roles` y despliegue — §14–§15 |

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

### Cortes de prueba del POS dev — 2026-09-26

El modo dev del POS apuntaba a producción hasta que se separaron los ambientes
([docs/AMBIENTES.md](docs/AMBIENTES.md)). Tras la limpieza anterior quedaron dos
cortes de prueba del 24 de septiembre, sin ventas ni movimientos:
`jSUP8JbooILlK7T3Gqls` y `UWFXYYe2K1080Wl3GnkJ`. Se borraron con
`functions/src/scripts/purge-test-data.ts` (dry-run por defecto; `--execute`
aplica, anulando antes cualquier venta viva para restaurar stock y libro).

- Respaldo previo: `manual/pre-borrado-pruebas-20260926T221807`.
- Rastro: una entrada `maintenance.test_data_purged` en `auditLogs`.
- También se borró el SQLite viejo del POS en la máquina de desarrollo
  (`~/Library/Application Support/Electron/farmajyv-pos.sqlite` y respaldos).

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

## 2b. Backfill de `searchName` (SPEC 10) — **antes de desplegar la lectura**

Clientes, pacientes, usuarios y roles buscan por prefijo sobre `searchName`
(nombre en minúsculas sin acentos). Un documento sin ese campo **no aparece** en
las búsquedas, así que el orden es obligatorio:

1. Desplegar índices (`firestore:indexes`): `users`, `roles` y `patients` ganan
   compuestos con `searchName`. Esperar a que estén `READY`.
2. Lectura y escritura van en el mismo deploy, así que el backfill se corre justo
   antes del deploy y se repite (idempotente) justo después para cubrir las altas
   hechas en la ventana.
3. Respaldo de pacientes (antes del backfill): `gcloud firestore export gs://<bucket>/pre-search-name --collection-ids=patients`.
4. `npm run backfill:search-name -- --dry-run` (reporta cuántos faltan por colección).
5. `npm run backfill:search-name -- --confirm-backup` (o `--collection=customers`
   etc. para ir por partes; `patients` exige `--confirm-backup`).
6. Desplegar funciones. Repetir el paso 5 y verificar con `--dry-run` que reporta 0.

La búsqueda ya no cubre RFC, teléfono, correo, folio ni CURP: solo prefijo del nombre.


## 2c. Backfill de `outstanding` (SPEC 13) — **antes de desplegar la lectura**

Cuentas por pagar y el pasivo del balance leen ahora `where('outstanding','==',true)`
en `invoices` y `accruedExpenses`. Un documento con saldo pero sin el marcador **no
aparece** hasta rellenarlo.

1. `cd functions && npm run backfill:outstanding -- --dry-run` — reporta cuántos faltan.
2. `npm run backfill:outstanding` — escribe solo lo que falta o difiere (idempotente).
   Las facturas `legacy` (sin `paidTotal`) quedan sin marcador, como se espera.
3. Desplegar las funciones.
4. Repetir el dry-run: debe reportar 0.

Altas, abonos y anulaciones nuevos mantienen el marcador en su misma transacción;
los abonos y altas hechos entre el backfill y el deploy los cubre el paso 4.


## 2d. Fechas de calendario a mediodía UTC (SPEC 18) — **código primero, backfill después**

`invoiceDate`, `dueDate`, `batches.expiryDate` e `inventoryEntries.items[].expiryDate`
se guardaban a medianoche UTC y en México se leían un día antes. Ahora se guardan a
mediodía UTC; los documentos anteriores siguen a medianoche hasta correr el backfill.

Orden (ningún paso intermedio duplica lotes, porque la búsqueda de lotes ya acepta
ambas representaciones):

1. Desplegar el código (escritura a mediodía, búsqueda de lotes y filtros de rango
   que entienden las dos formas).
2. Respaldo previo:
   `gcloud firestore export gs://farma-jyv-respaldos-firestore/pre-calendar-dates --collection-ids=invoices,batches,inventoryEntries`
3. `cd functions && npm run backfill:calendar-dates -- --dry-run`, luego sin `--dry-run`
   (idempotente: solo toca valores a las 00:00:00.000Z exactas).
4. Repetir el dry-run: debe reportar 0 documentos a corregir.


## 2e. Regla general: índices primero, funciones después

Un índice compuesto nuevo tarda en construirse y `firebase deploy` no lo espera. Una
función que ya consulta con ese índice, desplegada antes de que esté `READY`, responde
**500** (`FAILED_PRECONDITION`). Pasó el 2026-10-20: el historial de ventas de un
producto falló entre las 15:21 y las 17:09 (hora de México) porque el código salió
sin su índice `sales [productIds, createdAt DESC]`.

Cada vez que un cambio toque `firestore.indexes.json`:

1. Desplegar solo los índices: `firebase deploy --project prod --only firestore:indexes`.
2. Esperar a que estén listos:
   `gcloud firestore indexes composite list --project=farma-jyv --format="value(state)" | sort | uniq -c`
   — no debe quedar ninguno en `CREATING`.
3. Recién entonces desplegar las funciones (`npm run deploy:prod`).

El job de producción de `deploy.yml` hace estos tres pasos solo (§8.3); a mano,
`scripts/ci/wait-firestore-indexes.sh farma-jyv` reemplaza al paso 2.

Con el logger de Nest activo (`error` y `warn`) el stack de cualquier 500 queda en los
logs del servicio, con ruta, método y usuario: `gcloud logging read
'resource.labels.service_name="api" AND severity>=ERROR' --freshness=1h`.

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

Esto es la última opción. Para un error puntual, primero PITR (abajo); para
pérdidas mayores, el bucket externo y nunca un import directo sobre producción.

### Log de ejecución y alertas

Cada función programada, incluida esta, deja al terminar **una** entrada
estructurada `scheduled_job.finished` con `job` (nombre exportado) y `outcome`
(`succeeded` | `failed`) — `functions/src/schedules/scheduled-job.ts`. De ahí salen
la alerta de fallo definitivo y la de ausencia de 26 h (§7). Un intento fallido se
registra como `warn`; el error se relanza para que Cloud Scheduler reintente.

### Scripts de operación (`scripts/ops/`)

Todo lo de esta sección y de §7–§9 está declarado en el repo y se aplica con
scripts **en seco por defecto**: sin `--apply` imprimen cada comando o recurso y
no tocan GCP; con `--apply` crean o actualizan por nombre, así que se pueden
repetir. `npm run test:ops` (raíz) valida las plantillas de `scripts/ops/defs/` y
que ningún script llame a `gcloud` sin `--apply`; corre en CI.

| Script | Spec | Qué hace |
|---|---|---|
| `scripts/ops/31-pitr.sh` | 31 | Activa PITR y muestra su estado |
| `scripts/ops/31-backup-project.sh` | 31, 43 | Proyecto aislado, bucket externo (versionado + 30 días), IAM y su auditoría |
| `node scripts/ops/gcp.mjs transfer` | 31 | Permisos mínimos, topic de fallos y job diario de Storage Transfer |
| `node scripts/ops/gcp.mjs transfer-alert` | 32 | Alerta del job de transferencia (en el proyecto de respaldos) |
| `node scripts/ops/gcp.mjs alerts` | 32 | Canales, métrica de log, uptime check y políticas de `farma-jyv` |
| `node scripts/ops/gcp.mjs budget` | 32 | Presupuesto mensual con umbrales 50/90/100 % |
| `node scripts/ops/gcp.mjs saved-query` | 34 | Consulta guardada de arranques en frío |
| `node scripts/ops/reports.mjs cold-start` | 34 | Tabla de 14 días (p50/p95/arranques) |
| `node scripts/ops/gcp.mjs dashboard` | 42 | Gráfico de instancias de `api` en horario de tienda |
| `node scripts/ops/reports.mjs instances` | 42 | Máximo diario y racha del disparador |
| `node scripts/ops/restore-drill.mjs` | 43 | Pasos del simulacro con el proyecto de respaldos como único destino |
| `npm --prefix functions run pitr:restore` | 31 | Reescribe documentos puntuales a su versión PITR |

### PITR — recuperación a un punto en el tiempo (SPEC 31)

PITR guarda versiones de cada documento durante **7 días**: en la última hora a
cualquier instante, antes de eso a minutos enteros. RPO: 1 minuto dentro de la
ventana. Se cobra aparte (almacenamiento de versiones).

Activar (una vez; idempotente):

```bash
PROJECT=farma-jyv scripts/ops/31-pitr.sh            # en seco
PROJECT=farma-jyv scripts/ops/31-pitr.sh --apply
gcloud firestore databases describe --project farma-jyv \
  --format='value(pointInTimeRecoveryEnablement)'   # POINT_IN_TIME_RECOVERY_ENABLED
```

Costo del primer mes: _pendiente — anotarlo al cerrar el primer mes con PITR._

### Copia externa de los respaldos (SPEC 31)

El bucket `farma-jyv-respaldos-firestore` vive en el mismo proyecto que la base:
un error de IAM, un borrado del proyecto o una cuenta comprometida se llevarían
los dos. Por eso cada día se copia `firestore-backups/` a un bucket de **otro
proyecto** (`farma-jyv-respaldos`, nombre a confirmar al crearlo), que también
es el único destino del simulacro (abajo).

- **Proyecto aislado**: IAM solo para el dueño de la cuenta y quien ejecuta el
  simulacro (más los agentes de servicio que Google crea solos). Sin Firebase,
  Hosting ni funciones.
- **Bucket externo**: versionado de objetos, acceso uniforme, sin acceso público;
  borra a los 30 días lo que está bajo `firestore-backups/` y las versiones
  anteriores 30 días después de dejar de ser actuales
  (`scripts/ops/defs/storage/lifecycle-external.json`). Tiene su propio reloj: lo
  que la regla de 30 días borra en el origen sigue en el destino.
- **Transferencia**: job de Storage Transfer **en el proyecto de respaldos**, diario
  a las 05:00 CDMX (11:00 UTC; el export de las 02:00 tarda minutos). Copia lo
  modificado en los últimos 7 días con `overwriteWhen: NEVER`: si un export no
  terminó a tiempo, lo que falte se copia al día siguiente; si el export falló, no
  copia nada nuevo (y alerta `dailyFirestoreBackup`, §7).
- **Permisos**: el agente de Storage Transfer del proyecto de respaldos tiene solo
  lectura en el origen (`legacyBucketReader` + `objectViewer`) y en el destino un
  rol propio `farmajyvBackupWriter` **sin `storage.objects.delete`**. Ninguna
  cuenta de `farma-jyv` tiene permisos en el destino. Si Storage Transfer
  rechazara el job por pedir `delete`, la alerta de §7 lo avisa en la primera
  corrida; no "arreglarlo" dándole `objectAdmin`.
- **Fallo del job**: notifica a un topic de Pub/Sub que solo recibe
  `TRANSFER_OPERATION_FAILED`/`ABORTED`; cualquier mensaje dispara la alerta.

Aplicar (en este orden; todo en seco primero):

```bash
export BACKUP_PROJECT=farma-jyv-respaldos EXTERNAL_BUCKET=farma-jyv-respaldos-externo
export BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX OWNER_ACCOUNT=<correo del dueño de la cuenta>
export DRILL_ACCOUNT=<correo de quien hace el simulacro>   # omitir si es el dueño
export OPS_EMAIL=vitor5608@gmail.com OWNER_EMAIL=<correo del dueño de la farmacia>

scripts/ops/31-backup-project.sh --apply
node scripts/ops/gcp.mjs transfer --project "$BACKUP_PROJECT" --dest-bucket "$EXTERNAL_BUCKET" --apply
node scripts/ops/gcp.mjs transfer-alert --project "$BACKUP_PROJECT" --apply
gcloud transfer jobs run farmajyv-firestore-backups-externo --project "$BACKUP_PROJECT"   # primera copia
```

Verificar:

```bash
# Un export de las últimas 24 h, copiado por el job:
gcloud storage ls "gs://${EXTERNAL_BUCKET}/firestore-backups/" | tail -2
# La cuenta de servicio de farma-jyv NO puede borrar en el destino (debe dar 403):
gcloud storage rm "gs://${EXTERNAL_BUCKET}/firestore-backups/<carpeta>/<objeto>" \
  --impersonate-service-account=1066277823355-compute@developer.gserviceaccount.com
```

(La suplantación necesita `roles/iam.serviceAccountTokenCreator` temporal sobre
esa cuenta; quitarlo al terminar.)

Costo del primer mes (transferencia + almacenamiento externo): _pendiente._

### Recuperar

Elegir la ruta por la antigüedad y el tamaño del daño:

| Situación | Ruta |
|---|---|
| Error de los últimos 7 días que afecta documentos identificables | (a) PITR |
| Muchos documentos de los últimos 7 días | (a') export a un minuto + (b) |
| Error de hace más de 7 días, o pérdida del proyecto `farma-jyv` | (b) bucket externo |

**(a) PITR — reescribir solo los documentos afectados**

1. Fijar el minuto **anterior** al error (bitácora `auditLogs`, logs de `api`). Más
   de una hora atrás debe ser un minuto entero (`…:00Z`).
2. Listar los documentos afectados, incluidos los que dependen entre sí: un lote y
   su producto (`totalStock` es la suma de los lotes), una venta y sus
   `stockMovements`.
3. En seco (no escribe; muestra qué cambió en cada documento):

   ```bash
   gcloud auth application-default login
   cd functions
   npm run pitr:restore -- --project farma-jyv --read-time 2026-11-02T15:04:00Z \
     --doc products/<id> --doc batches/<id>
   ```

4. Revisar la salida (`~` cambió, `+` se borró después, `-` no existía entonces) y
   repetir con `--execute`. Los documentos creados después del error solo se
   borran con `--delete-created`. Deja una entrada `maintenance.pitr_restored` en
   `auditLogs`. Tope: 450 documentos por corrida.
5. Verificar en el panel y avisar a la farmacia si hubo ventas en medio: una venta
   posterior al minuto elegido no se pierde (no se lista), pero su efecto en un
   lote reescrito sí; recontar ese lote.

**(a') Muchos documentos en la ventana de 7 días**: export consistente a ese
minuto y seguir con (b) importándolo en el proyecto de respaldos:

```bash
gcloud firestore export "gs://farma-jyv-respaldos-firestore/manual/pitr-<fecha>" \
  --snapshot-time=2026-11-02T15:04:00Z --project farma-jyv
```

**(b) Desde el bucket externo**

- **Pérdida de documentos (más de 7 días)**: importar el export elegido en el
  proyecto de respaldos con los pasos del simulacro (`restore-drill.mjs preflight`
  y `import --export gs://…`), leer de ahí lo que haga falta y reescribirlo en
  producción por documento. **Nunca** `gcloud firestore import` sobre `farma-jyv`:
  sobrescribe todo lo que trae el volcado con su versión vieja.
- **Pérdida del proyecto `farma-jyv`**:
  1. Crear el proyecto nuevo con Firestore en la **misma ubicación** que tenía
     producción (la del bucket origen) y darle a su agente de Firestore
     (`service-<número>@gcp-sa-firestore.iam.gserviceaccount.com`)
     `roles/storage.objectViewer` sobre el bucket externo.
  2. Elegir el export completo más reciente (el que tiene
     `<carpeta>.overall_export_metadata`):
     `node scripts/ops/restore-drill.mjs latest --project <respaldos> --bucket <externo> --apply`.
  3. `gcloud firestore import gs://<externo>/firestore-backups/<carpeta> --project <nuevo>`.
  4. Desplegar índices (§1), reglas y funciones al proyecto nuevo, recrear
     variables de entorno (`docs/AMBIENTES.md`) y apuntar panel y POS a la API
     nueva. Firebase Auth, Storage y R2 no están en el export (SPEC 31 non-goals).

### Simulacro mensual de restauración (SPEC 43)

Un respaldo que nunca se restauró es una suposición. El primer día de cada mes
se abre un issue «Simulacro de restauración <mes>» con este checklist (workflow
de GitHub Actions del repo); se cierra al anotar el resultado abajo.

**Destino único: el proyecto de respaldos.** El export trae `patients` y
`medicalRecords` (NOM-004): nunca `farma-jyv` ni `farma-jyv-dev`.
`scripts/ops/restore-drill.mjs` rechaza esos proyectos (y `demo-*`) aun en seco.

Procedimiento (cada paso en seco primero, luego `--apply`):

```bash
export BACKUP_PROJECT=farma-jyv-respaldos EXTERNAL_BUCKET=farma-jyv-respaldos-externo
D="node scripts/ops/restore-drill.mjs"
```

1. **Base vacía antes de empezar** — `$D preflight --project $BACKUP_PROJECT --bucket $EXTERNAL_BUCKET --apply`.
   Crea la base `(default)` en la misma ubicación que producción si no existe,
   concede al agente de Firestore del proyecto solo lectura sobre el bucket
   externo (sin eso el import da `PERMISSION_DENIED`) y **se detiene si la base
   tiene datos** (un simulacro anterior interrumpido): correr `cleanup` primero.
2. **Elegir el export** — `$D latest … --apply`: el completo más reciente del
   bucket externo. Si el de anoche falló o está incompleto, usa el último completo
   e imprime el hueco: anotarlo.
3. **Importar y medir** — `$D import … --apply` (o `--export gs://…/<carpeta>/`).
   Imprime la duración del import.
4. **Comparar conteos** — `$D verify … --export gs://…/<carpeta>/ --apply`:
   `count()` de `sales`, `batches`, `products` y `cashSessions` en la base
   restaurada contra producción **a la hora del export** (lectura PITR, solo
   lectura). Si el export tiene más de 7 días, cuenta producción hoy y la
   diferencia se explica.
5. **Leer una venta y un corte del día del export** — el mismo `verify` muestra
   una venta y un corte del día anterior al export y avisa si les falta algún
   campo obligatorio. Abrir los dos en la consola de Firestore del proyecto de
   respaldos y confirmar que se ven completos.
6. **Anotar** en el registro de abajo: fecha, export usado, duración, conteos y
   resultado. Si los conteos difieren sin explicación, abrir un issue antes de dar
   el simulacro por bueno.
7. **Borrar lo restaurado** — `$D cleanup … --apply` borra la base `(default)` del
   proyecto de respaldos (nunca el bucket) y comprueba que no quede nada. Anotar
   que se borró.

El import y el borrado se cobran por documento: anotar el costo del primer
simulacro.

| Fecha | Export usado | Duración import | sales | batches | products | cashSessions | Resultado | Base borrada |
|---|---|---|---|---|---|---|---|---|
| _pendiente: primer simulacro_ | | | rest./prod | rest./prod | rest./prod | rest./prod | | |


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
`npm ci` → `npm run lint` → `npm run build` → `npm run test:coverage` →
**`npm run test:rules` desde la raíz** (paso `Pruebas de reglas`, SPEC 33). Instala
Temurin JDK 21 porque las pruebas arrancan el emulador de Firestore, que
necesita JVM, y publica el reporte de cobertura como artefacto durante 14 días
aunque las pruebas fallen.

El paso de reglas corre desde la raíz a propósito: desde `functions/` el emulador
no ve el `firebase.json` raíz, arranca con reglas abiertas y las aserciones
pasarían en vacío. Para comprobar que el paso muerde: cambiar un `assertFails` por
`assertSucceeds` en `functions/test-rules/` debe dejar el CI en rojo con
`evaluation error at L<n>` apuntando a `firestore.rules`.

**`ci.yml` no despliega.** El despliegue lo hace `deploy.yml` cuando el CI de
`main` termina en verde (§8).

Workflows del repo:

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `ci.yml` | push a `main`, PRs, llamado por `deploy.yml` | lint, build, tests, reglas |
| `deploy.yml` | CI verde en `main` → dev; tag `v*` → prod con aprobación | despliegue (§8) |
| `simulacro-restauracion.yml` | día 1 de cada mes, 09:00 CDMX, y a mano | abre el issue del simulacro (§4, SPEC 43) |

GitHub desactiva los workflows programados de un repo sin actividad en 60 días;
si el issue del simulacro no llega, revisa la pestaña Actions.

El CI corre contra el emulador con el proyecto `farma-jyv-test`: no toca datos
reales ni necesita credenciales.

Las suites corren **aisladas**: `functions/test/teardown-admin.ts` vacía la base
del emulador antes de cada archivo. De ahí salen dos propiedades que conviene
conocer antes de declarar roto el CI:

- **Un fallo de CI es un fallo real.** Hasta septiembre de 2026 la prueba de
  concurrencia de ventas fallaba ~1 de cada 4 corridas por contención del
  emulador; ya no. Si vuelve a aparecer un rojo intermitente, es una suite nueva
  que depende de datos escritos por otra — arréglala, no la reintentes.
- **La cobertura es reproducible** (±0.02 entre corridas), así que el piso de
  `coverageThreshold` va justo por debajo de lo medido. Bajarlo debe ser una
  decisión explícita en el commit, no un ajuste para que pase.

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

Hay **dos** políticas, y se complementan:

| Política | Se dispara con | Para qué |
|---|---|---|
| `errores en la API` (`15126880163367668267`) | más de 5 respuestas `5xx` en 5 min | algo se rompió en serio |
| `error nuevo en la API` (`206274569130471057`) | cualquier log `severity>=ERROR` | un 500 aislado, aunque ocurra una sola vez |

La segunda es una alerta **basada en log**, así que cubre lo que daban las
notificaciones de Error Reporting de la consola sin depender de un paso manual.
Está limitada a un aviso por hora para que un error repetido no llene el correo.

Error Reporting sigue siendo el sitio donde se **lee** el error: agrupa por stack
y muestra el contexto que escribe `AppExceptionFilter`.

Revisión rápida desde la terminal:

```bash
firebase functions:log --only api | grep -i "ERROR"
```

### Alertas de operación (SPEC 32)

Las dos políticas de arriba solo ven errores de la API que responde. SPEC 32 suma
avisos para la API caída, las funciones programadas, la copia externa y el gasto,
y un **segundo destinatario** (el dueño de la farmacia) en todas, incluidas las
dos existentes. Todo está declarado en `scripts/ops/defs/` y la lista de funciones
en `scripts/ops/scheduled-jobs.json` (una prueba de Jest falla si se agrega un
`onSchedule` sin su fila o sin `monitoredJob`).

Aplicar (en seco primero; probar en `farma-jyv-dev` antes que en producción):

```bash
export OPS_EMAIL=vitor5608@gmail.com OWNER_EMAIL=<correo del dueño de la farmacia>
node scripts/ops/gcp.mjs alerts --project farma-jyv-dev            # en seco
node scripts/ops/gcp.mjs alerts --project farma-jyv-dev --apply    # prueba en dev
node scripts/ops/gcp.mjs alerts --project farma-jyv --apply
node scripts/ops/gcp.mjs transfer-alert --project farma-jyv-respaldos --apply
node scripts/ops/gcp.mjs budget --project farma-jyv --billing-account XXXXXX-XXXXXX-XXXXXX --apply
```

`alerts` crea o reutiliza los dos canales de correo (busca por dirección, así que
el canal de 2026-09-17 se reutiliza), la métrica de log
`farmajyv_scheduled_job_runs` (cuenta `scheduled_job.finished` por `function` y
`outcome`), el uptime check, las políticas, y agrega los dos canales a las
políticas existentes sin tocar su disparador. Al final imprime la tabla de abajo
con los ids reales: **pegarla aquí** al aplicar en producción.

| Política | id | Se dispara con | Canales |
|---|---|---|---|
| errores en la API | `15126880163367668267` | más de 5 respuestas `5xx` en 5 min | ops + dueño |
| error nuevo en la API | `206274569130471057` | cualquier log `severity>=ERROR` (1 aviso/h) | ops + dueño |
| API caída (/v1/health) | `805394045522047583` | `GET /v1/health` falla desde ≥ 2 de 3 regiones durante 5 min (chequeo cada 5 min, timeout 30 s) | ops + dueño |
| falló dailyFirestoreBackup | `9455455192738900608` | 2 intentos fallidos en 1 h (`retryCount: 1`: el primer fallo con reintento exitoso no avisa) | ops + dueño |
| falló dailySalesReport | `3464500085811061360` | 1 intento fallido (sin reintentos) | ops + dueño |
| falló monthlySalesReport | `6283531999313191507` | 1 intento fallido | ops + dueño |
| falló monthlyAccountantReport | *(pendiente: SPEC 45, pegar al aplicar)* | 1 intento fallido (incluye «falló el envío a un destinatario») | ops + dueño |
| falló dailyInventoryAlerts | `5308074763393349498` | 1 intento fallido | ops + dueño |
| falló dailyPromotionsMaintenance | `15354933137577699141` | 1 intento fallido | ops + dueño |
| falló dailyStatsIntegrityCheck | `9663636852653746300` | 1 intento fallido | ops + dueño |
| dailyFirestoreBackup sin ejecución exitosa en 26 h | `15249784735070526972` | ningún `succeeded` del respaldo en 26 h (schedule pausado, función borrada) | ops + dueño |
| falló la copia externa (proyecto de respaldos) | `89153530632118187` | un mensaje `FAILED`/`ABORTED` del job de Storage Transfer | ops + dueño |
| Presupuesto mensual `farma-jyv` (facturación, no Monitoring) | `35aacec8-73c0-4a21-8bf2-b0e86b64c637` | gasto del mes ≥ 50 %, 90 % y 100 % de MXN 95 (≈ US$5; la cuenta factura en MXN) | ops + dueño + admins de facturación |

Notas:

- **Cada aviso dice qué función falló**: el nombre va en el título de la
  política y en el correo, junto con qué hacer.
- **Timeout del uptime check**: 30 s. Debe ser mayor que el peor arranque en frío
  medido (§8); subirlo con `--uptime-timeout` (máximo 60) si la medición lo pide.
- **Un despliegue no alerta**: la política exige 5 minutos de fallo desde dos
  regiones; un `api` sin responder unos segundos no lo cumple.
- **Presupuesto en dólares**: la moneda debe ser la de la cuenta de facturación.
  Si es MXN, el API rechaza `USD`: pasar `--currency MXN --amount <equivalente>`.
  El presupuesto avisa, **no corta** el servicio. Si el aviso del 50 % llega todos
  los meses (PITR y la copia externa suman gasto), se revisa el monto.
- **Límite conocido**: la política existente «error nuevo en la API» avisa ante
  cualquier log `ERROR`, y el runtime registra como `ERROR` la excepción de un
  intento fallido aunque el reintento funcione. SPEC 32 prohíbe cambiar esa
  política; si ese aviso resulta ruido, se decide aparte.
- Si los avisos técnicos resultan ruido para el dueño, separar un canal solo para
  caídas y fallos de respaldo (riesgo anotado en SPEC 32).

Probar en `farma-jyv-dev` (criterios de aceptación de SPEC 32):

| Prueba | Cómo | Esperado |
|---|---|---|
| API caída | `--health-path /v1/no-existe` en dev y `--apply` | aviso en ≤ 10 min |
| Caída corta | desplegar `api` en dev | sin aviso |
| Fallo del respaldo | `FIRESTORE_BACKUP_BUCKET=bucket-que-no-existe` en `.env.farma-jyv-dev`, desplegar y forzar con `gcloud scheduler jobs run firebase-schedule-dailyFirestoreBackup-us-central1 --location us-central1 --project farma-jyv-dev` | aviso «falló dailyFirestoreBackup» tras el reintento |
| Fallo con reintento exitoso | dar tiempo al reintento (`gcloud scheduler jobs update http firebase-schedule-dailyFirestoreBackup-us-central1 --min-backoff=10m …`), quitar a la cuenta de las funciones su rol sobre el bucket de dev, forzar el job y devolver el rol antes de 10 min | sin aviso de la política de la función; restaurar `--min-backoff` |
| Ausencia | `gcloud scheduler jobs pause firebase-schedule-dailyFirestoreBackup-us-central1 …` | aviso tras 26 h; `resume` al terminar |
| Transferencia | quitar el rol del agente sobre el bucket destino y `gcloud transfer jobs run …` | aviso «falló la copia externa» |

Logs de una función programada:
`gcloud logging read 'jsonPayload.event="scheduled_job.finished" AND jsonPayload.job="dailyFirestoreBackup"' --project farma-jyv --freshness=3d`.

---

## 8. Arranque en frío de `api` (SPEC 34)

Pregunta: ¿necesita `api` una instancia mínima en horario de tienda? Se decide
con 14 días medidos, no a ojo. Horario de tienda: L–V 09:00–20:00, sábado
09:00–13:00, domingo cerrado (`WORKING_HOURS` tomado de corrido;
`scripts/ops/lib/store-hours.mjs`).

**Consulta guardada** «FarmaJyV · arranques en frío de api»
(`node scripts/ops/gcp.mjs saved-query --project farma-jyv --apply`; si el API de
consultas guardadas no responde, el script lo dice y basta "Guardar" desde el
enlace):
[abrir en el Explorador de registros](https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%0Aresource.labels.service_name%3D%22api%22%0A((logName%3D%22projects%2Ffarma-jyv%2Flogs%2Frun.googleapis.com%252Fvarlog%252Fsystem%22%20AND%20textPayload%3A%22Starting%20new%20instance%22)%20OR%20logName%3D%22projects%2Ffarma-jyv%2Flogs%2Frun.googleapis.com%252Frequests%22);duration=P14D?project=farma-jyv).

Muestra los arranques de instancia (`Starting new instance. Reason: …`) y las
peticiones con `labels.instanceId` y `httpRequest.latency`. La latencia en frío
es la de la **primera petición** de cada `instanceId`.

**Tabla de 14 días**:

```bash
node scripts/ops/reports.mjs cold-start --project farma-jyv --from <primer día> \
  --holidays 2026-11-16,2026-12-25      # festivos en que la farmacia cerró
```

Excluye domingos y festivos, arranques fuera de horario y los de despliegue
(motivo `DEPLOYMENT` o a menos de 10 min de la primera aparición de una revisión;
`--deploy-grace-minutes` lo cambia). Solo lee Logging. Pegar aquí la salida:

| Día | | Arranques en horario | p50 1.ª petición | p95 1.ª petición |
|---|---|---:|---:|---:|
| _pendiente: 14 días de medición_ | | | | |

**Decisión** (umbral: p95 de la primera petición en horario > **3 s**):

- Si lo supera: proponer `minInstances: 1` **solo en horario**, con una tarea
  programada que lo sube al abrir y lo baja al cerrar, y su costo mensual
  estimado. Si esa tarea falla, la función queda con el último valor hasta la
  siguiente corrida.
- Si no: cerrar SPEC 34 con la medición anotada y no cambiar nada.

Decisión tomada: _pendiente de la medición._

---

## 9. Límites de uso compartidos entre instancias (SPEC 42)

`utils/rate-limiter.ts` cuenta en memoria de cada instancia: con N instancias el
límite real de las rutas que pagan OpenRouter (asistente 15/min y 5/min,
invoice-rag 20/min y 60/min) es N veces el declarado. Hoy no compensa
compartirlo; esto deja **medible** cuándo sí.

**Instancias** — dashboard «FarmaJyV · instancias de api (SPEC 42)»
(`node scripts/ops/gcp.mjs dashboard --project farma-jyv --apply` imprime el
enlace; pegarlo aquí: _pendiente_). Grafica `run.googleapis.com/container/instance_count`
(estado `active`) de `api` solo en horario de tienda; el pico de cada día es su
máximo diario. La cifra exacta por día y la racha:

```bash
node scripts/ops/reports.mjs instances --project farma-jyv --days 14
```

**Gasto de OpenRouter** — OpenRouter no da un gasto mensual por proyecto en su
API pública que sirva aquí: la consulta es **manual** en su panel. Entrar a
`https://openrouter.ai/activity` con la cuenta dueña de `OPENROUTER_API_KEY`,
filtrar el mes en curso y leer el costo total (o el uso de esa llave en
`https://openrouter.ai/settings/keys`). Revisarlo el día 1 de cada mes.

**Disparador** — se cumple con **cualquiera** de los dos:

1. `api` sostiene **más de 3 instancias activas** en horario de tienda durante
   **7 días de tienda seguidos** (el domingo no suma ni corta la racha; un día con
   3 o menos sí la corta). Un pico de un día (despliegue, prueba de carga) no
   cuenta. El tráfico fuera de horario (sincronizaciones nocturnas) tampoco.
2. El gasto mensual de OpenRouter supera **US$5**, aunque sea por un uso puntual
   (p. ej. una carga masiva de facturas).

**Acción al cumplirse**: abrir un spec nuevo para compartir el límite entre
instancias, con este diseño de referencia como punto de partida (sin compromiso):
contador en Firestore por `uid` + ruta + minuto
(`rateLimits/<uid>:<ruta>:<minuto>`), incrementado en transacción, con
`expiresAt` y política TTL en `firestore.indexes.json` (`indexes: []`), solo para
las rutas de OpenRouter, *fail-open* si Firestore falla. Ese spec decide si el
límite compartido es la respuesta o basta revisar el uso. No incluye compartir
`MemoryCache`, Redis ni límites por IP.

---

## 10. Liberación (despliegue desde GitHub Actions)

Contrato (SPEC 39): **merge a `main` con CI verde = `farma-jyv-dev`**; **tag
`vX.Y.Z` sobre `main` = candidato a `farma-jyv`**, que sale solo cuando `dev-jyv`
aprueba el environment `production`. El backend y el panel tienen **tags
independientes**: un tag del backend despliega solo el backend y uno del panel
solo el panel.

`deploy.yml` se autentica con **Workload Identity Federation**: ninguna llave JSON
vive en GitHub. Nunca subas una llave de cuenta de servicio como secreto.

### 10.1 Una sola vez por proyecto (dueño de la cuenta)

1. `scripts/ci/setup-wif.sh farma-jyv-dev` y `scripts/ci/setup-wif.sh farma-jyv`
   (con `gcloud auth login`). Crean el pool `github-actions`, el proveedor `github`
   (solo los repos `dev-jyv/backend-farma-jyv` y `dev-jyv/farma-jyv-admin`; dev
   solo `main` + environment `dev`, prod solo tags `v*` + environment
   `production`) y las cuentas `deploy-backend@` (Functions, reglas, índices,
   Storage) y `deploy-admin@` (solo Hosting), cada una suplantable solo por su
   repo. Imprimen los valores de las variables de GitHub.
2. Política de limpieza de imágenes de Functions, para que el deploy no
   interactivo no falle pidiéndola:
   `firebase functions:artifacts:setpolicy --project <dev|prod> --location us-central1 --days 7 --force`.
3. En **cada repo** (backend y panel), environments de GitHub:
   - `dev`: rama de despliegue `main`. Variables `GCP_WORKLOAD_IDENTITY_PROVIDER`,
     `GCP_DEPLOY_SERVICE_ACCOUNT` (las de `farma-jyv-dev`).
   - `production`: reglas de despliegue solo tags `v*` y las mismas dos variables
     con los valores de `farma-jyv`. En el backend, además, **revisor requerido
     `dev-jyv`**. El panel no lleva revisor: es un repo privado en el plan
     gratuito de GitHub, que no admite revisores ahí; crear el tag es la
     aprobación (§10.4).
   - Solo backend, en los dos environments: variable `FUNCTIONS_ENV_FILE` con el
     contenido de `functions/.env.<proyecto>` **sin credenciales** (CORS, RECEIPT_*,
     REPORTS_EMAIL_*, R2_ACCOUNT_ID/R2_BUCKET, FIRESTORE_BACKUP_BUCKET…).
     `scripts/ci/write-functions-env.mjs` la escribe en el job y se niega si trae
     cualquiera de las siete credenciales de SPEC 35 (las variables se ven en
     claro) o si el código todavía no las declara con `defineSecret`.
4. Etiqueta `requiere-paso-manual` en ambos repos.
5. Secretos (SPEC 35), antes del primer despliegue desde el pipeline: los siete
   tienen que existir en el proyecto (§11.1) — el job `Verificar secretos en
   Secret Manager` corre `check-secrets.mjs` y se detiene nombrando el que falte —
   y la cuenta de servicio de las funciones ya debe tener
   `roles/secretmanager.secretAccessor` sobre cada uno. `deploy-backend@` solo
   tiene `roles/secretmanager.viewer` y **no puede concederlo**: haz el primer
   despliegue con secretos a mano (§11.4, que lo concede) o da el acceso con el
   `gcloud secrets add-iam-policy-binding` de §11.2. Un secreto nuevo en
   `config/secrets.ts` repite este paso.

Hasta que SPEC 35 esté en `main`, el job de despliegue falla a propósito en el
paso de variables: el pipeline no maneja credenciales en `.env`. Mientras tanto,
despliegue manual (§10.5).

### 10.2 Etiquetar PRs con pasos manuales

Un PR que exija backfill, `migrate:roles`, crear un secreto u otro paso de este
RUNBOOK antes o después del código lleva la etiqueta **`requiere-paso-manual`**
y una línea en su descripción:

```
Paso manual: RUNBOOK §2b — backfill:search-name antes de desplegar
```

El pipeline **no** ejecuta backfills ni `migrate:roles`. Si la línea falta, el
resumen del run lo marca como "no indicado".

### 10.3 Liberar a producción

1. Confirmar que `main` está desplegado y probado en `farma-jyv-dev` (el job `dev`
   de `deploy.yml` corre solo tras cada CI verde de `main`).
2. Si el panel a liberar depende de un cambio del backend: **backend primero**.
   Con tags independientes nada lo impone; liberar el panel antes rompe el panel
   en producción.
3. Crear el tag sobre `main` (`git tag v1.4.0 origin/main && git push origin v1.4.0`,
   o un *release* en GitHub).
4. En el run de `Deploy`: `verificar-tag` (el commit está en `main`), `CI del tag`
   (el CI completo, incluidas reglas) y `pasos-manuales`, que escribe en el
   **resumen del run** los PRs con `requiere-paso-manual` desde el tag anterior y
   el paso que piden.
5. Hacer esos pasos que van *antes* del código, y solo entonces **aprobar**
   `production`. Aprobar es la confirmación; no hay otro registro.
6. El job `prod` despliega `firestore:indexes`, espera a que ningún índice quede
   en `CREATING` (`scripts/ci/wait-firestore-indexes.sh`, tope 30 min; si se
   excede o alguno queda en `NEEDS_REPAIR` falla sin desplegar funciones) y
   después `functions,firestore:rules,storage`.
7. Hacer los pasos que van *después* del código (`migrate:roles`, backfills de
   código-primero como §2d) y verificar.

Si una función falla a medias, el job falla y lo reporta; **no se reintenta
solo**. Revisa el log, corrige y relanza el job (o etiqueta un parche). No hay
rollback automático: volver atrás es etiquetar el commit anterior como versión
nueva (`v1.4.1` apuntando al código bueno) o desplegarlo a mano.

Dos merges seguidos a `main`: el despliegue a dev del segundo cancela el del
primero (`concurrency`). Los de producción nunca se cancelan entre sí: esperan.

**No despliegues a mano mientras corre un job de `deploy.yml`** contra el mismo
proyecto: Firebase serializa, pero el estado final es el del último en terminar.

### 10.4 Panel

`farma-jyv-admin/.github/workflows/deploy.yml` sigue el mismo flujo para Hosting
(`hosting:admin-dev` en dev, `hosting:admin` en prod), con sus propios tags `v*`,
su environment `production` y su propio resumen de PRs con
`requiere-paso-manual`. No despliega índices: el panel no tiene.

**El panel no espera aprobación**: el repo es privado y el plan gratuito de
GitHub no admite revisores requeridos en repos privados. El job `prod` corre en
cuanto el CI del tag y `pasos-manuales` terminan, así que **crear el tag es la
aprobación**: revisar antes el resumen de PRs con `requiere-paso-manual` (con
`gh pr list -R dev-jyv/farma-jyv-admin --label requiere-paso-manual --state merged`)
y hacer los pasos que van antes del código.

### 10.5 Despliegue manual (GitHub Actions caído o `dev-jyv` no disponible)

Con `firebase login` y `gcloud auth login` de una cuenta con acceso, desde un
checkout limpio del commit a liberar (el del tag) y con los `.env.<proyecto>`
locales (docs/AMBIENTES.md):

```bash
# Backend, en este orden (§1 / §2e)
firebase deploy --project prod --only firestore:indexes
scripts/ci/wait-firestore-indexes.sh farma-jyv
npm --prefix functions run deploy:prod

# Panel, desde farma-jyv-admin
npm ci && npm run deploy:prod
```

Haz igual los pasos manuales de los PRs etiquetados (búscalos con
`gh pr list --label requiere-paso-manual --state merged`) y anota en el PR o en
el release que se desplegó a mano y por qué.

---

## 11. Secretos en Secret Manager (SPEC 35)

Las credenciales del backend viven en **Cloud Secret Manager** de cada proyecto,
no en `functions/.env.<proyecto>`. Se declaran una sola vez en
`functions/src/config/secrets.ts` (`defineSecret`) y Firebase las monta como
variables de entorno **al arrancar la instancia**, solo en las funciones que las
declaran. Nada lee Secret Manager por petición.

| Secreto | Proveedor | Montado en | Tiene valor hoy |
|---|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Mercado Pago | `api` | sí |
| `MERCADOPAGO_WEBHOOK_SECRET` | Mercado Pago | `api` | **no**: espacio reservado en blanco |
| `RESEND_API_KEY` | Resend | `api`, `dailySalesReport`, `monthlySalesReport`, `dailyInventoryAlerts`, `dailyPromotionsMaintenance`, `hourlyPosSilenceCheck` | sí |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 | `api` | sí |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 | `api` | sí |
| `MIGRATE_SECRET` | propio (aleatorio) | `api` | sí |
| `OPENROUTER_API_KEY` | OpenRouter | `api` | sí |

`dailyFirestoreBackup`, `dailyStatsIntegrityCheck` y `reportsPdf` no montan ninguno
(los PDF solo leen Firestore; si algún día uno toca R2, sin las llaves cae a
`uploads/` igual que sin configurar). Lo no
secreto (`CORS_ORIGINS`, `RECEIPT_*`, `REPORTS_EMAIL_*`, `R2_ACCOUNT_ID`,
`R2_BUCKET`, `MERCADOPAGO_USER_ID`, modelos de OpenRouter…) sigue en los `.env`.

**Comportamiento sin valor**, igual que antes: R2 sin alguna llave manda las
facturas a `uploads/` de Firebase Storage; el webhook de Mercado Pago sin secreto
se rechaza en producción (el POS resuelve por sondeo); sin token de Mercado Pago,
Resend u OpenRouter esas rutas responden su error controlado. Un valor en blanco
cuenta como "sin valor" (el backend recorta).

Los dos chequeos que protegen el deploy (`deploy:dev` / `deploy:prod` los corren
solos):

- `scripts/check-env-split.mjs` — falla si alguno de los siete aparece, aunque
  sea vacío, en `functions/.env` o `functions/.env.<proyecto|alias>`.
- `scripts/check-secrets.mjs <dev|prod>` — falla, **nombrando el que falta**, si
  algún secreto no existe en el proyecto o su última versión no está habilitada.
  Sin él, `firebase deploy` interactivo *pide el valor en la terminal* y lo crea
  al vuelo; no escribas valores ahí: cancela y sigue §11.1. A mano:
  `npm --prefix functions run check:secrets -- dev`.

Permisos de quien opera: `roles/secretmanager.admin` para crear y rotar (o
`roles/secretmanager.secretVersionManager` si el secreto ya existe);
`roles/secretmanager.viewer` basta para `check:secrets` (solo metadatos).
`roles/secretmanager.secretAccessor` (leer valores) solo a la cuenta de servicio
de las funciones y, puntualmente, a quien corra `migrate:roles` remoto.

### 11.1 Crear (por proyecto: primero `farma-jyv-dev`, luego `farma-jyv`)

```bash
# Pide el valor sin mostrarlo. Repetir por cada secreto con valor.
firebase functions:secrets:set RESEND_API_KEY --project dev

# MIGRATE_SECRET: 48 bytes aleatorios (≥ 32), sin salto de línea.
openssl rand -base64 48 | tr -d '\n' \
  | firebase functions:secrets:set MIGRATE_SECRET --data-file=- --project dev

# MERCADOPAGO_WEBHOOK_SECRET todavía no tiene valor (configurarlo es otra tarea):
# solo se reserva su espacio con un blanco (no vacío, para que la versión exista
# con contenido), que el backend recorta y trata como "sin secreto".
printf ' ' | firebase functions:secrets:set MERCADOPAGO_WEBHOOK_SECRET --data-file=- --project dev

# Verificar que estén los siete antes de desplegar:
npm --prefix functions run check:secrets -- dev
```

En dev, credenciales de **prueba** (Mercado Pago `TEST-...`, bucket R2 aparte,
dominio/destinatario de prueba en Resend).

### 11.2 Dar acceso

`firebase deploy` concede `roles/secretmanager.secretAccessor` sobre cada
secreto a la cuenta de servicio con la que corre cada función que lo declara
(por omisión, la de Compute Engine:
`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`). No hace falta tocar
IAM salvo que cambie la cuenta de servicio o se quiera dar acceso a una persona:

```bash
gcloud secrets add-iam-policy-binding MIGRATE_SECRET --project farma-jyv \
  --member="user:<correo>" --role="roles/secretmanager.secretAccessor"
# y quitarlo al terminar:
gcloud secrets remove-iam-policy-binding MIGRATE_SECRET --project farma-jyv \
  --member="user:<correo>" --role="roles/secretmanager.secretAccessor"
```

Revisar quién puede leer: `gcloud secrets get-iam-policy <NOMBRE> --project <proyecto>`.
Las lecturas de valores quedan en Cloud Audit Logs (Data Access de Secret
Manager, si está habilitado para el servicio).

### 11.3 Rotar — en este orden, por proyecto y por secreto

1. **Emitir el valor nuevo en el proveedor** sin revocar el viejo.
2. **Guardarlo** en Secret Manager:
   `firebase functions:secrets:set <NOMBRE> --project <dev|prod>` (crea una
   versión nueva).
3. **Desplegar** (`npm --prefix functions run deploy:<dev|prod>`). Las instancias
   calientes conservan el valor anterior hasta reciclarse: el deploy crea una
   revisión nueva y es lo que fuerza el cambio. Sin deploy, el valor nuevo no se
   usa.
4. **Verificar el flujo que lo usa** (tabla de abajo).
5. **Revocar el valor viejo en el proveedor.** Nunca antes de 4: revocar primero
   deja sin cobros con tarjeta, correos o facturas.
6. Destruir las versiones viejas en Secret Manager:
   `firebase functions:secrets:prune --project <dev|prod>` (o
   `firebase functions:secrets:destroy <NOMBRE>@<versión>`).

| Secreto | Emitir nuevo / revocar viejo | Verificar |
|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Mercado Pago → Tus integraciones → la app → Credenciales → renovar | una orden Point (`POST /v1/payments/mercadopago/orders`) cobrada en la terminal. **Probar primero en dev**: renovar puede afectar la vinculación con la Point |
| `RESEND_API_KEY` | Resend → API Keys → crear (solo envío) / borrar la vieja | `POST /v1/internal/reports/daily` con `x-migrate-secret` llega al correo |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | Cloudflare → R2 → Manage API tokens → token Object Read & Write **solo sobre el bucket** / borrar el viejo. Las dos se rotan juntas | subir un comprobante a `POST /v1/uploads/facturas`, que quede en `facturas/` y que su URL firmada abra |
| `OPENROUTER_API_KEY` | OpenRouter → Keys → crear / borrar la vieja | una pregunta a `POST /v1/assistant/chat` responde (no 503) |
| `MIGRATE_SECRET` | `openssl rand -base64 48` (no hay proveedor: queda revocado cuando el deploy deja de montar la versión vieja y se destruye en el paso 6) | `POST /v1/internal/migrate-roles` con el nuevo responde 200 y con el viejo **403** |
| `MERCADOPAGO_WEBHOOK_SECRET` | hoy no se rota (espacio en blanco). Al configurarlo: Mercado Pago → Webhooks → clave secreta | un aviso firmado del panel de MP llega y uno sin firma se rechaza |

### 11.4 Migración inicial desde `.env` (una vez por proyecto: dev, después prod)

Los valores que vivieron en `.env` viajaron en paquetes desplegados: **se rotan**,
no se copian.

1. Crear los siete secretos con valores **nuevos** (§11.1 y pasos 1–2 de §11.3).
2. Borrar las siete líneas de `functions/.env.<proyecto>` (y de `functions/.env`
   si las hubiera). `check-env-split` no deja desplegar mientras sigan ahí.
3. `npm --prefix functions run deploy:<dev|prod>` (corre los dos chequeos).
4. Verificar: venta con tarjeta / orden Point, correo de reporte manual, subida a
   `facturas/`, consulta al asistente, `migrate-roles` con el secreto nuevo.
5. Revocar en cada proveedor los valores viejos y comprobar que fallan (p. ej.
   `migrate-roles` con el `MIGRATE_SECRET` viejo responde 403).
6. Pedir a todos los que tengan `functions/.env.farma-jyv` /
   `.env.farma-jyv-dev` locales que borren de ahí los valores viejos.

### 11.5 Local (emulador y `npm run dev`)

No usan Secret Manager. Los valores salen de `functions/.secret.local` (ignorado
por git y por el deploy); `npm run emulators` lo completa solo, con `" "` para lo
que no tenga valor (el emulador no sale a buscarlo y el backend lo trata como
"sin valor"). Plantilla: `functions/.secret.local.example`. `npm run dev` carga
`.env`, `.env.local` y `.secret.local`, en ese orden. En Jest, las pruebas
inyectan los valores con `process.env`. Los scripts locales (`migrate:roles`,
`seed:emulator`) siguen leyendo `process.env`; para `migrate:roles` remoto:

```bash
MIGRATE_SECRET="$(firebase functions:secrets:access MIGRATE_SECRET --project prod)" \
  npm --prefix functions run migrate:roles
```

---

## 12. PDF fuera de `api`: función `reportsPdf` (SPEC 38)

Los PDF lanzan Chromium (Puppeteer + `@sparticuz/chromium`). Dentro de `api`
(512 MiB, 60 s) un reporte grande podía agotar la memoria y tumbar la instancia
que también atiende a las cajas. Desde SPEC 38 los sirve una función HTTP aparte:

| | `api` | `reportsPdf` |
|---|---|---|
| Región | `us-central1` | `us-central1` |
| Memoria / tiempo | 512 MiB / 60 s | **1 GiB / 120 s** |
| Concurrencia por instancia | por defecto | **1** (dos PDF grandes no comparten el GiB) |
| `maxInstances` | — | 5 |
| URL | `https://api-vykfsskx3q-uc.a.run.app` | `https://us-central1-<proyecto>.cloudfunctions.net/reportsPdf` |

Rutas que atiende, todas con prefijo `/v1` y el mismo contrato que en `api`
(parámetros, `Content-Type: application/pdf`, `Content-Disposition`, errores
`{ error: { code, message } }`):

- `GET /reports/exports/sales-daily.pdf`, `sales-monthly.pdf`, `inventory.pdf`,
  `low-stock.pdf`, `expiring.pdf`, `no-cost.pdf`, `expenses-monthly.pdf`,
  `invoices.pdf` — `dashboard:read`.
- `GET /reports/exports/:report?format=pdf` — `dashboard:read` + el `authorize` de
  cada reporte. Aquí solo `pdf`: `xlsx`/`csv` responden 400 y se piden a `api`.
- `GET /accounting/exports/income-statement.pdf`, `balance-sheet.pdf` —
  `accounting:read`.

CORS, `AuthGuard` → `PermissionsGuard`, `AppExceptionFilter`, interceptor y prefijo
salen de `functions/src/common/http-pipeline.ts`, compartido con `api`; los
orígenes son los mismos (`CORS_ORIGINS`, que Firebase carga para todas las
funciones del proyecto). No hay variables nuevas.

### Orden de despliegue

1. **Backend primero.** `npm run deploy:dev` (y luego `deploy:prod`) crea
   `reportsPdf`. Las rutas PDF de `api` **siguen** funcionando: el panel viejo en
   caché las usa.
2. Verificar la función en el proyecto antes de tocar el panel:

   ```bash
   firebase functions:list --project dev | grep reportsPdf
   # Debe responder 401 (sin token), no 404 ni un 403 HTML de Google:
   curl -s -o /dev/null -w '%{http_code}\n' \
     https://us-central1-farma-jyv-dev.cloudfunctions.net/reportsPdf/v1/reports/exports/inventory.pdf
   ```

   Si responde 403 de Google (HTML, no JSON), la función quedó sin invocador
   público: `gcloud functions add-invoker-policy-binding reportsPdf
   --region=us-central1 --member=allUsers --project=<proyecto>` (Firebase lo pone
   solo en `onRequest`; esto es solo si una política de la organización lo quitó).
3. **Panel después.** El panel con `pdfApiUrl` (y el host en `connect-src` del CSP
   de su `firebase.json`, en los dos sitios) se despliega a dev, se descargan los
   PDF de Reportes y de Contabilidad sin errores de CSP en consola, y luego a
   producción.
4. **Borrado, días después.** Cuando el panel nuevo lleve días en producción, un PR
   aparte quita `ReportPdfExportsController` de `ReportsModule` y
   `AccountingPdfExportsController` de `AccountingModule`; con eso `api` deja de
   importar `report-pdf.service.ts`. Un panel en caché vieja recibiría 404 hasta
   recargar, por eso se espera. Ese PR añade la prueba del grafo de imports.

### Diagnóstico

```bash
firebase functions:log --only reportsPdf
gcloud logging read 'resource.labels.service_name="reportspdf" AND severity>=ERROR' --freshness=1h
```

La primera descarga tras un rato sin uso tarda más (arranque en frío con
Chromium); no bloquea la caja porque es otra función.

---

## 13. App Check en modo registro (SPEC 41)

`AppCheckGuard` corre antes de `AuthGuard` y verifica `X-Firebase-AppCheck` en
toda ruta no `@Public()`. **Nunca rechaza**: si falta o no es válida escribe un
log `WARNING` `Petición sin App Check válido` con `appCheck` (`missing` |
`invalid`), ruta, uid, `User-Agent`, `client` y `origin`, y la petición sigue.
Al ser `WARNING`, no dispara la alerta de error nuevo de §7.

`APP_CHECK_MODE` (`off` | `log`): sin la variable vale `log` desplegado (prod y
dev) y `off` en el emulador. No hay `enforce`; rechazar se decide en otro spec con
lo que mida esta consulta.

**Consulta guardada** — conteos por día separados por cliente:

- SQL versionado: [`docs/logging/app-check-sin-token.sql`](docs/logging/app-check-sin-token.sql)
  (Log Analytics). Para casos sueltos: [`docs/logging/app-check-sin-token.filter.txt`](docs/logging/app-check-sin-token.filter.txt)
  (Logs Explorer).
- Consola: <https://console.cloud.google.com/logs/analytics?project=farma-jyv>
  → *Saved queries* → `SPEC 41 · App Check sin token por día`.
  _Enlace directo a la consulta guardada: pendiente de crearla (abajo)._

Cómo leerla: la caja sale siempre como `client = pos` y `missing` (Electron no
tiene proveedor de App Check); el front del consultorio sale como `navegador` con
su propio `origin`. Lo que importa es `navegador` + origen del panel + `missing` o
`invalid`: reCAPTCHA bloqueado por una extensión, un token vencido o alguien
llamando a la API con un ID token fuera del panel.

### Puesta en marcha (una vez por proyecto, `farma-jyv` y `farma-jyv-dev`)

1. Habilitar la API de reCAPTCHA Enterprise y crear una clave de sitio **web**
   con los dominios del panel (`farma-jyv.web.app`, `farma-jyv.firebaseapp.com`,
   `localhost` solo en dev).
2. Consola de Firebase → App Check → app web del panel → proveedor
   *reCAPTCHA Enterprise* con esa clave. **No** activar *Enforce* para ningún
   servicio: el modo registro vive en la API, no en la consola.
3. Poner la clave de sitio en `appCheck.siteKey` de los `environment*.ts` del
   panel y desplegar el hosting (la CSP ya admite reCAPTCHA y App Check).
4. Registrar en App Check → *Manage debug tokens* el token de depuración que
   imprime la consola del navegador con `npm start` del panel.
5. Habilitar Log Analytics en el bucket `_Default` (Logging → Logs Storage →
   *Upgrade*), pegar el SQL, guardarlo con el nombre de arriba, compartirlo con el
   proyecto y reemplazar aquí la línea "pendiente" por su enlace.
6. Anotar el uso de reCAPTCHA Enterprise del primer mes (tiene costo por encima
   de la cuota gratuita).

Verificación rápida tras desplegar `api`:

```bash
# Un ID token válido, sin App Check: misma respuesta que antes y un log `missing`.
curl -s -H "Authorization: Bearer ${ID_TOKEN}" https://api-vykfsskx3q-uc.a.run.app/v1/auth/me
firebase functions:log --only api | grep "App Check"
# /v1/health no deja log de App Check.
curl -s https://api-vykfsskx3q-uc.a.run.app/v1/health
```

---

## 14. Salud de cajas (SPEC 36) — despliegue

`posHealth` es un área de permiso nueva y `posCommands` trae dos índices compuestos.
En orden:

1. Índices primero (§2e): `firebase deploy --project prod --only firestore:indexes,firestore:rules`
   y esperar a que los dos `posCommands [deviceId, …]` estén `READY`.
2. Funciones: `npm run deploy:prod`.
3. Roles: `npm run migrate:roles` (o `POST /v1/internal/migrate-roles` con
   `x-migrate-secret`). Sin este paso `manager` no tiene `posHealth` y el panel le
   responde 403 en `GET /v1/pos/diagnostics`. Verificar después en `roles`:
   `manager` con `{ area: 'posHealth', level: 'write' }`, `cashier` y `doctor` sin el área.
4. Las cajas aparecen en el panel cuando cada POS se actualiza a la versión que reporta
   el diagnóstico (cada sync y, con red, cada 15 min). Una caja reinstalada deja su
   fila vieja; a los 7 días sin reporte el panel la atenúa al final.

---

## 15. Alertas de cajas por correo (SPEC 44) — despliegue

Sin índices ni roles nuevos: la revisión horaria usa el índice automático de un campo
sobre `posDiagnostics.receivedAt`.

1. Verificar que el proyecto tenga `RESEND_API_KEY`, `REPORTS_EMAIL_FROM` y
   `REPORTS_EMAIL_TO` (los mismos de los reportes de ventas). Sin ellos la alerta de
   ventas bloqueadas solo deja un `console.error` y la caja sigue recibiendo 200; la
   revisión horaria deshace la marca y reintenta a la hora siguiente.
2. Funciones: `npm run deploy:dev` primero. El deploy crea la función programada
   `hourlyPosSilenceCheck` (minuto 0 de cada hora, `America/Mexico_City`) y su job de
   Cloud Scheduler; comprobar en la consola que aparece con 256 MiB.
3. Actualizar el POS a la versión que manda `openCashSessionId`. Hasta entonces esa caja
   solo genera alertas de ventas bloqueadas, no de silencio.
4. Prueba de aceptación en dev: abrir turno en una caja de prueba, cortarle la red y
   esperar > 2 h → un correo `Caja <nombre> sin sincronizar desde <hh:mm>`; las corridas
   siguientes no repiten. Reconectar (el reporte limpia `silenceAlertedAt`) y volver a
   desconectar → segundo correo. Repetir sin turno abierto → ningún correo.
5. Logs: `firebase functions:log --only hourlyPosSilenceCheck` ("Revisión de cajas en
   silencio: …") y, para el correo del reporte, buscar
   `No se pudo mandar la alerta de ventas bloqueadas` en los logs de `api`.

---

## 16. Rol contador y correo mensual (SPEC 45) — despliegue

Rol de sistema `accountant` («Contador») con solo `reportDownloads:read`: ve y
descarga ventas de farmacia, ventas de consultorio y compras desde el panel
(`/reportes-contables`), y quien tenga `monthlyReportEmail` recibe el día 1 a las
00:40 un correo con los 7 archivos del mes anterior (PDF y XLSX de ventas de farmacia, ventas de consultorio y compras; XLSX del IVA por producto).
Sin índices nuevos.

1. **Funciones:** `npm run deploy:dev` primero. Crea `monthlyAccountantReport`
   (1 GiB, 300 s, `America/Mexico_City`) y su job de Cloud Scheduler.
2. **Roles:** `npm run migrate:roles` (o `POST /v1/internal/migrate-roles` con
   `x-migrate-secret`). Crea el rol `accountant`; el reporte debe traer
   `rolesCreated: ['accountant']` y ningún rol de sistema en `rolesUpdated` (el
   gerente excluye el área nueva, su lista no cambia).
3. **Alerta:** `node scripts/ops/gcp.mjs alerts --project farma-jyv-dev` (en seco),
   luego `--apply` en dev y en `farma-jyv`. Agrega «falló monthlyAccountantReport»;
   pegar su id en la tabla de §7.
4. **Dominio en Resend (bloqueante para que llegue el correo).** `REPORTS_EMAIL_FROM`
   en producción es `onboarding@resend.dev`, que Resend solo entrega al dueño de la
   cuenta: a cualquier otro destinatario `emails.send` responde error, el job lo
   registra y termina en error (alerta del paso 3). Verificar un dominio en
   Resend (registros DNS SPF/DKIM que indica su consola), cambiar
   `REPORTS_EMAIL_FROM` a una dirección de ese dominio en `functions/.env.farma-jyv`
   (no es secreto) y desplegar. Afecta también a los demás reportes por correo.
5. **Panel:** crear el usuario con rol Contador y activar «Recibir el día 1 el
   correo con ventas y compras del mes».
6. **Prueba en dev:** con un usuario contador con el correo activado,
   `curl -X POST -H "x-migrate-secret: $MIGRATE_SECRET" "$(gcloud functions describe accountantReportTrigger --gen2 --region us-central1 --project <proyecto> --format 'value(serviceConfig.uri)')?month=AAAA-MM"`
   → `{ data: { month, recipients, sent, failed } }` y un correo con 7 adjuntos.
   El disparo manual **reenvía a todos** los destinatarios. Es la función
   `accountantReportTrigger` (1 GiB, 300 s), no una ruta de `api`: en los
   512 MiB / 60 s de `api` los tres PDF tiraban la instancia.

Diagnóstico: `firebase functions:log --only monthlyAccountantReport`; un envío
fallido deja `Correo del contador AAAA-MM: no se pudo enviar a <correo>` y el
mensaje final lista los correos que fallaron.

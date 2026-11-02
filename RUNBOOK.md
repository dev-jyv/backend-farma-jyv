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
`npm ci` → `npm run lint` → `npm run build` → `npm run test:coverage`. Instala
Temurin JDK 21 porque las pruebas arrancan el emulador de Firestore, que
necesita JVM, y publica el reporte de cobertura como artefacto durante 14 días
aunque las pruebas fallen.

**No despliega nada.** El despliegue sigue siendo manual (`npm run deploy`, y los
índices *antes* que el código — §1).

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
| API caída (/v1/health) | _al aplicar_ | `GET /v1/health` falla desde ≥ 2 de 3 regiones durante 5 min (chequeo cada 5 min, timeout 30 s) | ops + dueño |
| falló dailyFirestoreBackup | _al aplicar_ | 2 intentos fallidos en 1 h (`retryCount: 1`: el primer fallo con reintento exitoso no avisa) | ops + dueño |
| falló dailySalesReport | _al aplicar_ | 1 intento fallido (sin reintentos) | ops + dueño |
| falló monthlySalesReport | _al aplicar_ | 1 intento fallido | ops + dueño |
| falló dailyInventoryAlerts | _al aplicar_ | 1 intento fallido | ops + dueño |
| falló dailyPromotionsMaintenance | _al aplicar_ | 1 intento fallido | ops + dueño |
| falló dailyStatsIntegrityCheck | _al aplicar_ | 1 intento fallido | ops + dueño |
| dailyFirestoreBackup sin ejecución exitosa en 26 h | _al aplicar_ | ningún `succeeded` del respaldo en 26 h (schedule pausado, función borrada) | ops + dueño |
| falló la copia externa (proyecto de respaldos) | _al aplicar_ | un mensaje `FAILED`/`ABORTED` del job de Storage Transfer | ops + dueño |
| Presupuesto mensual `farma-jyv` (facturación, no Monitoring) | _al aplicar_ | gasto del mes ≥ 50 %, 90 % y 100 % de US$5 | ops + dueño + admins de facturación |

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

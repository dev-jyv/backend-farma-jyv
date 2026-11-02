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

---

## 8. Liberación (despliegue desde GitHub Actions)

Contrato (SPEC 39): **merge a `main` con CI verde = `farma-jyv-dev`**; **tag
`vX.Y.Z` sobre `main` = candidato a `farma-jyv`**, que sale solo cuando `dev-jyv`
aprueba el environment `production`. El backend y el panel tienen **tags
independientes**: un tag del backend despliega solo el backend y uno del panel
solo el panel.

`deploy.yml` se autentica con **Workload Identity Federation**: ninguna llave JSON
vive en GitHub. Nunca subas una llave de cuenta de servicio como secreto.

### 8.1 Una sola vez por proyecto (dueño de la cuenta)

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
   - `production`: **revisor requerido `dev-jyv`**, reglas de despliegue solo
     tags `v*`. Las mismas dos variables con los valores de `farma-jyv`.
   - Solo backend, en los dos environments: variable `FUNCTIONS_ENV_FILE` con el
     contenido de `functions/.env.<proyecto>` **sin credenciales** (CORS, RECEIPT_*,
     REPORTS_EMAIL_*, R2_ACCOUNT_ID/R2_BUCKET, FIRESTORE_BACKUP_BUCKET…).
     `scripts/ci/write-functions-env.mjs` la escribe en el job y se niega si trae
     cualquiera de las siete credenciales de SPEC 35 (las variables se ven en
     claro) o si el código todavía no las declara con `defineSecret`.
4. Etiqueta `requiere-paso-manual` en ambos repos.

Hasta que SPEC 35 esté en `main`, el job de despliegue falla a propósito en el
paso de variables: el pipeline no maneja credenciales en `.env`. Mientras tanto,
despliegue manual (§8.5).

### 8.2 Etiquetar PRs con pasos manuales

Un PR que exija backfill, `migrate:roles`, crear un secreto u otro paso de este
RUNBOOK antes o después del código lleva la etiqueta **`requiere-paso-manual`**
y una línea en su descripción:

```
Paso manual: RUNBOOK §2b — backfill:search-name antes de desplegar
```

El pipeline **no** ejecuta backfills ni `migrate:roles`. Si la línea falta, el
resumen del run lo marca como "no indicado".

### 8.3 Liberar a producción

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

### 8.4 Panel

`farma-jyv-admin/.github/workflows/deploy.yml` sigue el mismo flujo para Hosting
(`hosting:admin-dev` en dev, `hosting:admin` en prod), con sus propios tags `v*`,
su environment `production` (revisor `dev-jyv`) y su propio resumen de PRs con
`requiere-paso-manual`. No despliega índices: el panel no tiene.

### 8.5 Despliegue manual (GitHub Actions caído o `dev-jyv` no disponible)

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

## 8. Secretos en Secret Manager (SPEC 35)

Las credenciales del backend viven en **Cloud Secret Manager** de cada proyecto,
no en `functions/.env.<proyecto>`. Se declaran una sola vez en
`functions/src/config/secrets.ts` (`defineSecret`) y Firebase las monta como
variables de entorno **al arrancar la instancia**, solo en las funciones que las
declaran. Nada lee Secret Manager por petición.

| Secreto | Proveedor | Montado en | Tiene valor hoy |
|---|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Mercado Pago | `api` | sí |
| `MERCADOPAGO_WEBHOOK_SECRET` | Mercado Pago | `api` | **no**: espacio reservado en blanco |
| `RESEND_API_KEY` | Resend | `api`, `dailySalesReport`, `monthlySalesReport`, `dailyInventoryAlerts`, `dailyPromotionsMaintenance` | sí |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 | `api` | sí |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 | `api` | sí |
| `MIGRATE_SECRET` | propio (aleatorio) | `api` | sí |
| `OPENROUTER_API_KEY` | OpenRouter | `api` | sí |

`dailyFirestoreBackup` y `dailyStatsIntegrityCheck` no montan ninguno. Lo no
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
  al vuelo; no escribas valores ahí: cancela y sigue §8.1. A mano:
  `npm --prefix functions run check:secrets -- dev`.

Permisos de quien opera: `roles/secretmanager.admin` para crear y rotar (o
`roles/secretmanager.secretVersionManager` si el secreto ya existe);
`roles/secretmanager.viewer` basta para `check:secrets` (solo metadatos).
`roles/secretmanager.secretAccessor` (leer valores) solo a la cuenta de servicio
de las funciones y, puntualmente, a quien corra `migrate:roles` remoto.

### 8.1 Crear (por proyecto: primero `farma-jyv-dev`, luego `farma-jyv`)

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

### 8.2 Dar acceso

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

### 8.3 Rotar — en este orden, por proyecto y por secreto

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

### 8.4 Migración inicial desde `.env` (una vez por proyecto: dev, después prod)

Los valores que vivieron en `.env` viajaron en paquetes desplegados: **se rotan**,
no se copian.

1. Crear los siete secretos con valores **nuevos** (§8.1 y pasos 1–2 de §8.3).
2. Borrar las siete líneas de `functions/.env.<proyecto>` (y de `functions/.env`
   si las hubiera). `check-env-split` no deja desplegar mientras sigan ahí.
3. `npm --prefix functions run deploy:<dev|prod>` (corre los dos chequeos).
4. Verificar: venta con tarjeta / orden Point, correo de reporte manual, subida a
   `facturas/`, consulta al asistente, `migrate-roles` con el secreto nuevo.
5. Revocar en cada proveedor los valores viejos y comprobar que fallan (p. ej.
   `migrate-roles` con el `MIGRATE_SECRET` viejo responde 403).
6. Pedir a todos los que tengan `functions/.env.farma-jyv` /
   `.env.farma-jyv-dev` locales que borren de ahí los valores viejos.

### 8.5 Local (emulador y `npm run dev`)

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

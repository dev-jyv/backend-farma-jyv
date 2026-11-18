# Ambientes de FarmaJyV

Dos ambientes, los mismos en los cuatro repos (backend, admin, clinic, pos):

| Ambiente | Proyecto Firebase | API | Para qué |
|---|---|---|---|
| **emulator** | `demo-farmajyv` | `http://127.0.0.1:5001/demo-farmajyv/us-central1/api/v1` | Desarrollo diario. Todo local, datos ficticios. |
| **prod** | `farma-jyv` | la actual | Farmacia real. |

El prefijo `demo-` no es casual: Firebase garantiza que un proyecto `demo-*` no
existe en la nube, así que el emulador no puede escribir en nada real aunque
alguien se equivoque de credenciales.

`.firebaserc` de cada repo conserva `default: farma-jyv` y añade el alias `prod`.
**Todo deploy pasa `--project` explícito** (`deploy:prod`).

**Ya no hay ambiente dev en la nube.** El proyecto `farma-jyv-dev` (Functions,
Firestore, Auth, Storage, Hosting `farma-jyv-dev`, `-clinic` y `-updates`) se
borró el 2026-11-18 por costo; se puede restaurar con `gcloud projects undelete
farma-jyv-dev` hasta el 2026-12-18 y después desaparece, y su id no se puede
volver a usar. Lo que se probaba ahí se prueba con los emuladores; la integración
en la nube es la liberación a producción (RUNBOOK §10).

## Desarrollo local (emuladores)

Requisitos: Node 22, Java 21 (los emuladores de Firestore/Storage corren en la
JVM) y `firebase-tools` instalado.

```bash
# 1. Una sola vez: variables del emulador (sin secretos reales)
cp functions/.env.local.example functions/.env.local

# 2. Todo el ecosistema (emuladores + build:watch + admin + clinic + pos)
npm run dev:all                  # desde la raíz de backend-farma-jyv
npm run dev:all -- --electron    # además abre Electron del POS

# 3. Con los emuladores arriba, en otra terminal: datos de prueba
npm run seed:emulator
```

| Servicio | URL |
|---|---|
| UI de emuladores | http://localhost:4000 |
| Admin | http://localhost:4200 |
| Consultorio | http://localhost:4300 |
| POS (renderer) | http://localhost:4400 |

Usuarios del seed (contraseña `Farmacia123!`): `admin@`, `gerente@`, `cajero@`,
`doctor@` y `contador@farmajyv.test` (rol `accountant`, con el correo mensual activado). El seed también crea categoría, proveedor, tres productos
con lote (uno de grupo II) y un paciente. Es idempotente.

Los datos del emulador se guardan en `.emulator-data/` al salir (Ctrl+C) y se
recargan al volver a arrancar. Para empezar de cero, borra esa carpeta.

Cada front por separado: `npm start` en su repo ya apunta al emulador.

## Secretos: Secret Manager, no `.env` (SPEC 35)

Las siete credenciales del backend viven en **Cloud Secret Manager** de cada
proyecto y se declaran una sola vez en `functions/src/config/secrets.ts`
(`defineSecret`). Firebase las monta como variables de entorno solo en las
funciones que las declaran: `api` las siete y las programadas que mandan correo
solo `RESEND_API_KEY`. Crear, rotar y dar acceso: RUNBOOK, sección «Secretos».

| Secreto | Lo usa |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | `api` (Point, Checkout Pro, reembolsos) |
| `MERCADOPAGO_WEBHOOK_SECRET` | `api` (firma del webhook; hoy espacio reservado en blanco) |
| `RESEND_API_KEY` | `api` (disparo manual) y los cuatro correos programados |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | `api` (facturas en R2) |
| `MIGRATE_SECRET` | `api` (`/v1/internal/*`) |
| `OPENROUTER_API_KEY` | `api` (asistente, facturas-RAG) |

Los `.env` quedan **solo** con configuración no secreta (`CORS_ORIGINS`,
`RECEIPT_*`, `REPORTS_EMAIL_*`, `R2_ACCOUNT_ID`, `R2_BUCKET`, modelos de
OpenRouter, `MERCADOPAGO_USER_ID`…). Firebase carga `functions/.env` en **todos**
los proyectos y en el emulador, y después el específico (`.env.farma-jyv` o
`.env.local`).

| Archivo | Uso | ¿Se versiona? | ¿Se despliega? |
|---|---|---|---|
| `functions/.env` | valores comunes, sin secretos ni `MERCADOPAGO_*` | no | sí |
| `functions/.env.farma-jyv` | config de producción, **sin secretos** | no | sí |
| `functions/.env.local` | emulador y `npm run dev` | no | no |
| `functions/.secret.local` | valores de los secretos en emulador y `npm run dev` | no | no |
| `functions/*.example` | plantillas | sí | — |

`scripts/check-env-split.mjs` corre antes de `emulators` y `deploy:prod`. Falla si alguno de los siete aparece (aunque sea vacío) en
`functions/.env` o en un `functions/.env.<proyecto|alias>`, o si `functions/.env`
trae alguna `MERCADOPAGO_*` con valor, y lista **solo los nombres**. Para migrar:
borra esas líneas (y los valores viejos, que se rotan; RUNBOOK «Secretos»).
`scripts/check-secrets.mjs prod` corre en los `deploy:*` después de compilar
y antes de `firebase deploy`: si un secreto no existe en el proyecto destino, el
deploy se detiene nombrándolo en lugar de pedir el valor a mano.

**Emulador.** `npm run emulators` completa `functions/.secret.local` con una
línea por secreto (`scripts/ensure-secret-local.mjs`): copia el valor de
`.env.local` si lo había ahí (p. ej. `MIGRATE_SECRET=local-dev-secret`) y si no
escribe `" "`, que el emulador toma por valor —así no sale a buscarlo a Secret
Manager— y el backend trata como "no configurado". Lo que ya pusiste a mano no se
toca. Plantilla: `functions/.secret.local.example`.

> `npm run dev` (el dev-server de Express) **no** usa emuladores: carga
> `functions/.env`, luego `.env.local` y `.secret.local`, y las credenciales de tu
> máquina, es decir, la base de producción. Para desarrollar usa `npm run emulators`.

## POS: datos locales separados

En desarrollo el POS guarda su SQLite y su localStorage en una carpeta por ambiente
(`FarmaJyV Venta (emulator)`, `FarmaJyV Venta (dev)`). La carpeta anterior del
modo dev (`~/Library/Application Support/Electron/`) puede tener datos
sincronizados de producción; ya no se usa y no se borra automáticamente. Los
builds de dev usan otro appId y otro canal de actualizaciones, así que nunca
actualizan una caja de producción. Ver `docs/SETUP.md` del repo del POS.

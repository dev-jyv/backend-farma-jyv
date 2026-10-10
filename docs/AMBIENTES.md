# Ambientes de FarmaJyV

Tres ambientes, los mismos en los cuatro repos (backend, admin, clinic, pos):

| Ambiente | Proyecto Firebase | API | Para qué |
|---|---|---|---|
| **emulator** | `demo-farmajyv` | `http://127.0.0.1:5001/demo-farmajyv/us-central1/api/v1` | Desarrollo diario. Todo local, datos ficticios. |
| **dev** | `farma-jyv-dev` | `https://us-central1-farma-jyv-dev.cloudfunctions.net/api/v1` | Probar integrado en la nube antes de producción. |
| **prod** | `farma-jyv` | la actual | Farmacia real. |

El prefijo `demo-` no es casual: Firebase garantiza que un proyecto `demo-*` no
existe en la nube, así que el emulador no puede escribir en nada real aunque
alguien se equivoque de credenciales.

`.firebaserc` de cada repo conserva `default: farma-jyv` y añade los alias `prod`
y `dev`. **Todo deploy pasa `--project` explícito** (`deploy:dev` / `deploy:prod`).

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

Usuarios del seed (contraseña `Farmacia123!`): `admin@`, `gerente@`, `cajero@` y
`doctor@farmajyv.test`. El seed también crea categoría, proveedor, tres productos
con lote (uno de grupo II) y un paciente. Es idempotente.

Los datos del emulador se guardan en `.emulator-data/` al salir (Ctrl+C) y se
recargan al volver a arrancar. Para empezar de cero, borra esa carpeta.

Cada front por separado: `npm start` en su repo ya apunta al emulador.

## Proyecto `farma-jyv-dev` (nube)

Lo que falta hacer una sola vez (requiere cuenta con permisos en Firebase):

1. Crear el proyecto `farma-jyv-dev` (plan Blaze, para Functions).
2. Habilitar Auth (correo/contraseña), Firestore (us-central1) y Storage.
3. Registrar tres web apps (admin, clinic, pos) y pegar su config en
   `environment.dev-cloud.ts` de cada front (hoy dicen `REEMPLAZAR_CON_CONFIG_DE_farma-jyv-dev`).
4. Crear los sitios de Hosting `farma-jyv-dev`, `farma-jyv-dev-clinic` y `farma-jyv-dev-updates`.
5. `cp functions/.env.farma-jyv-dev.example functions/.env.farma-jyv-dev` y
   rellenar con credenciales de **prueba** (Mercado Pago `TEST-...`, bucket R2 aparte).
6. `npm --prefix functions run deploy:dev`, luego `npm run migrate:roles` contra dev.

## Secretos: por qué `functions/.env` debe quedar sin secretos

Firebase carga `functions/.env` en **todos** los proyectos y en el emulador, y
después el archivo específico (`.env.farma-jyv`, `.env.farma-jyv-dev` o
`.env.local`). Un secreto de producción en `.env` terminaría en dev y en el
emulador (cobros, correos y archivos reales desde tu laptop).

| Archivo | Uso | ¿Se versiona? |
|---|---|---|
| `functions/.env` | solo valores comunes sin secretos | no |
| `functions/.env.farma-jyv` | secretos de producción | no |
| `functions/.env.farma-jyv-dev` | secretos de prueba de dev | no |
| `functions/.env.local` | emulador | no |
| `functions/*.example` | plantillas | sí |

`scripts/check-env-split.mjs` corre antes de `emulators` y de `deploy:dev`. Si
`functions/.env` todavía trae secretos, se niega a arrancar y lista **solo los
nombres** de las variables. Para migrar: mueve esas líneas a
`functions/.env.farma-jyv`. `deploy:prod` las sigue cargando desde ahí.

> `npm run dev` (el dev-server de Express) **no** usa emuladores: carga
> `functions/.env` y las credenciales de tu máquina, es decir, producción. Para
> desarrollar usa `npm run emulators`.

## POS: datos locales separados

En desarrollo el POS guarda su SQLite y su localStorage en una carpeta por ambiente
(`FarmaJyV Venta (emulator)`, `FarmaJyV Venta (dev)`). La carpeta anterior del
modo dev (`~/Library/Application Support/Electron/`) puede tener datos
sincronizados de producción; ya no se usa y no se borra automáticamente. Los
builds de dev usan otro appId y otro canal de actualizaciones, así que nunca
actualizan una caja de producción. Ver `docs/SETUP.md` del repo del POS.

-- SPEC 41 · Peticiones a `api` sin App Check válido, por día y por cliente.
--
-- Consulta de Log Analytics (Logging → Log Analytics). Guardarla con el nombre
-- "SPEC 41 · App Check sin token por día" y compartirla con el proyecto; el
-- enlace va en RUNBOOK.md §13. Para dev, cambiar `farma-jyv` por `farma-jyv-dev`.
--
-- La fuente es el log `Petición sin App Check válido` que escribe AppCheckGuard
-- (functions/src/modules/identity/guards/app-check.guard.ts) con severidad
-- WARNING: `appCheck` (missing | invalid), `path`, `method`, `uid`, `userAgent`,
-- `client` (pos | navegador | script | sin-user-agent, derivado del User-Agent),
-- `origin` y `status`.
--
-- `cliente` separa la caja (Electron, siempre `missing` porque no manda App
-- Check) del panel; `origen` separa el panel del front del consultorio, que
-- tampoco lo manda todavía. Un `navegador` con origen del panel y `missing` es lo
-- que hay que mirar: reCAPTCHA bloqueado o un script con User-Agent de navegador.
SELECT
  DATE(timestamp, 'America/Mexico_City') AS dia,
  JSON_VALUE(json_payload.appCheck) AS app_check,
  IFNULL(JSON_VALUE(json_payload.client), '(sin cliente)') AS cliente,
  IFNULL(JSON_VALUE(json_payload.origin), '(sin origin)') AS origen,
  COUNT(*) AS peticiones,
  COUNT(DISTINCT JSON_VALUE(json_payload.uid)) AS usuarios,
  ANY_VALUE(JSON_VALUE(json_payload.userAgent)) AS ejemplo_user_agent
FROM
  `farma-jyv.global._Default._AllLogs`
WHERE
  timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND resource.type = 'cloud_run_revision'
  AND JSON_VALUE(resource.labels.service_name) = 'api'
  AND JSON_VALUE(json_payload.appCheck) IN ('missing', 'invalid')
GROUP BY
  dia, app_check, cliente, origen
ORDER BY
  dia DESC, peticiones DESC

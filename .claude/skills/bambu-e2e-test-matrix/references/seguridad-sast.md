# Referencia: Seguridad SAST (OWASP / CWE / secretos / CVEs)

> Guía técnica de apoyo del skill `bambu-e2e-test-matrix` para el análisis estático de seguridad.
> La usa el subagente `e2e-security-sast`. Solo LECTURA: no modifica código, no aplica
> fixes, no hace explotación activa ni DAST contra producción. Requiere la ruta local del
> repositorio (sin repo, SAST no aplica).

## 1. Código — OWASP Top 10 / CWE Top 25 / secretos
Si `semgrep` está disponible (`which semgrep`):
```
semgrep --config p/owasp-top-ten --config p/cwe-top-25 --config p/secrets \
  --json --output <salida>/seguridad/semgrep-report.json <ruta-repo>
```
- Genera también versión legible: mismo comando sin `--json --output`, guardando stdout en
  `<salida>/seguridad/semgrep-report.txt`.
- Si semgrep no está instalado, repórtalo como limitación y usa grep dirigido a patrones
  comunes (inyección SQL por concatenación, `eval(`, `innerHTML =`, `dangerouslySetInnerHTML`,
  deserialización insegura, `http://` en vez de `https://`, CORS `*`, JWT sin verificar
  expiración/firma, falta de sanitización de inputs) como aproximación mínima, dejando claro
  que es un fallback parcial, no un SAST completo.

## 2. Secretos hardcodeados
- Si `gitleaks` o `trufflehog` están disponibles, úsalos sobre el repo y guarda el reporte en
  `<salida>/seguridad/secrets-report.txt`.
- Si no, usa el ruleset `p/secrets` de semgrep (incluido arriba) y/o grep para patrones
  típicos: `AKIA[0-9A-Z]{16}` (AWS key), `-----BEGIN PRIVATE KEY-----`, `api[_-]?key`,
  `secret`, `password\s*=`, tokens tipo `ghp_`, `sk-`, `xox[baprs]-`.
- Reporta archivo, línea y tipo de secreto **sin exponer el valor completo**: trúncalo
  (ej. `AKIA****...****1234`).

## 3. CVEs en dependencias
- Si `osv-scanner` está disponible:
```
osv-scanner --format json --output <salida>/seguridad/osv-report.json <ruta-repo>
```
- Si el proyecto usa npm/pnpm, complementa con auditoría del gestor:
```
npm audit --json > <salida>/seguridad/npm-audit.json   # o: pnpm audit --json > ...
```
- Si ninguna herramienta está disponible, repórtalo como limitación explícita (no inventes
  CVEs ni versiones).

## 4. Reporte
Genera `<salida>/seguridad/seguridad-reporte.md` con:
- Resumen: total de hallazgos por severidad (Crítica/Alta/Media/Baja) y por categoría
  (OWASP/CWE, Secretos, CVEs de dependencias).
- Tabla: `ID,Categoria,Severidad,Archivo,Linea,Descripcion,CWE/OWASP,Evidencia,Sugerencia`.
- Herramientas realmente usadas vs. no disponibles (deja explícito qué no se cubrió).
- Si se invoca dentro de `bambu-e2e-test-matrix`, añade filas a `matriz-pruebas.csv` con
  `Tipo=Seguridad` para cada hallazgo relevante, referenciando el reporte en `Evidencia`.

## Instalación de herramientas (opcional, macOS)
```
brew install semgrep osv-scanner
```
`npm`/`pnpm` ya vienen con Node y sirven de respaldo para CVEs. Sin estas herramientas, el
resto del skill funciona igual: el agente reporta la limitación en vez de inventar hallazgos.

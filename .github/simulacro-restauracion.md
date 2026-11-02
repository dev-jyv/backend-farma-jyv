Simulacro mensual de restauración de Firestore (SPEC 43). El procedimiento
completo, con los comandos, está en **[RUNBOOK §4 — Respaldo de Firestore]({{RUNBOOK_URL}})**;
este checklist solo sigue su orden. Cierra el issue cuando el resultado quede
anotado en el RUNBOOK.

> El export contiene `patients` y `medicalRecords` (NOM-004). El único destino
> permitido es el **proyecto aislado de respaldos**: nunca `farma-jyv` ni
> `farma-jyv-dev`.

### Antes de importar

- [ ] La base `(default)` del proyecto de respaldos está **vacía** (un simulacro
      anterior pudo quedarse a medias).
- [ ] La política IAM del proyecto de respaldos solo incluye al dueño de la cuenta
      y a quien ejecuta el simulacro.
- [ ] Identificado el export más reciente **completo** del bucket externo. Si el
      del día falló, se usa el último completo y se anota el hueco.

### Importar y verificar

- [ ] Import del export al proyecto de respaldos, con hora de inicio y fin
      (duración). Un `PERMISSION_DENIED` sobre el bucket se resuelve con solo
      lectura y se anota.
- [ ] Conteos (`count()`) de `sales`, `batches`, `products` y `cashSessions`
      del import contra producción al día del export.
- [ ] Si algún conteo difiere: diferencia registrada y issue abierto **antes** de
      dar el simulacro por bueno.
- [ ] Leída una venta y un corte del día del export, con sus campos completos.

### Cerrar

- [ ] Borrados todos los documentos restaurados (o la base Firestore completa del
      proyecto de respaldos; **nunca** el bucket) y verificado que la base quedó vacía.
- [ ] Anotado en el RUNBOOK: fecha, export usado, duración del import, conteos,
      resultado, que se borró, y el costo si es el primer simulacro.
- [ ] Issue cerrado con el enlace al commit que anota el resultado.

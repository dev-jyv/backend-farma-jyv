# Referencia: Agentic Browser Testing

> Guía técnica de apoyo del skill `bambu-e2e-test-matrix`. Describe el patrón de exploración
> autónoma guiada por objetivos que usa el subagente `e2e-explorer` en la Fase 1. A
> diferencia de un script de pasos fijos, el agente decide en cada paso qué hacer según lo
> que observa (snapshot de accesibilidad), acercándose iterativamente al objetivo.

## 1. Bucle de exploración
1. Toma `browser_snapshot` del estado actual.
2. A partir del objetivo (ej. "completa el flujo de compra", "encuentra todas las
   pantallas accesibles desde el menú principal"), decide la siguiente acción concreta
   (clic, llenar campo, navegar).
3. Ejecuta la acción, vuelve a tomar snapshot, evalúa si avanzaste hacia el objetivo o si
   apareció algo inesperado (error, modal, redirección) que valga la pena anotar.
4. Repite hasta cumplir el objetivo, agotar el alcance definido, o detectar que estás en
   un bucle/callejón sin salida (mismo estado repetido 2 veces seguidas) — en ese caso,
   detente y repórtalo en vez de seguir intentando indefinidamente.

## 2. Qué registrar mientras exploras
- Mapa de pantallas/flujos visitados (nombre, URL/ruta, cómo se llega a ella).
- Reglas de negocio inferidas (validaciones, límites, mensajes condicionales).
- Casos borde encontrados por accidente durante la exploración (no solo los buscados
  deliberadamente): estados vacíos, mensajes de error, límites de campos, comportamiento
  ante datos duplicados/agotados.
- Cualquier cosa que rompa la expectativa razonable de un usuario (usabilidad), aunque no
  sea técnicamente un error.

## 3. Límites (no es pentesting ni carga)
- Es exploración funcional/de usabilidad de solo lectura sobre el flujo normal de la app.
  No es prueba de seguridad activa (para eso existe `e2e-security-sast`, que es estático)
  ni prueba de carga/estrés.
- No completes acciones irreversibles reales (pagos, borrados definitivos) solo por
  explorar; detente en el paso previo a confirmar y anótalo.
- Si necesitas credenciales/datos para avanzar y no los tienes, anótalo como pregunta
  abierta en vez de inventar datos o saltarte el paso.

## 4. Entrega
- Mapa de flujo explorado (pantallas + transiciones).
- Lista de casos de prueba candidatos derivados de la exploración, mismo formato CSV que
  usa `bambu-e2e-test-matrix`: `ID,Modulo,Titulo,Tipo,Prioridad,Precondiciones,Pasos,Datos,
  Resultado_esperado,Estado,Evidencia,Notas`.
- Preguntas abiertas / supuestos hechos durante la exploración.
- Resumen compacto al orquestador; no vuelques snapshots completos de accesibilidad.

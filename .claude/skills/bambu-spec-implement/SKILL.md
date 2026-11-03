---
name: bambu-spec-implement
description: Ejecuta la implementación de un feature cuyo spec (`SPEC NN`) ya está en estado Approved, consumiéndolo como el contrato completo — contexto, goals, non-goals, requisitos funcionales, interfaces y contratos, edge cases, criterios de aceptación — sin reinterpretar ni improvisar nada que el spec ya decidió. Usa este skill cuando el usuario pida "implementa el SPEC 04", "build SPEC 04", "empecemos a programar el spec de...", "implementemos lo que dice el spec...", "¿ya podemos hacer el SPEC 03?", o cuando haya un spec Approved listo para ejecutar. Se niega a arrancar si el spec referenciado no está en Approved (Draft, In review u Obsolete) o si alguna de sus dependencias (`Depends on:`) tampoco lo está — en ese caso reporta qué falta y remite a **bambu-spec-define** para resolverlo primero, nunca procede con la mejor intención. Al terminar, marca el spec como Implemented con una referencia a PR/commit y nunca reescribe sus secciones sustantivas.
---

# Spec-driven design — implementación rápida

> "That is why this flow is deliberately slow during the definition phase and fast during the writing phase."

Este skill es la mitad **rápida** del flujo. La mitad lenta —producir y aprobar el contrato— es **bambu-spec-define**. Este skill no debate el diseño: lo ejecuta. Si algo en el spec sigue siendo ambiguo a pesar de estar Approved, eso es una falla de proceso, no una invitación a improvisar — se detiene y pregunta.

## Cuándo usar este skill

- "Implementa el SPEC 04", "build SPEC 04", "ship SPEC 04".
- "Empecemos a programar el spec del reintento de pagos."
- "¿Ya podemos hacer el SPEC 03?"
- Hay un spec Approved y el siguiente paso obvio es ejecutarlo.

No lo uses para decidir o modificar el contenido de un spec — eso es `bambu-spec-define`. No lo uses contra un spec que todavía esté Draft o In review, aunque "se vea casi listo": el gate de Approved existe precisamente para que esa decisión no quede a criterio de quien va a programar.

## Flujo de trabajo

### Paso 0 — Localizar el spec

```bash
test -d docs/specs && echo docs/specs || echo specs
```

Busca `<specs-dir>/SPEC-NN-*.md` por número o por título mencionado. Si el usuario no especificó cuál, pregunta — no asumas "el más reciente".

### Paso 1 — Verificar la precondición de Approved

Lee la línea `> **Status:**` del spec.

- Si **no** dice `Approved` (es Draft, In review, u Obsolete), **niégate a continuar**. Reporta el Status actual y qué falta para llegar a Approved (secciones incompletas, Open Questions pendientes, dependencias no aprobadas) y remite explícitamente a `bambu-spec-define` para resolverlo.
- Si dice Approved, revisa también cada entrada de `Depends on:`: cada spec referenciado debe estar, a su vez, Approved o Implemented. Si alguno no lo está, niégate igual — no confíes en que la validación de Approval ya lo garantizó, vuelve a chequearlo tú mismo.

### Paso 2 — Leer el contrato completo

Trata cada sección MANDATORY como la fuente de verdad, no como contexto ambiental:

- **Interfaces & contracts** — las firmas/esquemas exactos a implementar, sin margen de interpretación.
- **Functional requirements** — el comportamiento a cubrir, uno por uno.
- **Edge cases** — cada uno necesita su propio manejo explícito en el código, no un "ya debería estar cubierto".
- **Acceptance criteria** — el checklist contra el que vas a verificar al final.
- **Non-goals** — lo que NO debes construir, aunque parezca una mejora obvia mientras programas.

Si, leyendo el spec Approved, encuentras una ambigüedad real (algo que dos personas razonables implementarían distinto), **detente y pregunta al usuario** en vez de decidir por tu cuenta — improvisar aquí rompe la premisa completa del flujo. No es un fallo tuyo: es el spec el que debió haberlo cubierto, y vale la pena señalarlo.

### Paso 3 — Implementar

Ejecuta rápido: sigue las convenciones normales del repo de destino (y cualquier otro skill de ese repo — p. ej. `bambu-nest-rules`/`bambu-nest-test` si aplica) para el *cómo* del código; el spec ya resolvió el *qué*. No reabras decisiones de diseño que el spec ya tomó.

### Paso 4 — Verificar contra Acceptance Criteria

Recorre cada ítem `- [ ]` de `## Acceptance criteria` y confirma que el código lo satisface (con tests que lo demuestren cuando aplique). No reportes terminado si algún criterio queda sin cubrir — repórtalo como pendiente explícitamente.

### Paso 5 — Cerrar el handoff

Lo único que este skill escribe de vuelta en el archivo del spec:

- Cambia `> **Status:** Approved` → `> **Status:** Implemented`.
- Agrega una referencia de una línea (PR o commit), por ejemplo: `> **Status:** Implemented — PR #123`.

Nada más del archivo se toca. Si durante la implementación encontraste un hueco real en el spec, repórtalo al usuario y sugiere un spec nuevo que lo cubra — no edites las secciones sustantivas del que ya está Approved/Implemented.

## Reglas duras

- **Nunca** empieces a programar contra un spec cuyo Status no sea Approved.
- **Nunca** confíes ciegamente en que las dependencias (`Depends on:`) ya fueron validadas — vuelve a comprobarlo antes de arrancar.
- **Nunca** reinterpretes un Non-goal como alcance implícito porque "de todos modos ya estás ahí".
- **Nunca** edites las secciones sustantivas (Context, Goals, Non-goals, Functional requirements, Interfaces & contracts, Edge cases, Acceptance criteria) de un spec Approved o Implemented — si falta algo, repórtalo y propone un spec nuevo.
- **Nunca** improvises ante una ambigüedad real del spec — detente y pregunta.
- **Nunca** borres ni reescribas la línea de Status de un modo distinto al cambio mecánico Approved → Implemented.

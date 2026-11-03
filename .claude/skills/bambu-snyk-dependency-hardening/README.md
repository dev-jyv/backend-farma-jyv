# Cómo funciona esta skill

`SKILL.md` es el **criterio** (el árbol de decisión, el formato de `.snyk`,
la tabla de expiración por severidad) y es **portable**: no tiene nada atado
a un proyecto o stack en particular, se puede copiar tal cual a otro repo que
use Snyk (o una herramienta de SCA equivalente). Este archivo explica **cómo
se dispara**.

## Dos formas de activarla

### 1. Automática (la normal)

No hace falta invocarla a mano. Claude la carga solo cuando el contexto de la
conversación calza con su `description` — por ejemplo:

> "el check de Snyk de este PR está en rojo, ayúdame a resolverlo"

> "revisa si las excepciones del `.snyk` siguen vigentes"

> "¿qué hacemos con esta vulnerabilidad que no tiene fix?"

Cualquiera de estas frases es suficiente: Claude reconoce que es un problema
de vulnerabilidad de dependencias (no de lógica de negocio propia) y carga la
skill antes de decidir qué hacer.

### 2. Explícita

Para forzarla sin esperar a que se infiera del contexto:

```
/bambu-snyk-dependency-hardening
```

Esto vuelca el contenido completo de la skill en la conversación (el árbol de
decisión, el formato exacto de `.snyk`, y la política 7 días High/Critical ·
30 días Medium/Low), para que tú mismo la sigas o se la señales a Claude
explícitamente antes de pedir algo.

## Ejemplo de flujo completo

```
Tú:  "revisa si las excepciones del .snyk siguen vigentes"

Claude:
  → Carga bambu-snyk-dependency-hardening
  → Corre el escaneo o lee el .snyk actual
  → Por cada entrada: ¿ya hay fix upstream? ¿sigue no-explotable
    el call site real? ¿expiró?
  → Reporta en tabla: paquete | CVE | severidad | decisión | detalle
  → Te entrega el resultado — sin commitear ni pushear nada
```

## Qué NO hace esta skill

- No corre el escaneo por ti — eso vive en el workflow de CI del proyecto.
- No decide sola cuándo bajar el umbral de severidad — nunca lo hace, es una
  regla dura.
- No commitea ni pushea. Deja el working tree listo para que lo revises.

## Portabilidad

Si copias esta skill a otro proyecto, lo único que puede cambiar es **cómo**
se corre el escaneo (el comando exacto, si usa Snyk u otra herramienta de
SCA) y **quién** es el owner de seguridad en el `CODEOWNERS` de ese repo — el
árbol de decisión, el formato de la entrada de ignore y la política de
expiración se quedan igual. El conocimiento específico de un proyecto en
particular (qué paquetes se ignoraron y por qué, decisiones ya tomadas) no
vive aquí — vive en la memoria de quien hace el trabajo en ese proyecto, para
no mezclar criterio portable con historial de un repo.

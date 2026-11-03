# Gobernanza en GitHub: CODEOWNERS, permisos de team y PRs viejos

Todo lo de este documento son acciones sobre configuración **compartida** del repo/org. Ninguna se ejecuta sin confirmación explícita del usuario, sin importar si ya se hizo igual en otro repo minutos antes.

## 1. El team de CODEOWNERS necesita acceso *de escritura* al repo

`CODEOWNERS` no funciona por el solo hecho de listar un team — GitHub valida (silenciosamente, sin error visible en el archivo) que ese team tenga acceso al repo:

```bash
gh api orgs/<org>/teams/<team-slug>/repos --jq '.[].full_name'
```

Si el repo no aparece en la lista, la regla de `CODEOWNERS` para ese path queda inválida: no se le pide review a nadie, y no hay ningún indicador visible de que está rota.

**Permiso mínimo real: `push` (write), no `pull` (read).** Documentación de GitHub: un team debe tener acceso de escritura para ser code owner, *incluso si todos sus miembros ya tienen acceso individual por otra vía*. Con `pull` el archivo "parece" válido pero no dispara la asignación automática de reviewer.

```bash
# dar acceso si no lo tiene
gh api -X PUT orgs/<org>/teams/<team-slug>/repos/<owner>/<repo> -f permission=push

# verificar
gh api orgs/<org>/teams/<team-slug>/repos --jq '.[] | select(.full_name=="<owner>/<repo>") | .permissions'
```

Confirma con el usuario antes de subir el permiso de un team existente — es un cambio de acceso real, no cosmético.

## 2. CODEOWNERS no se aplica retroactivamente

Si el permiso del team se corrige **después** de que un PR ya estaba abierto, GitHub no recalcula los reviewers de ese PR ya existente. Para ese PR puntual, agrega el team manualmente:

```bash
gh api repos/<owner>/<repo>/pulls/<number>/requested_reviewers -f "team_reviewers[]=<team-slug>"
```

Los PRs que se abran después de tener el permiso correcto sí se resuelven solos.

## 3. Un PR abierto antes de mergear el workflow no lo ve

Para el evento `pull_request`, GitHub usa la definición del workflow **tal como existe en el head del PR**, no en la rama base. Si `security.yml` se mergeó a `develop` después de que una rama de feature ya existía, esa rama no tiene el archivo — el check simplemente no aparece, sin error.

Para forzarlo sin tocar el checkout local del usuario, usar el equivalente del botón "Update branch" de la UI:

```bash
gh api -X PUT repos/<owner>/<repo>/pulls/<number>/update-branch
```

Esto trae los commits nuevos de la base (incluido el workflow) al head del PR, lo cual cuenta como un evento `synchronize` y dispara el check. Verifica antes con:

```bash
git merge-base --is-ancestor origin/<base> origin/<head-branch> && echo "ya tiene la base" || echo "le falta actualizarse"
```

## 4. Branch protection queda fuera de este skill

Aun con el workflow, el `SNYK_TOKEN` y el `CODEOWNERS` bien configurados, nada de esto **bloquea** un merge por sí solo. Eso requiere branch protection (o un ruleset) en la rama, con al menos:

- "Require status checks to pass before merging" → con el check `Snyk dependency scan` marcado como requerido.
- "Require review from Code Owners" → para que la línea de `/.snyk` en `CODEOWNERS` bloquee de verdad, no solo asigne reviewer.

Configurar branch protection requiere permisos de admin sobre el repo y es una decisión de gobernanza del equipo — nunca la actives sin que el usuario lo pida explícitamente. Siempre repórtalo como pendiente si no está ya configurado:

```bash
gh api repos/<owner>/<repo>/branches/<branch>/protection
# 404 "Branch not protected" => nada de lo anterior bloquea todavía, son solo indicadores visuales
```

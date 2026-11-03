#!/usr/bin/env bash
# Detección de cómo levantar el proyecto para E2E, agnóstica de framework por diseño.
# Uso: detect-framework.sh [ruta-del-proyecto]   (default: directorio actual)
#
# La señal principal es universal: lo que el propio package.json ya declara en
# "scripts" (dev/start/serve) — eso funciona igual sin importar el framework.
# La detección de framework solo sirve para dos cosas puntuales que SÍ varían:
# una advertencia a aplicar sobre ese comando (Next.js, Angular) y el veredicto
# de si Component Testing es viable. Ver references/framework-detection.md.

set -euo pipefail

PROJECT_DIR="${1:-.}"
PACKAGE_JSON="$PROJECT_DIR/package.json"

if [ ! -f "$PACKAGE_JSON" ]; then
  echo "framework=desconocido"
  echo "razon=no se encontró package.json en $PROJECT_DIR"
  exit 0
fi

has_dep() {
  # $1 = nombre del paquete a buscar en dependencies o devDependencies
  if command -v node >/dev/null 2>&1; then
    node -e "
      const pkg = require('$PACKAGE_JSON');
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      process.exit(deps['$1'] ? 0 : 1);
    " 2>/dev/null
  else
    grep -q "\"$1\"" "$PACKAGE_JSON"
  fi
}

get_script() {
  # $1 = nombre del script en package.json "scripts". Vacío si no existe.
  if command -v node >/dev/null 2>&1; then
    node -e "
      const pkg = require('$PACKAGE_JSON');
      process.stdout.write((pkg.scripts && pkg.scripts['$1']) || '');
    " 2>/dev/null
  fi
}

file_exists_any() {
  # $1 = patrón glob relativo a PROJECT_DIR
  compgen -G "$PROJECT_DIR/$1" >/dev/null 2>&1
}

PKG_MANAGER="npm"
if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ]; then
  PKG_MANAGER="pnpm"
elif [ -f "$PROJECT_DIR/yarn.lock" ]; then
  PKG_MANAGER="yarn"
elif [ -f "$PROJECT_DIR/bun.lock" ] || [ -f "$PROJECT_DIR/bun.lockb" ]; then
  PKG_MANAGER="bun"
fi

# --- Framework: identidad primero. No decide el comando, pero sí en qué orden
# buscar el script declarado — "start" en Next.js casi siempre es el servidor
# de producción (lo que queremos para E2E), mientras que en todo lo demás
# "dev" es la convención del servidor de desarrollo local.
FRAMEWORK="desconocido"
if [ -f "$PROJECT_DIR/angular.json" ]; then
  FRAMEWORK="angular"
elif file_exists_any "next.config.*"; then
  FRAMEWORK="nextjs"
elif has_dep "nuxt" || file_exists_any "nuxt.config.*"; then
  FRAMEWORK="nuxt"
elif has_dep "vue"; then
  FRAMEWORK="vue"
elif has_dep "react"; then
  FRAMEWORK="react"
elif file_exists_any "svelte.config.*"; then
  FRAMEWORK="svelte"
fi

if [ "$FRAMEWORK" = "nextjs" ]; then
  SCRIPT_PRIORITY="start dev serve"
else
  SCRIPT_PRIORITY="dev start serve"
fi

# --- Señal universal: el script que el proyecto ya declara para levantarse ---
DECLARED_SCRIPT_NAME=""
DECLARED_SCRIPT_VALUE=""
for name in $SCRIPT_PRIORITY; do
  value="$(get_script "$name")"
  if [ -n "$value" ]; then
    DECLARED_SCRIPT_NAME="$name"
    DECLARED_SCRIPT_VALUE="$value"
    break
  fi
done

if [ -n "$DECLARED_SCRIPT_NAME" ]; then
  DEV_COMMAND="$PKG_MANAGER run $DECLARED_SCRIPT_NAME  (= $DECLARED_SCRIPT_VALUE)"
else
  DEV_COMMAND=""
fi

# --- El matiz puntual por framework (CT y advertencias), no el comando en sí ---
CT_VERDICT=""
CAVEAT=""

case "$FRAMEWORK" in
  angular)
    CT_VERDICT="no viable — sin gallery oficial ni comunitaria vigente para Angular"
    CAVEAT="Si el comando no trae ya --no-live-reload, agrégalo: evita que el HMR recargue la página a mitad de un test."
    [ -z "$DEV_COMMAND" ] && DEV_COMMAND="ng serve --no-live-reload"
    ;;
  nextjs)
    CT_VERDICT="solo client components, vía gallery Vite aparte — fuera de alcance de esta skill"
    CAVEAT="Para E2E, preferir build de producción (next build && next start) sobre 'next dev': evita el fast refresh a mitad de un test. Si el script 'start' ya corre 'next start', úsalo tal cual; si no, corre 'next build' antes."
    [ -z "$DEV_COMMAND" ] && DEV_COMMAND="next build && next start"
    ;;
  nuxt)
    CT_VERDICT="viable vía gallery Vite — fuera de alcance de esta skill; remitir al skill oficial de Microsoft si se pide explícitamente"
    [ -z "$DEV_COMMAND" ] && DEV_COMMAND="nuxt dev"
    ;;
  vue)
    CT_VERDICT="viable vía gallery Vite — fuera de alcance de esta skill"
    [ -z "$DEV_COMMAND" ] && DEV_COMMAND="vite"
    ;;
  react)
    CT_VERDICT="viable vía gallery Vite — fuera de alcance de esta skill"
    [ -z "$DEV_COMMAND" ] && DEV_COMMAND="vite"
    ;;
  svelte)
    CT_VERDICT="sin confirmar — framework no cubierto en profundidad por esta skill todavía"
    [ -z "$DEV_COMMAND" ] && DEV_COMMAND="vite"
    ;;
esac

if [ -z "$DEV_COMMAND" ]; then
  DEV_COMMAND="desconocido — pregúntale al usuario el comando y el puerto"
fi

PLAYWRIGHT_INSTALADO="no"
if has_dep "@playwright/test"; then
  PLAYWRIGHT_INSTALADO="si"
fi

EXISTING_E2E="no"
for dir in e2e cypress tests/e2e; do
  if [ -d "$PROJECT_DIR/$dir" ]; then
    EXISTING_E2E="si ($dir/)"
    break
  fi
done

echo "framework=$FRAMEWORK"
echo "dev_command=$DEV_COMMAND"
echo "component_testing=$CT_VERDICT"
echo "advertencia=$CAVEAT"
echo "gestor_paquetes=$PKG_MANAGER"
echo "playwright_instalado=$PLAYWRIGHT_INSTALADO"
echo "suite_e2e_existente=$EXISTING_E2E"

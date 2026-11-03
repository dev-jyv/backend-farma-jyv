#!/usr/bin/env bash
# Funciones comunes de los scripts de operación en bash.
#
# Regla: **en seco por defecto**. Sin --apply cada comando se imprime y no se
# ejecuta; con --apply se ejecuta. Las lecturas que un paso necesita para
# decidir (¿ya existe?) solo corren con --apply.
set -euo pipefail

APPLY=0
for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'; exit 0 ;;
    esac
done

PROTECTED_PROJECTS=("farma-jyv" "farma-jyv-dev")

die() { echo "✗ $*" >&2; exit 1; }

need() {
    local name="$1"
    [[ -n "${!name:-}" ]] || die "Falta la variable ${name} (ver encabezado de $(basename "$0"))"
}

assert_not_protected() {
    local project="$1" protected
    for protected in "${PROTECTED_PROJECTS[@]}"; do
        [[ "$project" != "$protected" ]] || die "${project} no puede usarse aquí: debe ser el proyecto aislado de respaldos"
    done
}

# Imprime (en seco) o ejecuta un comando.
run() {
    if [[ "$APPLY" == 1 ]]; then
        printf '$'; printf ' %q' "$@"; printf '\n'
        "$@"
    else
        printf '[en seco]'; printf ' %q' "$@"; printf '\n'
    fi
}

# ¿Existe el recurso? Solo pregunta con --apply; en seco responde "no" para
# imprimir el plan completo.
exists() {
    [[ "$APPLY" == 1 ]] || return 1
    "$@" >/dev/null 2>&1
}

banner() {
    if [[ "$APPLY" == 1 ]]; then echo "== Aplicando: $*"; else echo "== En seco (usa --apply): $*"; fi
}

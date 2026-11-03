#!/usr/bin/env bash
# Corre los pre-chequeos de la política y abre el PR (en borrador por defecto).
# Uso: create-pr.sh --base <rama-base> --title "<titulo>" --body-file <archivo> [--label major|minor|patch] [--ready]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

base=""
label=""
title=""
body_file=""
ready=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --title) title="$2"; shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    --ready) ready=1; shift ;;
    *) echo "Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$base" || -z "$title" || -z "$body_file" ]]; then
  echo "Uso: $0 --base <rama-base> --title \"<titulo>\" --body-file <archivo> [--label major|minor|patch] [--ready]" >&2
  exit 2
fi

head="$(git branch --show-current)"
if [[ -z "$head" ]]; then
  echo "ERROR: no se pudo determinar la rama actual (¿detached HEAD?)." >&2
  exit 1
fi

echo "== Pre-chequeos de la política =="

# 0. Nombre de rama (solo si no es una rama permanente — dev/qa/main no siguen esta convención)
if [[ "$head" != "dev" && "$head" != "qa" && "$head" != "main" ]]; then
  if ! "$SCRIPT_DIR/validate-branch-name.sh" "$head"; then
    echo "ADVERTENCIA: corrige el nombre de la rama antes de continuar (ver arriba)." >&2
  fi
fi

# 1. PRs abiertos del developer (incluye borradores: es el escenario más estricto)
author="$(gh api user --jq .login)"
open_count="$(gh pr list --author "$author" --state open --json number --jq 'length')"
echo "PRs abiertos de $author (incl. borradores): $open_count"
if [[ "$open_count" -ge 3 ]]; then
  echo "ADVERTENCIA: ya tienes $open_count PRs abiertos (límite: 3). Cierra o fusiona alguno antes de abrir otro." >&2
fi

# 2. Tamaño del diff
git fetch origin "$base" --quiet || true
lines_changed="$(git diff --numstat "origin/${base}...HEAD" 2>/dev/null | awk '{add+=$1; del+=$2} END{print add+del+0}')"
echo "Líneas modificadas vs. origin/$base: ${lines_changed:-0}"
if [[ "${lines_changed:-0}" -ge 4000 ]]; then
  echo "ADVERTENCIA: >= 4000 líneas modificadas — la política pide dividir el PR." >&2
fi

# 3. Archivos > 5 MB (tamaño del blob en HEAD, no del working tree)
big_files=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  size="$(git cat-file -s "HEAD:$f" 2>/dev/null || echo 0)"
  if [[ "$size" -gt 5242880 ]]; then
    big_files+="  - ${f} (${size} bytes)"$'\n'
  fi
done < <(git diff --name-only "origin/${base}...HEAD" 2>/dev/null)
if [[ -n "$big_files" ]]; then
  echo "ADVERTENCIA: archivo(s) > 5 MB en el diff:" >&2
  printf '%s' "$big_files" >&2
fi

# 4. Etiqueta de versión (solo para PRs de promoción)
label_args=()
if [[ -n "$label" ]]; then
  if [[ "$label" != "major" && "$label" != "minor" && "$label" != "patch" ]]; then
    echo "ERROR: --label debe ser major, minor o patch." >&2
    exit 1
  fi
  label_args=(--label "$label")
fi

echo "== Creando PR =="
draft_args=(--draft)
[[ "$ready" -eq 1 ]] && draft_args=()

gh pr create --base "$base" --head "$head" --title "$title" --body-file "$body_file" "${draft_args[@]}" "${label_args[@]}"

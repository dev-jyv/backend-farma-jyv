#!/usr/bin/env bash
# setup.sh — Configura lo que la skill bambu-e2e-test-matrix necesita:
#   1) Registra el Playwright MCP fijado en @0.0.68 con grabación de video (--save-video).
#   2) (Opcional) Instala los 4 subagentes en ~/.claude/agents/ para invocarlos por nombre.
#   3) Reporta las herramientas OPCIONALES de SAST (semgrep, osv-scanner).
#
# Uso:
#   bash scripts/setup.sh              # configura MCP + pregunta si instalar agentes
#   bash scripts/setup.sh --with-agents   # además instala los agentes sin preguntar
#   bash scripts/setup.sh --check      # solo verifica, no cambia nada
#
# Idempotente: puedes correrlo varias veces.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_SRC="$SKILL_DIR/references/agents"
OUTPUT_DIR="${HOME}/qa-e2e-tmp"        # directorio de trabajo temporal del MCP (video crudo)

ok()   { printf "  \033[32m✅\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m⚠️ \033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m❌\033[0m %s\n" "$1"; }

WITH_AGENTS=0; CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --with-agents) WITH_AGENTS=1 ;;
    --check) CHECK_ONLY=1 ;;
  esac
done

echo "== Requisitos =="
command -v node >/dev/null 2>&1 && ok "node $(node -v)" || bad "node NO encontrado (instala Node.js LTS)"
command -v npx  >/dev/null 2>&1 && ok "npx disponible"   || bad "npx NO encontrado (viene con Node.js)"
if command -v claude >/dev/null 2>&1; then ok "CLI 'claude' disponible"; else warn "CLI 'claude' no encontrada: registra el MCP a mano (ver README) o desde Claude Code con /mcp"; fi

if [ "$CHECK_ONLY" -eq 0 ]; then
  echo ""
  echo "== 1) Playwright MCP (@0.0.68 con --save-video) =="
  mkdir -p "$OUTPUT_DIR"
  if command -v claude >/dev/null 2>&1; then
    # Re-registra limpio (evita duplicados si ya existía)
    claude mcp remove playwright >/dev/null 2>&1 || true
    if claude mcp add playwright -- npx @playwright/mcp@0.0.68 --save-video=1280x800 --output-dir "$OUTPUT_DIR"; then
      ok "MCP 'playwright' registrado (@0.0.68, --save-video=1280x800, output-dir=$OUTPUT_DIR)"
    else
      bad "No se pudo registrar el MCP con 'claude mcp add'. Regístralo a mano (ver README)."
    fi
  else
    warn "Sin CLI 'claude'. Registra manualmente:"
    echo "     claude mcp add playwright -- npx @playwright/mcp@0.0.68 --save-video=1280x800 --output-dir \"$OUTPUT_DIR\""
  fi

  echo ""
  echo "== 2) Subagentes en ~/.claude/agents/ (opcional) =="
  DO_AGENTS=$WITH_AGENTS
  if [ "$DO_AGENTS" -eq 0 ]; then
    printf "  ¿Instalar los 4 subagentes a nivel usuario para invocarlos por nombre? [s/N] "
    read -r resp < /dev/tty 2>/dev/null || resp="n"
    case "$resp" in s|S|si|Si|y|Y) DO_AGENTS=1 ;; esac
  fi
  if [ "$DO_AGENTS" -eq 1 ]; then
    mkdir -p "$HOME/.claude/agents"
    if cp "$AGENTS_SRC"/*.md "$HOME/.claude/agents/" 2>/dev/null; then
      ok "Agentes instalados: $(cd "$AGENTS_SRC" && ls *.md | tr '\n' ' ')"
      warn "Reinicia Claude Code para que detecte los agentes nuevos."
    else
      bad "No se pudieron copiar los agentes desde $AGENTS_SRC"
    fi
  else
    ok "Omitido. La skill igual delega leyendo los perfiles de references/agents/ como prompt."
  fi
fi

echo ""
echo "== 3) Herramientas SAST (OPCIONALES) =="
for t in semgrep osv-scanner; do
  command -v "$t" >/dev/null 2>&1 && ok "$t $($t --version 2>/dev/null | head -1)" || warn "$t no instalado (opcional: brew install $t)"
done
for t in npm pnpm; do
  command -v "$t" >/dev/null 2>&1 && ok "$t disponible (respaldo CVEs: $t audit)" || warn "$t no disponible (opcional)"
done

echo ""
echo "Siguiente paso: en Claude Code confirma con /mcp que 'playwright' conecta (aprueba el"
echo "servidor la 1ª vez) y usa /bambu-e2e-test-matrix o 'genera la matriz de pruebas E2E de <URL>'."

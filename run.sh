#!/usr/bin/env bash
# Uruchamia narzędzie do przygotowania datasetu FLUX LoRA.
# Tworzy venv (Python 3.12 przez uv), instaluje zależności i startuje serwer.
set -e
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "Brak 'uv'. Zainstaluj: https://docs.astral.sh/uv/  (lub: pipx install uv)"
  exit 1
fi

# Venv z Pythonem 3.12 (najpewniejsze wheele PyTorch). uv pobierze go w razie potrzeby.
if [ ! -d ".venv" ]; then
  echo ">> Tworzę środowisko (Python 3.12)…"
  uv venv --python 3.12 .venv
fi

echo ">> Instaluję zależności (pierwszy raz może chwilę potrwać)…"
uv pip install -r requirements.txt

# Modele pobierają się do folderu wybranego w aplikacji, nie do cache HF.
# HF_HOME wyeksportowany samodzielnie nadal działa (tylko go tu nie ustawiamy).

# Nowe UI (web/): budowane, gdy brakuje dist albo źródła są nowsze.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Brak 'pnpm' — nowe UI nie zostanie zbudowane (zostaje klasyczne pod /legacy/). Zainstaluj: https://pnpm.io/installation"
elif [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/public web/index.html web/package.json web/pnpm-lock.yaml web/vite.config.ts -newer web/dist/index.html 2>/dev/null)" ]; then
  echo ">> Buduję nowe UI (web/)…"
  # Nieudany build nie blokuje startu serwera (set -e): zostaje poprzedni build albo klasyczne UI.
  (cd web && pnpm install --frozen-lockfile && pnpm build) \
    || echo "!! Budowanie nowego UI nie powiodło się — zostaje poprzedni build (jeśli jest), a bez niego klasyczne UI pod /legacy/."
fi

PORT="${PORT:-8123}"
echo ""
echo ">> Otwórz w przeglądarce:  http://127.0.0.1:${PORT}"
echo ">> Models folder: set it in the app (Settings → Models folder)"
if [ -n "${HF_HOME:-}" ]; then
  echo ">> HF_HOME: ${HF_HOME}"
fi
echo ""
exec .venv/bin/python -m uvicorn backend.server:app --host 127.0.0.1 --port "${PORT}"

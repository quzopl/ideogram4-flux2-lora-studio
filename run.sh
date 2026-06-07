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

# Cache modeli Hugging Face na dysku z miejscem (ext4 — symlinki blobów działają).
# Dysk systemowy "/" jest mały; modele Qwen mają kilka–kilkanaście GB.
export HF_HOME="${HF_HOME:-/mnt/intel/huggingface}"
mkdir -p "$HF_HOME"

PORT="${PORT:-8023}"
echo ""
echo ">> Otwórz w przeglądarce:  http://127.0.0.1:${PORT}"
echo ">> Cache modeli (HF_HOME): ${HF_HOME}"
echo ">> (Pierwsze opisanie pobierze wagi modelu VLM — kilka GB.)"
echo ""
exec .venv/bin/python -m uvicorn backend.server:app --host 127.0.0.1 --port "${PORT}"

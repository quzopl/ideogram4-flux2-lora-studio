# Spec: obsługa Ideogram 4 (opisy + prompty) oraz import HEIC

Data: 2026-06-07

## Cel

Dodać do aplikacji FLUX LoRA prep:

1. **Ideogram 4 jako format opisów datasetu** — obok dotychczasowych opisów
   FLUX.2 (naturalny język) generować opisy w strukturze JSON, na której był
   trenowany Ideogram 4.
2. **Ideogram 4 w Generatorze promptów** — *Rozbuduj*/*Popraw* potrafią
   produkować prompt-JSON Ideogram, a nie tylko prozę FLUX.2.
3. **Import HEIC/HEIF** — możliwość wrzucania (upload + drag&drop) oraz
   wskazywania na dysku zdjęć w formacie HEIC; konwersja na wejściu.

Zakres celowo pragmatyczny: **bez bounding boxów i bez `color_palette`** (oba
opcjonalne w schemacie Ideogram).

## Tło — format Ideogram 4

Ideogram 4 był trenowany na **strukturalnych opisach JSON** (jako string). Schemat
(pola, których używamy):

```json
{
  "high_level_description": "jedno-dwa zdania podsumowania",
  "style_description": {
    "aesthetics": "...",
    "lighting": "...",
    "photo": "...",            // ALBO "art_style" dla ilustracji/3D — dokładnie jedno
    "medium": "..."
  },
  "compositional_deconstruction": {
    "background": "opis tła/otoczenia",
    "elements": [
      {"type": "obj",  "description": "..."},
      {"type": "text", "content": "..."}
    ]
  }
}
```

Zasady krytyczne (z dokumentacji Ideogram):

- **Ścisła kolejność kluczy** — top-level: `high_level_description`,
  `style_description`, `compositional_deconstruction`; w `style_description`:
  `aesthetics`, `lighting`, potem `photo`|`art_style`, potem `medium`.
- **Kompaktowy zapis**: `json.dumps(obj, separators=(",", ":"), ensure_ascii=False)`.
- W `style_description` dokładnie jedno z `photo` / `art_style`.

## Architektura i zmiany

### `backend/prompts.py`

- `get_ideogram_prompt(mode: str) -> str` — instrukcja dla VLM: „opisz obraz i
  zwróć **wyłącznie** jeden obiekt JSON" z trzema polami i pod-strukturą. Dla
  trybu `person` zachowuje regułę pomijania tożsamości (opisuj „the person",
  pozę, ubranie, tło — nie stałe rysy twarzy; trigger wchłania tożsamość).
- `normalize_ideogram(raw: str) -> str` — przyjmuje surowy tekst z modelu i
  zwraca kompaktowy, poprawny JSON-string:
  1. Wyłuskuje fragment od pierwszego `{` do ostatniego `}` i parsuje.
  2. Buduje **nowy** obiekt w ścisłej kolejności kluczy (nie polega na
     kolejności z modelu).
  3. `style_description`: wymusza dokładnie jedno z `photo`/`art_style`
     (domyślnie `photo`, gdy brak/oba), `aesthetics`/`lighting`/`medium` jako
     stringi (puste, jeśli brak).
  4. `elements`: normalizuje do `{"type":"obj","description":...}` lub
     `{"type":"text","content":...}`; pomija bboxy i palety.
  5. Serializuje `separators=(",", ":")`, `ensure_ascii=False`.
  6. **Fallback**: gdy parsowanie się nie powiedzie, zawija surowy tekst w
     minimalny poprawny schemat (`high_level_description` = tekst,
     `compositional_deconstruction.background` = tekst, `elements` = []).
- `inject_trigger_ideogram(json_str: str, trigger: str) -> str` — parsuje JSON,
  ustawia `high_level_description = f"{trigger}, {hld}"`, re-serializuje
  kompaktowo. Gdy wejście nie jest poprawnym JSON — zwraca je bez zmian.
- `build_ideogram_studio_system(action: str, subject: str) -> str` — wariant
  tekstowy (bez obrazu) dla Generatora promptów: *expand* buduje pełny
  prompt-JSON z krótkiego pomysłu, *refine* zamienia istniejący/tagowy prompt na
  poprawny JSON Ideogram. Output: wyłącznie JSON.

### `backend/captioner.py`

- `caption_image(image, mode, style="concise", max_new_tokens=256, fmt="flux")`:
  gdy `fmt == "ideogram"` używa `prompts.get_ideogram_prompt(mode)` i przepuszcza
  wynik przez `prompts.normalize_ideogram(...)`. Styl `concise/detailed` jest dla
  Ideogram ignorowany. Dla `fmt == "flux"` zachowanie bez zmian.
- `generate_text(...)` bez zmian (Generator promptów składa system-prompt po
  stronie serwera i dostaje gotowy JSON; normalizację stosuje serwer).

### `backend/server.py`

- `ProcessRequest`: dodać `caption_format: str = "flux"` (`"flux"` | `"ideogram"`).
- Pętla joba: przekazać `fmt=req.caption_format` do `caption_image`; zapisać w
  każdym rekordzie wyniku `"format": req.caption_format`.
- `PromptRequest`: dodać `caption_format: str = "flux"`. W endpoincie `/api/prompt`
  dla `ideogram` zbudować system przez `build_ideogram_studio_system(...)`,
  wywołać `generate_text`, a wynik przepuścić przez `normalize_ideogram`.
- `_final_caption(req, result)`: gdy `req.prepend_trigger` i jest trigger:
  - `result["format"] == "ideogram"` → `prompts.inject_trigger_ideogram(...)`,
  - w przeciwnym razie dotychczasowe `f"{trigger}, {caption}"`.
- Zapis opisów (wspólny helper używany przez `api_export` **i** `api_zip`):
  - zawsze `base.txt` (dla Ideogram: kompaktowy JSON-string; dla FLUX: tekst),
  - dla `format == "ideogram"` **dodatkowo** `base.json` —
    `json.dumps(obj, indent=2, ensure_ascii=False)` (ładnie sformatowany obiekt).
  - Gdy opis Ideogram nie jest poprawnym JSON (po edycji użytkownika) — zapisać
    tylko `.txt`, pominąć `.json` (nigdy nie tworzyć zepsutego `.json`).
  - W `api_zip` ten sam helper dokłada `base.json` przez `zf.writestr(...)`.

### `backend/image_utils.py` (HEIC)

- Przy imporcie modułu:
  ```python
  try:
      from pillow_heif import register_heif_opener
      register_heif_opener()
  except ImportError:
      pass
  ```
- `SUPPORTED_EXT` += `.heic`, `.heif`. Reszta (`process_image` → `convert("RGB")`
  → zapis PNG/JPG) działa bez zmian; HEIC to wyłącznie format wejściowy.

### `frontend/index.html` + `frontend/app.js`

- **Dataset (zakładka 📸):** dropdown „Format docelowy" (`FLUX.2` / `Ideogram 4`);
  `app.js` dokłada `caption_format` do payloadu `/api/process`.
- **Generator promptów (zakładka ✨):** drugi dropdown „Format docelowy";
  `app.js` dokłada `caption_format` do payloadu `/api/prompt`.
- **Upload:** w `<input type="file">` rozszerzyć `accept` o
  `.heic,.heif,image/heic,image/heif`.
- Live-podgląd triggera pozostaje bez zmian (kosmetyczna nieścisłość dla JSON —
  rzeczywiste wstrzyknięcie i tak robi backend). Znane ograniczenie, akceptowane.

### `requirements.txt`

- Dodać `pillow-heif` (sekcja Image processing).

## Wyjście dla Ideogram

```
dataset/
├── person_0000.png
├── person_0000.txt    # {"high_level_description":"ohwx person ...", ...}
├── person_0000.json   # ładnie sformatowany obiekt (do podglądu)
└── …
```

## Poza zakresem (YAGNI)

- Bounding boxy elementów (0–1000) i `color_palette` (hex) — pominięte.
- Walidacja/edytor JSON w UI poza zwykłym polem tekstowym.
- Konwersja HEIC → trwały plik wejściowy (konwertujemy w locie do RGB).

## Kryteria akceptacji

1. W zakładce 📸 wybór „Ideogram 4" → po przetworzeniu każdy opis to poprawny,
   kompaktowy JSON (sprawdzalny `json.loads`), ze ścisłą kolejnością kluczy.
2. Eksport/ZIP dla Ideogram tworzy parę `*.txt` (JSON-string) **i** `*.json`
   (obiekt); dla FLUX nadal tylko `*.txt`.
3. Trigger trafia do `high_level_description`, nie jest doklejany przed `{`.
4. W zakładce ✨ wybór „Ideogram 4" → *Rozbuduj*/*Popraw* zwracają poprawny JSON.
5. Plik HEIC daje się wrzucić (upload/drag&drop) i wskazać z folderu, po czym jest
   przetwarzany i zapisywany jako PNG/JPG.
6. Niepoprawny JSON z modelu nie wywala pipeline'u (fallback do minimalnego
   schematu).

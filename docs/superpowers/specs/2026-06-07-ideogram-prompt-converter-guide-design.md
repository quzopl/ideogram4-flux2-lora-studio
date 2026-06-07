# Spec: konwerter promptów → Ideogram JSON wg przewodnika

Data: 2026-06-07

Źródło reguł: `~/Pobrane/ideogram4_prompting_guide.md` (przewodnik
przerabiania plain-text promptów na strukturalne captiony JSON Ideogram 4).

## Cel

Ulepszyć **konwerter promptów** (zakładka ✨ Generator promptów, akcje Rozbuduj/
Popraw, format docelowy Ideogram/ai-toolkit) tak, by generowany JSON był zgodny z
pełnym przewodnikiem Ideogram 4 — z bounding boxami, paletą kolorów, rozróżnieniem
foto/nie-foto i właściwą kolejnością kluczy.

**Zakres celowo wąski:** zmiana dotyczy WYŁĄCZNIE Generatora promptów (tekst→JSON).
Opisy datasetu (obraz→JSON, format Ideogram/ai-toolkit) zostają na obecnym lekkim
schemacie (`description`, bez bbox/palety) — bez zmian.

## Pełny schemat docelowy (z przewodnika)

### Foto
```json
{
  "high_level_description": "...",
  "style_description": {
    "aesthetics": "...",
    "lighting": "...",
    "photo": "...",
    "medium": "photograph",
    "color_palette": ["#RRGGBB", "..."]
  },
  "compositional_deconstruction": {
    "background": "...",
    "elements": [
      {"type": "obj", "bbox": [y0, x0, y1, x1], "desc": "...", "color_palette": ["#RRGGBB"]},
      {"type": "text", "bbox": [y0, x0, y1, x1], "text": "DOSŁOWNY NAPIS", "desc": "...", "color_palette": ["#RRGGBB"]}
    ]
  }
}
```

### Nie-foto (malarstwo/ilustracja)
Różnice: zamiast `photo` jest `art_style`, a kolejność w `style_description` to
`aesthetics, lighting, medium, art_style, color_palette` (medium PRZED art_style).

### Twarde reguły
- Dokładnie jedno z `photo` / `art_style`.
- bbox: `[y_min, x_min, y_max, x_max]`, skala 0–1000, origin lewy-górny (y pierwsze).
- Hex tylko WIELKIE `#RRGGBB`; do 16 kolorów w palecie globalnej, do 5 na element.
- Kolejność kluczy elementu: `obj` → `type, bbox, desc, color_palette`;
  `text` → `type, bbox, text, desc, color_palette`.
- Serializacja kompaktowa: `json.dumps(..., separators=(",", ":"), ensure_ascii=False)`.

## Architektura i zmiany

### `backend/prompts.py`

**Nowa instrukcja** `build_ideogram_studio_guide(action: str, subject: str) -> str`
— bogaty system-prompt zawierający reguły przewodnika:
- foto vs nie-foto: dobór `photo`/`art_style`, `medium` i wynikająca kolejność kluczy
  w `style_description`; nigdy oba pola naraz;
- rozbrajanie sprzeczności (np. f/1.4 na całą sylwetkę → f/1.8–2.8; „oil impasto" +
  50mm → wybór jednego trybu i usunięcie sprzecznego słownictwa);
- trzy pola główne; `high_level_description` jako kotwica; `lighting` rozbudowane;
- dekompozycja elementów: czytelny dosłowny napis → `text` (pole `text` = string,
  `desc` = opis), ozdobne/nieczytelne znaki → `obj`; problematyczne obiekty (sztanga,
  broń, dłonie) jako osobne elementy; warstwy atmosfery na duży/pełny bbox;
- bbox `[y,x,y,x]` 0–1000; pierwszy plan nisko (wysokie y), tło wysoko;
- hex WIELKIE, do 16/5 kolorów; paleta z cieniami, światłami i akcentami;
- nacisk na teksturę przy realizmie; powtórzenie kluczowego efektu świetlnego;
- token LoRA zachowany dosłownie, wstawiony na początek `desc` głównego elementu i do
  `high_level_description`; przy konwersji malarstwo→foto usuwamy trigger stylu;
- akcje: `expand` (z krótkiego pomysłu pełny JSON wg schematu), `refine` (uporządkuj
  istniejący/tagowy prompt do JSON wg schematu, zachowując intencję);
- `subject` (auto/person/product/landscape/architecture) jako dodatkowy kontekst
  (reużycie istniejącego `_STUDIO_SUBJECT`);
- output: WYŁĄCZNIE jeden obiekt JSON, bez prozy.

**Nowy normalizator** `normalize_ideogram_guide(raw: str) -> str`:
- wyłuskuje `{...}` i parsuje; przy błędzie → fallback minimalny
  (`high_level_description` = tekst, `compositional_deconstruction.background` = tekst,
  `elements` = []).
- buduje obiekt o ścisłej kolejności top-level: `high_level_description`,
  `style_description`, `compositional_deconstruction`.
- `style_description`: wykrywa foto (jest `photo` lub brak `art_style`) vs nie-foto
  (jest `art_style`). Kolejność:
  - foto: `aesthetics, lighting, photo, medium, color_palette`,
  - nie-foto: `aesthetics, lighting, medium, art_style, color_palette`.
  Klucze tekstowe dołączane, gdy obecne; `color_palette` → lista hex WIELKIMI literami
  (odfiltrowane do poprawnych `#RRGGBB`), pominięta gdy pusta.
- `compositional_deconstruction`: `background` (string), `elements` (lista). Każdy
  element przebudowany w kolejności:
  - `obj`: `type, bbox?, desc, color_palette?`,
  - `text`: `type, bbox?, text, desc, color_palette?`.
  `type` jest rozstrzygający; gdy brak — `text` gdy obecne pole `text`, inaczej `obj`.
  `desc` czytane z `desc` (fallback `description`). `bbox` zachowany tylko gdy lista 4
  liczb (rzutowane na int). `color_palette` → hex WIELKIE, pominięty gdy pusty.
- serializacja: `separators=(",", ":")`, `ensure_ascii=False`.
- Helper `_upper_hex_list(value)` (zwraca listę poprawnych `#RRGGBB` wielkimi literami
  lub None) — testowalny.
- Istniejące `normalize_ideogram` (pragmatyczne, dataset) **bez zmian**.

### `backend/server.py`

- `api_prompt`: gdy `req.caption_format in ("ideogram", "aitoolkit")`:
  - `system = prompts.build_ideogram_studio_guide(req.action, req.subject)`,
  - po `generate_text`/LM Studio: `return {"prompt": prompts.normalize_ideogram_guide(raw)}`.
  - Gałąź FLUX bez zmian. Routing LM Studio/lokalny bez zmian (zmienia się tylko, której
    pary instrukcja+normalizacja użyć dla formatów JSON).

### Frontend

Bez zmian strukturalnych (hint już dynamiczny). Opcjonalnie dopisek w hincie nie jest
wymagany.

## Testy (`tests/test_ideogram.py`)

1. `_upper_hex_list(["#aabbcc", "#FFF", "x", "#001122"])` → `["#AABBCC", "#001122"]`.
2. `normalize_ideogram_guide` foto: wejście z `photo`+`color_palette` → kolejność
   `style_description` = `["aesthetics","lighting","photo","medium","color_palette"]`,
   hex WIELKIE.
3. `normalize_ideogram_guide` nie-foto: wejście z `art_style` → kolejność
   `["aesthetics","lighting","medium","art_style","color_palette"]`.
4. Element `obj` z `description` i `bbox` → klucze `["type","bbox","desc"]` (desc z
   description), bbox zachowany; element `text` z `text`+`desc` → klucze
   `["type","bbox","text","desc"]`.
5. bbox niepoprawny (np. 3 elementy) → pominięty.
6. Niepoprawny JSON → fallback z poprawnym JSON (high_level_description=tekst).
7. `build_ideogram_studio_guide("expand","auto")` zawiera: `bbox`, `color_palette`,
   `art_style`, `desc`, oraz słowo `json`.

## Kryteria akceptacji

1. W Generatorze promptów (format Ideogram/ai-toolkit) Rozbuduj/Popraw zwraca poprawny
   JSON zgodny ze schematem przewodnika (bbox, color_palette, foto/nie-foto, desc/text),
   sprawdzalny `json.loads`, kompaktowy.
2. Kolejność kluczy `style_description` zależy od foto/nie-foto zgodnie z przewodnikiem.
3. Hex w paletach jest WIELKIMI literami; niepoprawne kolory odfiltrowane.
4. Opisy datasetu (Ideogram/ai-toolkit) działają jak dotąd (pragmatyczny schemat,
   bez zmian).
5. Ścieżka FLUX w Generatorze promptów bez zmian.
6. Działa zarówno na silniku lokalnym, jak i przez LM Studio (zmiana jest po stronie
   instrukcji + normalizacji, nie routingu).

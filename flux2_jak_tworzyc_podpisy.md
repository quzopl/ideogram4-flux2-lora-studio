# FLUX.2 — jak tworzyć podpisy (captiony) do treningu LoRA

FLUX.2 wymaga innego podejścia do podpisów niż SDXL czy FLUX.1.

**Powód:** text encoderem FLUX.2 jest duży model językowy (LLM) — Mistral-Small-3.1-24B
w pełnym `flux2`, lub Qwen3 w wariantach Klein — a **nie CLIP/T5**. Model rozumie tekst
semantycznie, jak LLM, a nie dopasowuje luźnych tagów.

---

## Jak FLUX.2 przetwarza Twój podpis

Każdy podpis jest pod spodem opakowywany w szablon czatu z system message:

```
System: "You are an AI that reasons about image descriptions. You give structured
         responses focusing on object relationships, object attribution and actions
         without speculation."
User:   <Twój podpis z pliku .txt>
```

Konsekwencje, które wprost dyktują styl podpisów:

- Model jest nastawiony na **relacje między obiektami, atrybucję cech i akcje — bez spekulacji**.
- Brane są ukryte stany z 3 warstw enkodera (Mistral: 10/20/30, Qwen3: 9/18/27) i sklejane razem.
- Limit długości to **512 tokenów** (dla porównania CLIP to tylko 77) — masz dużo miejsca na opis.

---

## Złota zasada

Pisz **pełnymi, naturalnymi zdaniami**, tak jakbyś opisywał zdjęcie drugiej osobie.
Opisuj: **CO** jest na obrazie, **JAKIE** to jest (cechy), **GDZIE** względem innych obiektów,
**CO ROBI** (akcja). Bez przymiotników oceniających.

---

## Rób tak ✅ vs Unikaj ❌

| Rób tak ✅ | Unikaj ❌ |
|---|---|
| Pełne, naturalne zdania opisujące scenę | Booru-tagi po przecinku (`1girl, red hair, ...`) |
| Relacje przestrzenne: „X stoi po lewej od Y", „na stole leży..." | Listy luźnych słów-kluczy |
| Konkretne cechy: kolor, materiał, liczba, ubranie | Spekulacje/oceny: „piękny", „nastrojowy", „arcydzieło" |
| Akcje i czynności: „kobieta nalewa kawę" | Słowa-zaklęcia w stylu SD („masterpiece, 8k, trending") |
| Dłuższe opisy są OK (do ~512 tokenów) | Sztuczne skracanie do kilku tagów |

---

## Przykłady

### ❌ Źle (styl tagów SDXL / booru)
```
woman, red hair, cafe, coffee, beanie, sitting, masterpiece, best quality, 8k, detailed
```

### ✅ Dobrze (naturalny opis dla FLUX.2)
```
A woman with red hair sits at a small table in a cafe, wearing a grey beanie and a denim
jacket. She holds a white coffee cup in both hands. Behind her, a window shows a blurred
street with people walking past.
```

### ❌ Źle (spekulacja / ocena)
```
a beautiful breathtaking stunning portrait, perfect lighting, amazing mood
```

### ✅ Dobrze (fakty: co, jakie, gdzie, co robi)
```
A close-up portrait of a man with a short beard, looking directly at the camera. He wears
a black t-shirt and stands against a plain white background, lit evenly from the front.
```

---

## Reguła „co opisywać" przy LoRA

Klasyczna zasada nadal obowiązuje — tylko zdaniami zamiast tagów:

- **Postać / osoba:** opisuj to, co **zmienne** (poza, tło, ubranie, ujęcie, oświetlenie),
  a NIE samą tożsamość/twarz. Model przypisze wtedy niezmiennik (wygląd) do triggera.
- **Styl:** opisuj **treść** sceny, ale NIE sam styl — styl „wsiąknie" w LoRA.
- **Obiekt / produkt:** opisuj otoczenie i kontekst, a nie sam obiekt w kółko tak samo.

---

## Ustawienia configu związane z podpisami

```yaml
datasets:
  - folder_path: "/path/to/images/folder"
    caption_ext: "txt"            # podpis = plik .txt o tej samej nazwie co obraz
    caption_dropout_rate: 0.05    # 5% kroków bez podpisu (uczy też uncond) — działa normalnie
    shuffle_tokens: false         # ZOSTAW false! tasowanie po przecinkach niszczy zdania
```

- **`shuffle_tokens: false`** — tasowanie po przecinkach ma sens dla tagów; przy zdaniach
  naturalnych rozbiłoby gramatykę i sens. Zostaw wyłączone.
- **`caption_dropout_rate`** — działa standardowo. Pełny `flux2` jest guidance-distilled
  (brak negative promptu przy próbkowaniu); warianty Klein używają CFG normalnie.

### ⚠️ Trigger word a cache'owanie embeddingów

Gdy włączysz `cache_text_embeddings: true` (zalecane dla VRAM przy Mistral 24B),
embeddingi tekstu liczone są **raz, z góry**, więc automatyczna podmiana `[trigger]` /
`trigger_word` **NIE zadziała**. Masz dwie opcje:

1. **Chcesz trigger word + cache** → wpisz trigger ręcznie w każdym pliku `.txt`
   i zostaw `cache_text_embeddings: true`.
2. **Chcesz automatyczny `trigger_word:`** → ustaw `cache_text_embeddings: false`
   (kosztem VRAM i szybkości).

---

## Podsumowanie w jednym zdaniu

Pisz podpisy jak **krótkie, rzeczowe opisy zdjęcia dla człowieka** — pełne zdania o tym,
co widać, jakie to jest i jak rozmieszczone — a nie jak listę tagów ze Stable Diffusion.

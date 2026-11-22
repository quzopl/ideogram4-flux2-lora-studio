# Prompt studio view inventory (legacy UI -> React port)

Sources: `frontend/index.html` (IDX), `frontend/app.js` (APP), `frontend/studio_extras.js` (EXT), `frontend/bbox_editor.js` (BBX), `frontend/style.css` (CSS), `backend/server.py` (SRV), `backend/prompts.py` (PR), `backend/v15_lint.py` (LINT), `backend/lmstudio.py` (LMS), `backend/captioner.py` (CAP), `backend/model_store.py` (MS). Paths relative to repo root. Line numbers are start lines.

v2 state: `/prompts` route is `ClassicPlaceholder view="prompts"` (web/src/app/routes.tsx:15); `/bbox` also a placeholder (routes.tsx:16). Reusable v2 pieces: `web/src/pages/dataset/VlmSelect.tsx` (the `GET /api/models` select, queryKey `['vlm-models']`, custom-folder add/remove, store status badge), `lib/api.ts` (`api<T>`, `ApiError`), `useMutationWithToast`, `ConfirmDialog`, `FolderPicker`, `GpuBar` (polls `/api/gpu`), SettingsPage LM Studio URL field (SettingsPage.tsx:231 -> `GET/POST /api/lmstudio`). Backend tests exist: `tests/test_prompt_library.py`, `tests/test_v15_lint.py`.

Legacy `api()` helper (APP:4): body truthy -> POST+JSON, else GET; non-OK throws `Error(rawResponseText)` so errors display as raw `{"detail": "..."}` JSON text (status line shows `"Error: {\"detail\":...}"`). `/api/prompts/library` DELETE and export use bare `fetch` / navigation, not `api()`.

The view is the `<div id="view-prompts">` (IDX:284-387), nav tab `data-view="prompts"` (IDX:17, label "✨ Prompt studio"). Deep link: `/legacy/#prompts` (APP:313-318). Script load order: `studio_extras.js` (IDX:795), `bbox_editor.js` (796), `app.js` (799).

## 1. Controls

Three cards: (1) "Your prompt" IDX:286-364, (2) "Result" `#pResultCard` IDX:366-380 (hidden until the first successful generate), (3) "Prompt library" `#pLibCard` IDX:372-386.

### 1.1 Card 1 — input and settings
| id | label / text | type | options (value: label) | default | notes |
|---|---|---|---|---|---|
| `.ptab[data-action]` (no id) | "Expand (from a short idea)" / "Refine (clean up an existing one)" | 2 buttons, `.active` toggles | `expand`, `refine` | expand | sets JS var `pAction` (APP:626); calls `updatePHint()` (APP:640-650) |
| `pHint` | status paragraph | p.info | text rewritten by `updatePHint` | expand: "Type a short idea and the model will expand it into a full prompt: {fmt}." ; refine: "Paste a longer/existing prompt — the model will clean it up and adapt it to: {fmt}." | `{fmt}` = "FLUX.2" / "Ideogram 4 (JSON)" / "ai-toolkit (JSON)" (APP:634-640). HTML initial text lacks the `: {fmt}` suffix until JS runs |
| `pInput` | (no label) textarea.bigtext | textarea | | "" | placeholder expand: "e.g. a woman with red hair in a cafe"; refine: "e.g. woman, red hair, cafe, masterpiece, best quality, 8k, detailed" (APP:628-631, switched by `updatePHint`) |
| `pSubject` | Subject type | select | `auto`: Auto (detect from the text) [sel]; `person`: Person / character; `product`: Product / object; `landscape`: Landscape / scene; `architecture`: Architecture | auto | sent as `subject`; unknown values -> no hint (PR `_STUDIO_SUBJECT.get(subject, "")`) |
| `promptFormat` | Target format | select | `flux`: FLUX.2 (natural language) [sel]; `ideogram`: Ideogram 4 (JSON); `aitoolkit`: ai-toolkit (JSON) | flux | sent as `caption_format`. NOTE the task's "Ideogram v15" is `ideogram`; `aitoolkit` behaves identically to `ideogram` in the studio (SRV:2393, 2153) |
| `pModel` | Model | select (filled by JS) | from `GET /api/models`: `{id: label}`; ids = HF repo id (`Qwen/Qwen2.5-VL-3B-Instruct`, `Qwen/Qwen2.5-VL-7B-Instruct`), absolute custom folder path, `lmstudio:<id>` | server `default` = `Qwen/Qwen2.5-VL-7B-Instruct` (CAP:19) | `populateModels` (APP:23-37) fills BOTH `#model` and `#pModel` and preserves each current value; `selectKey` param selects a newly added model in both |
| `pAddModelBtn` | "📁 Add model from folder" | button.mini | | | handler lives with the dataset-view model code (zenity picker -> `POST /api/models/custom`), shared with `#addModelBtn` |
| `pRemoveModelBtn` | "🗑 Remove custom" | button.mini | | | custom = value starts with `/`; else alert; confirm() — same code as `#removeModelBtn` |
| `pQuant` | Quantization | select | `4bit`: 4-bit (saves VRAM) [sel]; `none`: None (fp16) | 4bit | `quant`. Independent of Dataset `#quant`. Ignored for `lmstudio:` models. Backend coerces anything not in (`4bit`,`none`) to `4bit` (SRV:2391) |
| `pMaxTokens` | Max length (tokens) | number min 64 max 8192 step 32 | | 768 | `max_tokens` = `parseInt(.., 10)` (NaN -> JSON null -> 422). Tooltip: reasoning models (Qwen3 etc.) count thinking against the limit; give 2048+. min/max not enforced in JS. Independent of Dataset `#maxTokens` (512) |
| `pElemDetailField` > `pElemDetail` | Element count (Ideogram) | select in `div.field.hidden` | `few`: Few (2–3); `balanced`: Balanced (per framework) [sel]; `detailed`: Detailed (6–10); `maximal`: Maximal (10–16) | balanced | `elements_detail`. Visible only for `ideogram`/`aitoolkit` (EXT:112-119) |
| `pDescDetailField` > `pDescDetail` | Description density (Ideogram) | select in `div.field.hidden` | `brief`: Brief (15–30 words); `balanced`: Balanced [sel]; `rich`: Rich (close to 60 words) | balanced | `desc_detail`. Same visibility rule |
| `pPresets` | "Style presets (append a composition-preserving instruction)" | div.row filled by JS (EXT:75-97) | three selects, see 1.4 | each at its placeholder option | client-only, never sent as its own field |
| `pGenBtn` | "✨ Generate prompt" | button.primary | | | -> `generatePrompt()` (APP:662); disabled during the request |
| `pStatus` | status line | p.info | classes `ok` / `err` | "" | `setPStatus` (APP:736) |

Conditional visibility summary: only `pElemDetailField`/`pDescDetailField` (by `promptFormat`), `pToCanvasBtn` (by `promptFormat`), `pWarnBox` (by `promptFormat` AND whether warnings were passed), `#pResultCard` (after first success). Nothing is hidden by Expand vs Refine.

### 1.2 Card 2 — result (IDX:366-380)
| id | label | type | behaviour |
|---|---|---|---|
| `pResultCard` | "2 Result" | section.card.hidden | unhidden on first success, never re-hidden (APP:682) |
| `pOutput` | | textarea.bigtext, **editable** (not readonly) | set to `r.prompt`; edits are not saved to the library and are what Copy / Use / Edit on canvas read |
| `pWarnBox` | | div.v15list.hidden | v15 lint findings, see 1.3 |
| `pCopyBtn` | "📋 Copy" | button | `navigator.clipboard.writeText(pOutput)`; status "Copied to clipboard."; fallback select()+`execCommand("copy")` status "Copied." (APP:699-710). No-op on empty |
| `pRegenBtn` | "↻ Regenerate" | button | same handler as Generate (`generatePrompt`): re-reads current `pInput`, NOT the previous result; creates a NEW library row |
| `pUseBtn` | "↑ Use as input" | button | `pInput = pOutput.trim()`, clicks the Refine tab (so `pAction="refine"`, hint updates), focuses input, status "Moved the result to the input." (APP:712-722) |
| `pToCanvasBtn` | "🧩 Edit on canvas" | button.hidden | visible iff `promptFormat !== "flux"` (`updateToCanvasBtn`, APP:724-733). Handler: see 3.9 |

### 1.3 Linter UI (v15 findings)
- Container `#pWarnBox` (`div.v15list`, IDX:369). Rendering is the shared `window.renderV15Findings(box, findings)` (EXT:14-35), also used by the bbox editor (`#bxValBox`, BBX:~314) — a React port should make one `<V15Findings>` component for both.
- Empty/absent findings array -> single row `.v15item.ok` with `✓` and "No warnings — compliant with the v15 guidelines". Each finding `{level: "err"|"warn", msg}` -> `.v15item.err` (icon `✕`) or `.v15item.warn` (icon `!`) + message text (textContent, no HTML).
- `window.renderStudioWarnings(warnings)` (EXT:38-47): reads CURRENT `promptFormat`; if `flux` OR `warnings === undefined` -> clears and hides the box; else unhides and renders `warnings || []`.
- Called once, inside `generatePrompt` success (APP:683) with `r.warnings`. NOT re-run when the user edits `pOutput`, nor when the format dropdown changes (see Fragile #6).
- **Lint is server-side for the studio** (`v15_lint.lint_v15`, called in `api_prompt`, SRV:2409). The bbox editor has a client-side mirror (BBX:285-313). Exact rules (LINT) in section 3.6.

### 1.4 Style presets (EXT:50-97)
Three `<select>`s are created in `#pPresets`, each with first option `value=""` text `"{label}…"` and `title="Appends a composition-preserving instruction to the prompt"`. On `change` with non-empty value: `appendToInput(guide(value))` then the select is reset to `""`.
| key | label | options (value = text) | appended instruction |
|---|---|---|---|
| `era` | "Era…" | Mesopotamia, Ancient Egypt, Ancient Rome, Medieval, Renaissance, Victorian (1890s), Roaring 1920s, 1950s Americana, 1970s, 1980s, 1990s, Cyberpunk near-future, Far future / sci-fi | `Time travel: keep the exact same composition, framing and element positions, but depict the scene as a period-accurate ${v} version — adjust clothing, technology, vehicles, architecture and materials to that era.` |
| `style` | "Style…" | Oil painting, Watercolor, Anime, Pixel art, Comic book, 3D render, Pencil sketch, Pop art, Low-poly, Claymation | `Re-render the scene in this medium/style: ${v}. Keep the exact same composition and layout; only change the rendering style.` |
| `genre` | "Genre / mood…" | Cyberpunk, Film noir, High fantasy, Post-apocalyptic, Vaporwave, Steampunk, Horror, Solarpunk, Western, Fairy tale | `Re-theme the scene as ${v}. Keep the exact same composition and layout; restyle the content, lighting and mood to match the theme.` |
`appendToInput(text)` (EXT:66-71): `pInput.value = (value.trim() ? value.trim() + "\n\n" : "") + text`; focuses `pInput`. Presets only edit the textarea; no mode switch (user must pick Refine themselves), no state of their own, no dedupe (picking twice appends twice).

### 1.5 Card 3 — library (IDX:372-386)
| id | label | type | behaviour |
|---|---|---|---|
| intro | "Every generated prompt is saved here automatically (SQLite). Click 📋 to copy the whole prompt with one click." | p.info | |
| `.plibtab[data-cat]` | "All" / "FLUX.2" / "Ideogram (JSON)" | 3 buttons | `all` [active], `flux`, `ideogram`; click sets JS `pLibCat` (APP:744) and reloads |
| `pLibList` | | div.pliblist (CSS:481, max-height 480px, scroll) | rows, see below |
| `pLibExportBtn` | "⬇ Export to .sql" | button | `window.location.href = /api/prompts/library/export?category=${pLibCat}` (APP:864-867) -> browser download |
| `pLibRefreshBtn` | "↻ Refresh" | button | `loadPromptLib()` |
| `pLibStatus` | | p.info | `Items: N` / `Library load error: ...` / `Delete error: ...` |
Empty list text: "The library is empty — generate your first prompt above." (APP:774).
Row (`renderPromptLib`, APP:767-842; CSS `.plib-item/.plib-badge/.plib-text/.plib-meta/.plib-btns` 482-499):
- badge `span.plib-badge.{category}`: text "Ideogram JSON" if category==="ideogram" else "FLUX.2" (ideogram badge color `#b07cff`, CSS:492).
- body: `.plib-text` = whole prompt, CSS-clamped; click toggles `.expanded` (title "Click to expand/collapse"); `.plib-meta` = `#{id} · {new Date(created*1000).toLocaleString("pl-PL")}` + (` · „{input_text.slice(0,60)}”` if input_text). Note hard-coded `pl-PL` locale and Polish quotes.
- 📋 Copy (`copyBtn`): `copyTextToClipboard` (APP:757; clipboard API, fallback temp textarea+execCommand for http://) then label "✓ Copied" for 1500 ms.
- 🧩 (only if `category==="ideogram" && window.BboxEditor`): title "Open in the bbox editor"; `switchView("bbox"); window.BboxEditor.open(it.prompt)`.
- 🗑 delete: NO confirm(); `fetch DELETE /api/prompts/library/{id}`; non-OK -> status "Delete error: ..."; success -> reload list (current category).
- Button order: Copy, [🧩], 🗑.
The library list has no search box, no pagination (whole table is returned), no edit/rename.

## 2. API calls

All JSON. No auth. Requests go through `OriginGuard` (backend/origin_guard.py) like all `/api/*`.

### 2.1 Calls made by this view
| # | when | call | request | response fields used |
|---|---|---|---|---|
| 1 | page init (APP:43) | `GET /api/models` | — | `models` (id->label), `default`; fills `#model` + `#pModel` |
| 2 | page init (APP:48) | `GET /api/lmstudio` | — | `url` (into dataset-view `#lmstudioUrl`; studio never shows it) |
| 3 | Generate / Regenerate | `POST /api/prompt` | see 2.2 | `prompt`, `warnings` (`library_id` ignored) |
| 4 | after success, on load, tab click, Refresh, after delete, after bbox "Save to library" (BBX:344 calls `window.loadPromptLib`) | `GET /api/prompts/library?category={all|flux|ideogram}` | query `category` | `prompts[]` rows `{id, category, action, input_text, prompt, created}` |
| 5 | 🗑 | `DELETE /api/prompts/library/{id}` | path int | only `res.ok`; error body text shown |
| 6 | Export | navigation `GET /api/prompts/library/export?category=` | | attachment |
| 7 | add/remove model buttons | `POST|DELETE /api/models/custom` `{path}` | | shared with Dataset view (see 4) |
| 8 | after generate (`finally`) and on load/poll | `GET /api/gpu` via `refreshGpu()` (APP:228) | | topbar only |
Not called by the studio UI: `POST /api/prompts/library` (used only by BBX:332 "Save to library" in the bbox editor, `{category:"ideogram", prompt: minified JSON, input_text:"bbox editor", action:"manual"}`), `POST /api/lmstudio`, `/api/comfy/prompts` (the SEPARATE named-prompt store in the ComfyUI view, `comfy_prompts.json`, IDX:560-566 / APP:1035-1080 — do not conflate with the library).

### 2.2 `POST /api/prompt` (SRV:2385, `def` -> runs in the threadpool; sync, blocks until the generation ends, no job/progress/cancel)
Request model `PromptRequest` (SRV:214-223), no validators/Literals:
| field | default | client value |
|---|---|---|
| `text` | required | `pInput.value.trim()` (client refuses empty: status "Type a prompt to process." err) |
| `action` | `"expand"` | `pAction` (`expand`/`refine`); unknown -> falls back to expand prompt |
| `subject` | `"auto"` | `#pSubject` |
| `model` | `captioner.DEFAULT_MODEL` | `#pModel` (HF id, custom path, `lmstudio:<id>`) |
| `quant` | `"4bit"` | `#pQuant`; coerced to `4bit` unless in (`4bit`,`none`) |
| `max_tokens` | 768 | `#pMaxTokens` |
| `caption_format` | `"flux"` | `#promptFormat` |
| `elements_detail` | `"balanced"` | `#pElemDetail` (sent even when hidden / flux; ignored for flux) |
| `desc_detail` | `"balanced"` | `#pDescDetail` |
Behaviour (SRV:2386-2415):
1. `text.strip()` empty -> **400** "Type a prompt to expand or refine."
2. Build system prompt: ideogram/aitoolkit -> `prompts.build_ideogram_studio_v15(action, subject, elements_detail, desc_detail)` (PR:937; concatenates `_IDEOGRAM_V15_BASE/ACTION/CONTRACT/ASPECT/HLD/ELEMENTS/BACKGROUND/BBOX/SPECIFIC/PLANNING/TEXT` PR:596-785 then `_detail_directive` appended LAST, PR:826); else `prompts.build_studio_system(action, subject)` (PR:203; `_STUDIO_BASE+RULES+ACTION+SUBJECT+OUTPUT`, PR:139-200). The older `build_ideogram_studio_system` (PR:443) is NOT used by the endpoint (dead for the studio).
3. Detail directive text (PR:813-833): elements few "…only 2 to 3 elements — just the most important subjects.", detailed "…6 to 10 elements…", maximal "…10 to 16 elements, breaking it very finely…", balanced "" ; desc brief "Keep each element's desc to a tight 15-30 words.", rich "Write each element's desc close to the 60-word cap, covering materials, colors and spatial anchors.", balanced "". Both empty -> no directive; else " DETAIL SETTINGS (override any element-count or description-length guidance above): …".
4. Generate: if `model` starts with `lmstudio:` -> `lmstudio.generate_text(_lmstudio_url(), id, system, text, max_tokens)` (temperature 0.7, timeout 120 s). Else `captioner.ensure_loaded(model, quant, source=_ensure_model_http(model))` then `captioner.generate_text(system, text, max_new_tokens=max_tokens)` (temperature 0.7, top_p 0.9, no image).
5. Post-process: ideogram/aitoolkit -> `prompts.normalize_ideogram_v15(raw)` (PR:565: extracts JSON object, unwraps/converts old formats, enforces key order, aspect_ratio `W:H`, element shape; when no JSON found wraps the whole text as `high_level_description` + `background` with `aspect_ratio:"1:1"`, so the result is ALWAYS valid compact JSON) then `v15_lint.lint_v15(final)`. Flux -> `prompts.clean_prompt(raw)` (PR:218: strip ``` fences, one leading filler from `_STUDIO_PREFIXES`, surrounding quotes) and `warnings=[]`.
6. Persist: `_save_prompt_to_library(_prompt_category(caption_format), req.action, text, final)` — AFTER generation, in the same try; `input_text` = stripped input text; `action` = raw `req.action`.
7. Response 200: `{"prompt": str, "library_id": int, "warnings": [{"level","msg"}]}`.
Errors: 400 empty text; 400 from `_ensure_model_http` for `ModelsFolderNotSet`, `_UnknownModel`, `ValueError` (folder unusable / no space); 502 `_ensure_model_http` RuntimeError (failed download) — plain message; 502 `"LM Studio: {msg}"` for `LMStudioError` (cannot connect `({base_url})`, HTTP code, non-JSON, no content, empty answer incl. the "spent all N tokens on reasoning" message LMS:44-56); 500 `"Generation error: {e}"` for everything else (CUDA OOM, missing transformers, a DB write failure after a successful generation, etc.). `except HTTPException: raise` keeps 400/502 intact. Pydantic type error (e.g. `max_tokens` null) -> 422 FastAPI default `detail` list.
No `_busy()` guard (unlike `/api/unload` SRV:1073) and no GPU/job lock around `generate_text`; only `ensure_loaded` takes `captioner._lock`.

### 2.3 Library endpoints (SRV:2151-2262, `_db_query` SRV:62)
Persistence: SQLite `WORK/flux_prep.db` (`WORK` = `$FLUX_PREP_WORK` or `<repo>/.work`, SRV:42; `DB_PATH` SRV:57). Table created at import by `_init_db()` (SRV:89-98):
`prompt_library(id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL CHECK(category IN('flux','ideogram')), action TEXT NOT NULL DEFAULT '', input_text TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL, created REAL NOT NULL)` (`created` = unix seconds float). One connection per call, no WAL/lock. Same DB also holds `workflows` (ComfyUI editor). No dedupe, no size cap, no migration needed for this table.
- `POST /api/prompts/library` (SRV:2183) body `LibrarySaveRequest{category, prompt, input_text="", action="manual"}` (SRV:226). 400 "The category must be 'flux' or 'ideogram'." / "Empty prompt." / (ideogram only) "An Ideogram prompt must be a valid JSON object." (`json.loads` must give a dict). Prompt is `.strip()`ped. Returns `{id, warnings}` (lint only for ideogram; note it lints the UNstripped `req.prompt`).
- `GET /api/prompts/library?category=all` (SRV:2199): any value other than `flux`/`ideogram` (including garbage) = all rows. `ORDER BY id DESC` (newest first). Returns `{"prompts":[dict(row)]}` with all six columns. No limit.
- `DELETE /api/prompts/library/{pid}` (SRV:2217): pid int (non-int -> 422); missing -> **404** "No prompt with that id."; else `{"ok": true}`.
- `GET /api/prompts/library/export?category=all` (SRV:2229): calls the list handler directly, returns `Response` `application/sql; charset=utf-8`, `Content-Disposition: attachment; filename="prompts_{category}_{YYYYmmdd-HHMMSS}.sql"` (filename uses the RAW query value, unsanitised). Body: comment header (`-- Prompt library (flux-lora-prep), exported {YYYY-mm-dd HH:MM}, category: {category}, items: {n}`), `CREATE TABLE IF NOT EXISTS prompt_library (...)` identical to the live schema, blank line, then one `INSERT INTO prompt_library (id, category, action, input_text, prompt, created) VALUES (id, 'cat', 'action', 'input', 'prompt', created);` per row (single quotes doubled by `_sql_quote`; newlines preserved inside literals; `created` raw float). Empty library still yields header+schema. Because it is a plain GET download, a React port can use `<a href download>` — `fetch`+blob is unnecessary.
- `_prompt_category(fmt)` SRV:2153: `ideogram`/`aitoolkit` -> `ideogram`; everything else -> `flux`.

### 2.4 Model-list endpoints the dropdown depends on (SRV:559-760)
- `GET /api/models` (SRV:663) -> `{models: {**captioner.AVAILABLE_MODELS, **custom_models.json, ...lmstudio:<id>: "LM Studio: <id>"}, default}`. `lmstudio.list_models` does a live `GET {url}/models` with a **3 s timeout** on EVERY call; unreachable -> silently no LM Studio entries. Built-in labels (CAP:16-17): "Qwen2.5-VL 3B (fp16, fast, ~7 GB VRAM)", "Qwen2.5-VL 7B (4-bit, best captions, ~9 GB VRAM)". Custom: key = absolute path, label `"{dirname} (custom)"` (`_add_custom_model` in SRV, near `_all_models`).
- `POST /api/models/custom {path}` / `DELETE /api/models/custom {path}` (SRV:709/720): validate folder has `config.json` of a Qwen2.5-VL (`model_store.is_qwen_vl_config`), error strings via `ValueError`. `GET /api/fs/list` (SRV:665) feeds the folder picker (v2 `FolderPicker`).
- `GET|POST /api/lmstudio` (SRV:755-762): `{url}`; stored `WORK/lmstudio.json`, default `http://localhost:1234/v1`.

## 3. Flows

3.1 **Expand**: tab "Expand" active by default -> user types idea in `pInput` -> (optional presets) -> Generate. `generatePrompt()` (APP:662-694): trim; empty -> status err "Type a prompt to process." (no request). Else disable `pGenBtn`+`pRegenBtn`, status "Generating… (first use loads the model)", POST `/api/prompt` (2.2). Success: `pOutput.value = r.prompt`, show `#pResultCard`, `renderStudioWarnings(r.warnings)`, `updateToCanvasBtn()`, status "Done. Saved to the library." (ok), `loadPromptLib()`. Failure: status `"Error: " + e.message` (raw JSON text). `finally`: re-enable both buttons, `refreshGpu()`. There is no progress, spinner, cancel or timeout on the client; first call may block for minutes (download + load).
3.2 **Refine**: identical request with `action:"refine"`; differs only in the system-prompt ACTION block (PR:165-178, `_IDEOGRAM_V15_ACTION` PR:785), hint text and placeholder. Entry points: click the tab, or "↑ Use as input" (3.8).
3.3 **Target switch** (`promptFormat` change; three listeners): `updatePHint` (hint text only — does not re-fetch anything), `updateToCanvasBtn` (hide for flux), `updateDetailVisibility` (show element/density fields for ideogram/aitoolkit; EXT:112-119, also run once on DOMContentLoaded). It does not re-run generation, does not convert an existing `pOutput`, and does not touch the library tab filter.
3.4 **Presets**: see 1.4; purely edits `pInput`.
3.5 **Regenerate**: same as Generate with current `pInput`/settings; creates another library row (no replace).
3.6 **Lint (server-side for the studio; client mirror only in the bbox editor)**. Input: the FINAL normalized JSON string. Output order = rule order. `lint_v15` (LINT:44-134):
 - not valid JSON -> single err "The prompt is not valid JSON."; not an object -> err "The prompt is not a JSON object."
 - warn: key `style_description` present ("Legacy format: style_description does not exist in v15 …").
 - err: `aspect_ratio` not a string matching `^\d+:\d+$` (after strip) — "aspect_ratio must be a string in W:H format (e.g. 4:5)."
 - HLD = `high_level_description`; BG = `compositional_deconstruction.background`.
 - warn: HLD empty ("high_level_description is empty."). Else: warn if >50 words; warn if matches `META` `\b(this image (shows|depicts)|depicts|captures)\b` (any position, i).
 - warn: `\bwarm(\b|ly)` in HLD or BG ("warm" as grading).
 - warn: BG matches POSTFX (film grain, kodak, portra, tri-x, iso noise, lens flare, chromatic aberration, vignett, bokeh, halftone, risograph, brushstrokes?, paper texture, canvas texture).
 - err: BG matches ARRANGE (rows of desks, grid of desks, chairs arranged, cars parked, customers seated, room is filled with people, seated at the desks/tables, desks reced).
 - per element i (1-based among `elements`; non-dict skipped; `type` default `obj`): tag `(type #i) `. text type: warn if `text` empty; (counts `text_count`). warn desc >60 words. err desc matches RENDER (bokeh, depth of field, shallow focus, f/\d, mm lens, telephoto, chromatic aberration, lens flare, vignett, film grain, motion blur, iso \d, drop shadow, cast shadow, casts a shadow). warn desc "warm". warn (type obj only) desc matches PART (thorax, abdomen, wingtip, left/right leg, left/right arm, windshield, wheels?, petals?, stem only, each limb, forearm only). err desc matches FLOOR (pavement, puddles?, wet ground, rain-slicked, asphalt, cobblestones?, sidewalk, the floor, the ground, turf, grass surface, snow on the ground, tile floor, hardwood floor, reflective ground). warn desc matches HEDGE (things like, such as, e.g., for example, or similar, various, could include, might be, implied, suggested, hinted, barely visible, perhaps, reads as). bbox (list of 4, `[y1,x1,y2,x2]`): err if not y1<y2 and x1<x2; err if any coord outside 0-1000; err if not numeric.
 - warn: `text_count == 0` and BUILTENV matches in `HLD + " " + BG` (shop, stall, restaurant, store(front)?, sign, market, cafe, bar, workshop, poster, cover, banner, menu) — "built environment … no text elements".
 All regexes are `\b…\b`, case-insensitive. Word count = `len(split())`. The BBX mirror (BBX:285-313) is hand-synced (client uses `e.id` not index, drops the numeric/0-1000 and `style_description` details differently, e.g. only `y0<y1 && x0<x1`); the two lists can drift (Fragile #11).
3.7 **Save to library**: automatic, server-side, inside `/api/prompt` (both categories, every success). Ideogram rows are guaranteed valid JSON objects (normalize wraps freeform text). Manual save exists only in the bbox editor (2.3 POST). Prompts edited in `pOutput` are never saved.
3.8 **Library**: load on script start (APP:870, even while hidden) and after each generate; tab click -> `pLibCat` + reload (server-side filter); Refresh -> reload; Copy 3.x; 🗑 delete without confirm then reload; Export -> download .sql of the ACTIVE category.
3.9 **Open on canvas**: two entry points, both identical: result-card `🧩 Edit on canvas` (reads `pOutput.value.trim()`, requires non-empty and `window.BboxEditor`; APP:726-731) and library row 🧩 (ideogram rows only; passes `it.prompt`). Sequence: `switchView("bbox")` (global fn, also `window.switchView`, APP:297-306; toggles `.navtab.active`, hides other `main > div[id^=view-]`, then `BboxEditor.onShow()` -> `fitFrame()`), THEN `window.BboxEditor.open(jsonString)` (BBX:385-398): `loadCaption(raw)` (BBX:45; tolerant — unwraps old/broken/double-encoded and converts to v15) in try/catch; success status `#bxStatus` "Prompt loaded for editing."; failure "JSON parse error: …" and return; then `fitFrame()`. Handoff is purely in-memory via the `window.BboxEditor` global and a direct function call — NO events, no localStorage, no URL/hash change (the hash is not updated by `switchView`), no `postMessage`. Order matters: must be called after the view is visible (canvas size from layout). The bbox editor does not return anything to the studio except via its own Save (POST library) which triggers `window.loadPromptLib()` (BBX:344). For React: `/bbox` is still a placeholder, so Open on canvas has no target until that view is ported (interim: link to `/legacy/#bbox` cannot carry the JSON — would need a store/query param/localStorage handoff, to be designed).
3.10 **Use as input**: see 1.2.

## 4. Shared state and storage

- No `localStorage`/`sessionStorage` in the studio (grep: only `crop_editor.js:22,39` uses `localStorage["cropPlan:"+folder]`). Nothing persists across reload except the server-side library, `custom_models.json`, `lmstudio.json`. Form values (format, model, tokens, presets, last input) reset on reload. v2 convention: sessionStorage for in-progress runs (`web/src/pages/dataset/runStore.ts`), localStorage only for legacy cropPlan adoption.
- Model dropdown: `#pModel` and Dataset `#model` are populated together from one `GET /api/models` (APP:23); adding/removing a custom model repopulates BOTH and keeps each one's selected value. They are otherwise independent (changing one does not move the other). v2: `VlmSelect` keeps its own `['vlm-models']` cache — invalidate it after add/remove.
- `#pQuant`, `#pMaxTokens` are separate from Dataset `#quant`, `#maxTokens`; the loaded VLM is a single process-wide singleton keyed by `(model, quant, device)` (CAP:23-24, 38-39), so alternating Dataset/Studio with different quant/model reloads weights each time. `lmstudio:` models bypass it entirely.
- GPU: `captioner._state` + `gpu.device_for("vlm")` (the VLM role card chosen in Settings/Topbar). The studio never selects a GPU; `refreshGpu()` after each generate updates the topbar (`/api/gpu` -> `model`, `quant`, `loaded`, VRAM). `⏏ Release GPU` (`/api/unload`, 409 while `_busy()`) unloads captioner. v2: `GpuBar` polls on its own; invalidate `['gpu']` after generate.
- LM Studio URL: single server setting (`lmstudio.json`); the studio uses it implicitly (`_lmstudio_url()` per request). In classic UI the URL box is in the Dataset view and persisted only on "Refresh models" (APP:2073); v2 edits it in Settings.
- Library <-> bbox editor: bbox `Save` POSTs to the same table and calls global `window.loadPromptLib` to refresh the list (implicit dependency of BBX:344 on the studio function; `loadPromptLib` is a top-level `function` in a classic script so it is global).
- Dataset caption format (`#captionFormat`) is a different control from `#promptFormat`; no link.

## 5. Generation backends

- **Local Qwen2.5-VL** (default `Qwen/Qwen2.5-VL-7B-Instruct`; 3B; custom folders that pass `is_qwen_vl_config`): used text-only. `captioner.ensure_loaded(model, quant, source)` (CAP:28-85): imports torch + transformers lazily, key `(model, quant, device)`; no-op if same; otherwise drops old model, `gpu.empty_cache()`, loads `Qwen2_5_VLForConditionalGeneration.from_pretrained(source or model, dtype=float16, device_map=device)`, with bitsandbytes nf4 + double-quant when `quant=="4bit"` and device is CUDA (on CPU `4bit` silently becomes fp16 on CPU); processor `min_pixels=256*28*28`, `max_pixels=1024*28*28`. Holds `_lock` during the whole load (other requests wait). `source` = local path from `_ensure_model_http(model)`; the model stays known by its id for the GPU status. `captioner.generate_text(system, user, max_new_tokens=320 default, temperature=0.7)` (CAP:~170-228): chat template with system+user, no image, sampling, returns stripped decode. Raises RuntimeError "Model not loaded" if `_state` empty (cannot happen via the endpoint).
- **`_ensure_model_http`** (SRV:581) -> `_ensure_model` (SRV:555) -> `model_store.ensure_local` (MS:422): absolute path or `lmstudio:` ids pass through; unknown id -> KeyError -> `_UnknownModel` -> 400; known HF id: use the local copy if present in the Models folder (`resolve_path`), else if `settings.models_dir` is empty -> `ModelsFolderNotSet` -> **400** "No models folder chosen — set one in Settings (Models folder)."; else it BLOCKS the HTTP request while downloading (`start_download` + 0.1 s polling; with `job=None` there is no progress surfaced, `on_progress` is None), possibly many GB; failure -> RuntimeError -> 502; cancel -> 502 "Download cancelled.". The studio therefore silently downloads a model on the first Generate if the folder is set but the weights are absent.
- **No Models folder**: HF-id models -> 400 with the message above (shown as raw JSON in classic status). Custom-folder models and `lmstudio:` models still work with no Models folder. Florence is not involved.
- **LM Studio** (LMS): OpenAI-compatible `POST {url}/chat/completions` with `{model, messages:[system,user], max_tokens, temperature: 0.7}`, headers `Authorization: Bearer lm-studio`; timeout 120 s; `quant` ignored. Model must be loaded in LM Studio itself. Reasoning models returning empty `content` raise a specific "raise the max tokens" error (message names the Dataset setting, "Max caption length"). `max_tokens` here is the same field as for local.
- Outputs from either backend go through the same post-processing; the system prompt is English and instructs "Always write the prompt in English" (flux) / JSON-only.

## 6. Fragile and surprising points (for the porter)

1. `POST /api/prompt` is synchronous and unbounded: first call may download + load multiple GB with no progress/cancel; the legacy UI only shows "Generating… (first use loads the model)". A v2 port needs a long-lived pending state and must survive navigation (the legacy request continues server-side and the library row is still written; the UI result is lost if the component unmounts — consider a store like `runStore.ts` or just rely on the library).
2. Errors reach the UI as raw JSON strings in legacy; in v2 use `ApiError.detail`. 422 detail is a list, not a string.
3. The result is persisted BEFORE the client sees it; a DB failure after a successful (slow) generation yields a 500 "Generation error" and loses the text. Regenerate always creates a new row; edits to `pOutput` never persist.
4. `aitoolkit` = `ideogram` everywhere in the studio (system prompt, normalization, category, lint) — there is no ai-toolkit-specific output. Library category has only `flux`/`ideogram` (CHECK constraint), and the library tab labelled "Ideogram (JSON)" includes ai-toolkit generations.
5. `elements_detail`/`desc_detail` are sent for flux too (ignored). The detail fields are hidden, not reset, on format switch — hidden values persist.
6. Stale UI after a format switch: the warnings box is re-evaluated only on generate; switching to `flux` after an ideogram result leaves `pWarnBox` visible (hide logic only runs inside `renderStudioWarnings`), while `pToCanvasBtn` toggles live. Likewise "Edit on canvas" depends on the CURRENT dropdown, not on the result's format. A port should store the result's format with the result.
7. `pOutput` is editable but lint is not re-run on edit; only `/api/prompts/library` POST (bbox) lints stored text. No client-side lint exists in the studio; the bbox editor's mirror (BBX:285) must stay equal to `v15_lint.py` (comment says it "mirrors"; they have already diverged in minor wording/bbox range check).
8. `max_tokens` too low for reasoning models (Qwen3 via LM Studio) gives an empty-answer error (502) rather than a truncated prompt; local Qwen2.5-VL simply truncates JSON (and `normalize_ideogram_v15` then falls back to wrapping garbage text as HLD/background with `1:1`, which still lints "clean-ish"). Default 768 is small for 16-element ideogram JSON (maximal) — a truncated result is silently "repaired".
9. `GET /api/models` hits LM Studio with a 3 s timeout on every call (and the Dataset view shares it), so the dropdown can stall up to 3 s when LM Studio is down; a previously selected `lmstudio:*` value vanishes from the options when it is down (legacy resets to `default`; v2 `VlmSelect` instead keeps and marks unavailable).
10. Library locale/formatting: `toLocaleString("pl-PL")`, Polish quote marks, mixed Polish messages elsewhere in app.js (comfy). Newest-first by `id`, not `created`. Whole table is returned (no limit) and each row renders the full prompt — large libraries will be heavy; list height is scroll-capped at 480px with per-row click-to-expand.
11. Delete has no confirmation and no undo; export filename embeds the unsanitised `category` query value and reflects the active tab (unknown value exports everything but is named after the value). Export is not scoped to the current search because none exists.
12. Clipboard: `navigator.clipboard` fails on non-secure http (LAN access to the GPU box) — legacy has an `execCommand("copy")` fallback in both copy paths; a port needs the same fallback.
13. `pHint`/placeholder are dynamic; the static HTML hint text lacks the format suffix. Using "Use as input" force-switches to Refine; presets do not.
14. Preset instructions are appended into the user's text, so the model sees "Time travel: …" as part of the idea; they assume Refine-style rewriting of an existing prompt but work with Expand too. No state is kept for which preset was applied.
15. Open-on-canvas ordering constraint (`switchView` before `open`) and the global-function coupling (`window.BboxEditor`, `window.loadPromptLib`, `window.switchView`, `window.renderV15Findings`) are the only cross-view contracts; none exist in v2 yet.
16. The legacy script also calls `loadPromptLib()` at load, while the view is hidden; the library isn't refreshed on view show, only after generate / bbox save / manual Refresh. A port should refetch on mount (TanStack Query, invalidate `['prompt-library']` after generate/delete and after the bbox editor saves).
17. VRAM contention: no `_busy()` check, so Generate during a Dataset run (same singleton, possibly different model/quant) triggers a model swap under the running job's feet (`ensure_loaded` only serializes loads, not use vs. swap). Concurrent Generate clicks are blocked client-side only via the disabled buttons.
18. Backend tests (`tests/test_prompt_library.py`) call handler functions directly with a monkeypatched `server.DB_PATH` and `server._init_db()` — a port must not change these function names/signatures (`_prompt_category`, `_save_prompt_to_library`, `api_prompt_library*`).

## 7. Quick index of code locations

- Markup: IDX:284-387 (studio), IDX:390+ (bbox view, separate).
- Studio JS: APP:624-735 (generate, hint, copy, use, canvas button), APP:742-870 (library), APP:23-37 (`populateModels`).
- Extras: EXT:14-47 (findings renderer + studio warnings), EXT:50-97 (presets), EXT:112-119 (format-dependent visibility).
- Backend: SRV:214-231 (request models), SRV:2151-2262 (library), SRV:2385-2415 (`/api/prompt`), SRV:555-590 (model resolution), SRV:614-640 (LM Studio helpers), PR:139-243 (FLUX studio prompts), PR:596-947 (v15 prompts + detail directives), LINT:44-134 (rules).
- Port targets: replace `ClassicPlaceholder` at web/src/app/routes.tsx:15; reuse `VlmSelect`; new hooks needed for `/api/prompt` (mutation), `/api/prompts/library` (query + delete mutation); shared `V15Findings` component for the future bbox view.

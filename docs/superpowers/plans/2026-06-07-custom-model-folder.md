# Custom model folder picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pozwolić użytkownikowi dodać model Qwen2.5-VL z dowolnego folderu przez przeglądarkę katalogów w UI, zapamiętać go i wybierać z listy modeli w obu zakładkach.

**Architecture:** Backend dokłada lekkie endpointy: przeglądanie podkatalogów (`/api/fs/list`), walidację+zapis własnych modeli (`/api/models/custom` POST/DELETE) i scalanie listy w `/api/models`. Logika to małe, testowalne funkcje. Trwałość przez `.work/custom_models.json` (wzorzec `_load_named`/`_save_named`). Front: refaktor wypełniania dropdownów + modal przeglądarki (reużywa istniejące klasy `.modal`). Ładowanie modelu bez zmian — `from_pretrained` przyjmuje ścieżkę.

**Tech Stack:** FastAPI, Pydantic, vanilla JS; testy: pytest (`.venv/bin/python -m pytest`).

**Spec:** `docs/superpowers/specs/2026-06-07-custom-model-folder-design.md`

---

### Task 1: Backend — pure helpers (list dirs, validate model, merge list)

**Files:**
- Modify: `backend/server.py` (add `CUSTOM_MODELS_PATH` constant near other `*_PATH`; add three helpers before the `/api/models` endpoint ~line 283)
- Test: `tests/test_models_custom.py` (create)

- [ ] **Step 1: Write failing tests** — create `tests/test_models_custom.py`:

```python
import json
from backend import server


def test_list_subdirs_only_dirs_sorted(tmp_path):
    (tmp_path / "b").mkdir()
    (tmp_path / "A").mkdir()
    (tmp_path / "file.txt").write_text("x")
    assert server._list_subdirs(tmp_path) == ["A", "b"]


def test_model_dir_info_not_a_dir(tmp_path):
    info = server._model_dir_info(tmp_path / "nope")
    assert info["ok"] is False


def test_model_dir_info_missing_config(tmp_path):
    info = server._model_dir_info(tmp_path)
    assert info["ok"] is False and "config.json" in info["reason"]


def test_model_dir_info_wrong_model(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "llama"}))
    info = server._model_dir_info(tmp_path)
    assert info["ok"] is False and "Qwen2.5-VL" in info["reason"]


def test_model_dir_info_qwen_ok(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "qwen2_5_vl"}))
    info = server._model_dir_info(tmp_path)
    assert info["ok"] is True
    assert info["label"].endswith("(własny)")


def test_all_models_merges_custom(tmp_path, monkeypatch):
    cm = tmp_path / "cm.json"
    cm.write_text(json.dumps({"/models/qwen": "qwen (własny)"}))
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", cm)
    models = server._all_models()
    assert "/models/qwen" in models
    assert any("Qwen2.5-VL" in v for v in models.values())
```

- [ ] **Step 2: Run — expect fail**

Run: `.venv/bin/python -m pytest tests/test_models_custom.py -q`
Expected: FAIL — `module 'backend.server' has no attribute '_list_subdirs'`.

- [ ] **Step 3: Add the constant**

In `backend/server.py`, next to the other `*_PATH` constants (after `COMFY_WORKFLOWS_PATH = WORK / "comfy_workflows.json"`, ~line 38), add:
```python
CUSTOM_MODELS_PATH = WORK / "custom_models.json"
```

- [ ] **Step 4: Add the three helpers**

In `backend/server.py`, immediately BEFORE the `@app.get("/api/models")` decorator (~line 283), add:
```python
def _list_subdirs(path: Path) -> list[str]:
    """Posortowane (case-insensitive) nazwy podkatalogów; nieczytelne pomijane."""
    out: list[str] = []
    try:
        for entry in path.iterdir():
            try:
                if entry.is_dir():
                    out.append(entry.name)
            except OSError:
                continue
    except OSError:
        return []
    return sorted(out, key=str.lower)


def _model_dir_info(path: Path) -> dict:
    """Czy `path` to folder z modelem Qwen2.5-VL. {ok, reason, label}."""
    if not path.is_dir():
        return {"ok": False, "reason": "Folder nie istnieje.", "label": ""}
    cfg = path / "config.json"
    if not cfg.is_file():
        return {"ok": False,
                "reason": "To nie jest folder modelu (brak config.json).",
                "label": ""}
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return {"ok": False, "reason": "Nie można odczytać config.json.", "label": ""}
    model_type = str(data.get("model_type", "")).lower()
    arch = " ".join(data.get("architectures", []) or [])
    if "qwen2_5_vl" in model_type or "Qwen2_5_VL" in arch:
        return {"ok": True, "reason": "", "label": f"{path.name} (własny)"}
    return {"ok": False,
            "reason": "Obsługiwane są tylko modele Qwen2.5-VL.",
            "label": ""}


def _all_models() -> dict:
    """Wbudowane modele + zapamiętane własne (własne nadpisują przy kolizji)."""
    return {**captioner.AVAILABLE_MODELS, **_load_named(CUSTOM_MODELS_PATH)}
```

NOTE: `_load_named` is defined later in the file (~line 809); that is fine — it is resolved at call time, not import time.

- [ ] **Step 5: Run — expect pass**

Run: `.venv/bin/python -m pytest tests/test_models_custom.py -q`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/server.py tests/test_models_custom.py
git commit -m "feat: backend helpers for custom model folders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — add/remove logic + endpoints

**Files:**
- Modify: `backend/server.py` (add `_add_custom_model`/`_remove_custom_model`, `CustomModel` model, three endpoints; update `/api/models`)
- Test: `tests/test_models_custom.py` (append)

- [ ] **Step 1: Append failing tests** to `tests/test_models_custom.py`:

```python
import pytest


def _make_model_dir(p):
    p.mkdir()
    (p / "config.json").write_text(json.dumps({"model_type": "qwen2_5_vl"}))
    return p


def test_add_and_remove_custom_model(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "cm.json")
    model_dir = _make_model_dir(tmp_path / "mymodel")
    res = server._add_custom_model(str(model_dir))
    assert res["added"] == str(model_dir.resolve())
    assert str(model_dir.resolve()) in server._all_models()
    server._remove_custom_model(str(model_dir))
    assert str(model_dir.resolve()) not in server._all_models()


def test_add_custom_model_rejects_non_model(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CUSTOM_MODELS_PATH", tmp_path / "cm.json")
    with pytest.raises(ValueError):
        server._add_custom_model(str(tmp_path))
```

- [ ] **Step 2: Run — expect fail**

Run: `.venv/bin/python -m pytest tests/test_models_custom.py -q`
Expected: FAIL — no `_add_custom_model`.

- [ ] **Step 3: Add add/remove logic**

In `backend/server.py`, right AFTER `_all_models` (from Task 1), add:
```python
def _add_custom_model(path: str) -> dict:
    """Zwaliduj i zapisz własny model. Rzuca ValueError z czytelnym powodem."""
    resolved = Path(path).expanduser().resolve()
    info = _model_dir_info(resolved)
    if not info["ok"]:
        raise ValueError(info["reason"])
    data = _load_named(CUSTOM_MODELS_PATH)
    data[str(resolved)] = info["label"]
    _save_named(CUSTOM_MODELS_PATH, data)
    return {"added": str(resolved), "label": info["label"]}


def _remove_custom_model(path: str) -> None:
    resolved = str(Path(path).expanduser().resolve())
    data = _load_named(CUSTOM_MODELS_PATH)
    if resolved in data:
        del data[resolved]
        _save_named(CUSTOM_MODELS_PATH, data)
```

NOTE: `_save_named` is defined later (~line 818) — fine, resolved at call time.

- [ ] **Step 4: Run — expect pass**

Run: `.venv/bin/python -m pytest tests/test_models_custom.py -q`
Expected: PASS (8 tests).

- [ ] **Step 5: Update `/api/models` to merge custom models**

In `backend/server.py` replace:
```python
@app.get("/api/models")
def api_models():
    return {"models": captioner.AVAILABLE_MODELS, "default": captioner.DEFAULT_MODEL}
```
with:
```python
class CustomModel(BaseModel):
    path: str


@app.get("/api/models")
def api_models():
    return {"models": _all_models(), "default": captioner.DEFAULT_MODEL}


@app.get("/api/fs/list")
def api_fs_list(path: str = ""):
    base = (Path(path).expanduser() if path else Path.home()).resolve()
    if not base.is_dir():
        raise HTTPException(400, f"Nie jest folderem: {base}")
    parent = None if base.parent == base else str(base.parent)
    return {
        "path": str(base),
        "parent": parent,
        "dirs": _list_subdirs(base),
        "is_model": _model_dir_info(base)["ok"],
    }


@app.post("/api/models/custom")
def api_models_custom_add(req: CustomModel):
    try:
        res = _add_custom_model(req.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"models": _all_models(),
            "default": captioner.DEFAULT_MODEL,
            "added": res["added"]}


@app.delete("/api/models/custom")
def api_models_custom_remove(req: CustomModel):
    _remove_custom_model(req.path)
    return {"models": _all_models(), "default": captioner.DEFAULT_MODEL}
```

- [ ] **Step 6: Full suite + import check**

Run:
```bash
.venv/bin/python -m pytest -q
.venv/bin/python -c "import backend.server"
```
Expected: all PASS (34 total); import OK.

- [ ] **Step 7: Commit**

```bash
git add backend/server.py tests/test_models_custom.py
git commit -m "feat: endpoints for browsing folders and custom models

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — add buttons, folder-browser modal, refresh dropdowns

**Files:**
- Modify: `frontend/index.html` (two buttons + modal block)
- Modify: `frontend/app.js` (populateModels refactor + modal logic)

- [ ] **Step 1: Add the "Dodaj model" button in the Dataset model field**

In `frontend/index.html` replace:
```html
        <div class="field">
          <label>Model VLM</label>
          <select id="model"></select>
        </div>
```
with:
```html
        <div class="field">
          <label>Model VLM</label>
          <select id="model"></select>
          <button type="button" id="addModelBtn" class="mini">📁 Dodaj model z folderu</button>
        </div>
```

- [ ] **Step 2: Add the "Dodaj model" button in the Prompts model field**

In `frontend/index.html` replace:
```html
          <div class="field">
            <label>Model</label>
            <select id="pModel"></select>
          </div>
```
with:
```html
          <div class="field">
            <label>Model</label>
            <select id="pModel"></select>
            <button type="button" id="pAddModelBtn" class="mini">📁 Dodaj model z folderu</button>
          </div>
```

- [ ] **Step 3: Add the folder-browser modal**

In `frontend/index.html`, insert BETWEEN the closing `</div>` of the gallery modal (line ending the `id="galModal"` block) and `<script src="/app.js"></script>`:
```html
  <!-- Przeglądarka folderów: wybór folderu z modelem Qwen2.5-VL -->
  <div id="fsModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-box">
      <button id="fsCancel" class="modal-x" title="Zamknij (Esc)">✕</button>
      <h3>Wybierz folder z modelem</h3>
      <div class="row">
        <button id="fsUp" class="mini">⬆ Wyżej</button>
        <code id="fsPath" class="muted"></code>
      </div>
      <ul id="fsList" class="fs-list"></ul>
      <p id="fsMsg" class="info"></p>
      <div class="row">
        <button id="fsPick" class="btn primary" disabled>Wybierz ten folder</button>
      </div>
      <label class="modal-label">Zapamiętane własne modele</label>
      <ul id="fsSaved" class="fs-list"></ul>
    </div>
  </div>

```

- [ ] **Step 4: Add minimal CSS for the folder list**

In `frontend/style.css`, append at the end:
```css
.fs-list { list-style: none; margin: 8px 0; padding: 0; max-height: 320px;
           overflow: auto; border: 1px solid var(--border, #333); border-radius: 6px; }
.fs-list li { padding: 6px 10px; cursor: pointer; display: flex;
              justify-content: space-between; align-items: center; }
.fs-list li:hover { background: rgba(127,127,127,0.12); }
.fs-list li .rm { cursor: pointer; opacity: 0.7; }
```

- [ ] **Step 5: Refactor model-dropdown filling into `populateModels`**

In `frontend/app.js` replace the init IIFE (lines ~27-44):
```javascript
(async function init() {
  try {
    const { models, default: def } = await api("/api/models");
    for (const selId of ["model", "pModel"]) {
      const sel = $(selId);
      if (!sel) continue;
      for (const [id, label] of Object.entries(models)) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = label;
        if (id === def) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  } catch (e) {
    console.error(e);
  }
})();
```
with:
```javascript
function populateModels(models, def, selectKey) {
  for (const selId of ["model", "pModel"]) {
    const sel = $(selId);
    if (!sel) continue;
    const prev = selectKey || sel.value;
    sel.innerHTML = "";
    for (const [id, label] of Object.entries(models)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    const want = (prev && models[prev]) ? prev : def;
    if (want) sel.value = want;
  }
}

(async function init() {
  try {
    const { models, default: def } = await api("/api/models");
    populateModels(models, def);
    renderSavedModels(models, def);
  } catch (e) {
    console.error(e);
  }
})();
```

NOTE: built-in vs custom distinction in the saved list is done by key shape — built-in keys are HF ids like "Qwen/Qwen2.5-VL-7B-Instruct" (no leading slash), custom keys are absolute paths (leading "/"). `renderSavedModels` (next step) uses `id.startsWith("/")` to detect custom entries.

- [ ] **Step 6: Add modal logic + saved list**

In `frontend/app.js`, append at the end of the file:
```javascript
// --------------------------------------------------------------------------- //
// Przeglądarka folderów + własne modele
// --------------------------------------------------------------------------- //
let fsCurrent = null;

function renderSavedModels(models, def) {
  const ul = $("fsSaved");
  if (!ul) return;
  ul.innerHTML = "";
  const custom = Object.entries(models).filter(([id]) => id.startsWith("/"));
  if (!custom.length) {
    ul.innerHTML = '<li class="muted">— brak —</li>';
    return;
  }
  for (const [id, label] of custom) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = label;
    name.title = id;
    const rm = document.createElement("span");
    rm.className = "rm";
    rm.textContent = "✕";
    rm.title = "Usuń z listy";
    rm.onclick = async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch("/api/models/custom", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: id }),
        });
        const data = await res.json();
        populateModels(data.models, data.default);
        renderSavedModels(data.models, data.default);
      } catch (err) { console.error(err); }
    };
    li.appendChild(name);
    li.appendChild(rm);
    ul.appendChild(li);
  }
}

async function fsBrowse(path) {
  try {
    const q = path ? ("?path=" + encodeURIComponent(path)) : "";
    const data = await api("/api/fs/list" + q);
    fsCurrent = data.path;
    $("fsPath").textContent = data.path;
    $("fsUp").disabled = !data.parent;
    $("fsUp").dataset.parent = data.parent || "";
    $("fsPick").disabled = !data.is_model;
    $("fsMsg").textContent = data.is_model
      ? "✓ Ten folder zawiera model — można go wybrać."
      : "Wejdź w folder zawierający model (config.json).";
    const ul = $("fsList");
    ul.innerHTML = "";
    for (const name of data.dirs) {
      const li = document.createElement("li");
      li.textContent = "📁 " + name;
      li.onclick = () => fsBrowse(data.path.replace(/\/$/, "") + "/" + name);
      ul.appendChild(li);
    }
    if (!data.dirs.length) ul.innerHTML = '<li class="muted">— brak podfolderów —</li>';
  } catch (e) {
    $("fsMsg").textContent = "Błąd: " + e.message;
  }
}

function openFsModal() {
  $("fsModal").classList.remove("hidden");
  fsBrowse("");  // brak ścieżki -> backend startuje w katalogu domowym
}
function closeFsModal() { $("fsModal").classList.add("hidden"); }

if ($("addModelBtn")) $("addModelBtn").onclick = openFsModal;
if ($("pAddModelBtn")) $("pAddModelBtn").onclick = openFsModal;
if ($("fsCancel")) $("fsCancel").onclick = closeFsModal;
if ($("fsUp")) $("fsUp").onclick = () => fsBrowse($("fsUp").dataset.parent || "");
if ($("fsPick")) $("fsPick").onclick = async () => {
  try {
    const data = await api("/api/models/custom", { path: fsCurrent });
    populateModels(data.models, data.default, data.added);
    renderSavedModels(data.models, data.default);
    closeFsModal();
  } catch (e) {
    let msg = e.message;
    try { msg = JSON.parse(e.message).detail || msg; } catch (_) {}
    $("fsMsg").textContent = "Nie dodano: " + msg;
  }
};
```

- [ ] **Step 7: Static verification**

Run:
```bash
grep -n 'id="addModelBtn"\|id="fsModal"\|id="fsSaved"' frontend/index.html
grep -n 'function populateModels\|function fsBrowse\|renderSavedModels' frontend/app.js
grep -n '.fs-list' frontend/style.css
```
Expected: each returns matches.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/app.js frontend/style.css
git commit -m "feat: folder-browser modal to add custom models (both tabs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification on live server

**Files:** brak (weryfikacja manualna/curl)

- [ ] **Step 1: Restart server**

Run:
```bash
cd ~/wsl/flux-lora-prep
pkill -9 -f "uvicorn backend.server" 2>/dev/null; sleep 1
./run.sh > .work/server.log 2>&1 &
sleep 4 && curl -sf -o /dev/null http://127.0.0.1:8023/ && echo UP
```
Expected: `UP`.

- [ ] **Step 2: Browse endpoint works**

Run:
```bash
curl -s "http://127.0.0.1:8023/api/fs/list" | python3 -m json.tool | head
```
Expected: JSON with `path` (home dir), `dirs` list, `is_model: false`.

- [ ] **Step 3: Add a fake model dir and confirm it appears**

Run:
```bash
M=~/wsl/flux-lora-prep/.work/fakemodel
mkdir -p "$M"; echo '{"model_type":"qwen2_5_vl"}' > "$M/config.json"
curl -s -X POST http://127.0.0.1:8023/api/models/custom -H 'Content-Type: application/json' \
  -d "{\"path\":\"$M\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('added' in d, d['added'] in d['models'])"
curl -s http://127.0.0.1:8023/api/models | python3 -c "import sys,json;print([k for k in json.load(sys.stdin)['models'] if k.startswith('/')])"
```
Expected: `True True`; the fakemodel path listed.

- [ ] **Step 4: Rejection of non-model folder**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8023/api/models/custom \
  -H 'Content-Type: application/json' -d "{\"path\":\"/tmp\"}"
```
Expected: `400`.

- [ ] **Step 5: Persistence across restart**

Run:
```bash
cat .work/custom_models.json
pkill -9 -f "uvicorn backend.server" 2>/dev/null; sleep 1
./run.sh > .work/server.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:8023/api/models | python3 -c "import sys,json;print(any(k.startswith('/') for k in json.load(sys.stdin)['models']))"
```
Expected: `custom_models.json` contains the entry; after restart prints `True`.

- [ ] **Step 6: Delete works, then clean up the fake**

Run:
```bash
M=~/wsl/flux-lora-prep/.work/fakemodel
curl -s -X DELETE http://127.0.0.1:8023/api/models/custom -H 'Content-Type: application/json' \
  -d "{\"path\":\"$M\"}" > /dev/null && echo "delete sent"
curl -s http://127.0.0.1:8023/api/models | python3 -c "import sys,json;print([k for k in json.load(sys.stdin)['models'] if k.startswith('/')])"
rm -rf "$M"
```
Expected: after delete the custom list is empty `[]`.

- [ ] **Step 7: UI smoke test (manual)**

Otwórz http://127.0.0.1:8023 → w Dataset i w Generatorze promptów widać „📁 Dodaj model z folderu"; klik otwiera modal; nawigacja po folderach działa; w folderze z modelem „Wybierz ten folder" jest aktywny; po dodaniu model jest na obu listach; ✕ w „Zapamiętane" usuwa go.

---

## Self-review (autor planu)

- **Pokrycie spec:** trwałość+`CUSTOM_MODELS_PATH` (T1/T2), `/api/fs/list` (T2), `_model_dir_info` walidacja Qwen2.5-VL (T1), add/remove+`/api/models/custom` (T2), scalanie `/api/models` (T2), modal+przyciski+oba dropdowny+zapamiętane (T3), bezpieczeństwo (tylko podkatalogi — `_list_subdirs`), e2e+persistencja+delete (T4). Wszystkie 6 kryteriów akceptacji mają task.
- **Brak placeholderów:** każdy krok ma pełny kod/komendę i oczekiwany wynik.
- **Spójność typów:** `_list_subdirs`, `_model_dir_info`(→{ok,reason,label}), `_all_models`, `_add_custom_model`(→{added,label}), `_remove_custom_model`, `CustomModel{path}`, oraz front `populateModels`/`refreshModels`/`renderSavedModels`/`fsBrowse` użyte spójnie między taskami.

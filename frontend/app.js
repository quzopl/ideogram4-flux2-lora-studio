"use strict";

const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || res.statusText);
  }
  return res.json();
};

let state = {
  folder: null,
  count: 0,
  jobId: null,
  deleted: new Set(), // indices of photos removed by the user
};

// --------------------------------------------------------------------------- //
// Init: load model list
// --------------------------------------------------------------------------- //
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
    const cfg = await api("/api/lmstudio");
    if ($("lmstudioUrl")) $("lmstudioUrl").value = cfg.url;
  } catch (e) {
    console.error(e);
  }
})();

// --------------------------------------------------------------------------- //
// GPU status + releasing models from memory
// --------------------------------------------------------------------------- //
const shortModel = (m) => (m ? m.split("/").pop() : "");

function applyGpu(g) {
  const el = $("gpuStatus");
  const btn = $("unloadBtn");
  if (!g.cuda) {
    el.textContent = "GPU: brak CUDA (CPU)";
    btn.disabled = true;
    return;
  }
  const vram = g.vram_total_gb
    ? ` · VRAM ${g.vram_used_gb}/${g.vram_total_gb} GB`
    : "";
  if (g.loaded) {
    el.textContent = `Model: ${shortModel(g.model)} (${g.quant})${vram}`;
    el.className = "info ok";
    btn.disabled = false;
  } else {
    el.textContent = `Model not loaded${vram}`;
    el.className = "info";
    btn.disabled = true;
  }
}

async function refreshGpu() {
  try {
    applyGpu(await api("/api/gpu"));
  } catch (e) {
    console.error(e);
  }
}

$("unloadBtn").addEventListener("click", async () => {
  const btn = $("unloadBtn");
  btn.disabled = true;
  $("gpuStatus").textContent = "Releasing GPU memory…";
  $("gpuStatus").className = "info";
  try {
    applyGpu(await api("/api/unload", {}));
  } catch (e) {
    $("gpuStatus").textContent = "Error: " + e.message;
    $("gpuStatus").className = "info err";
    refreshGpu();
  }
});

refreshGpu();

// --------------------------------------------------------------------------- //
// Top navigation (Dataset <-> Prompt studio)
// --------------------------------------------------------------------------- //
// Generic switching by "view-<name>" id — new views (modules) need no
// changes here beyond an optional activation hook.
function switchView(view) {
  document.querySelectorAll(".navtab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll('main > div[id^="view-"]').forEach((div) =>
    div.classList.toggle("hidden", div.id !== "view-" + view));
  if (view === "comfy") { loadComfyConfig(); loadEditorWorkflowFromServer(); }
  if (view === "bbox" && window.BboxEditor) window.BboxEditor.onShow();
}
window.switchView = switchView;

document.querySelectorAll(".navtab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

// --------------------------------------------------------------------------- //
// Tabs
// --------------------------------------------------------------------------- //
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    $("pane-folder").classList.toggle("hidden", name !== "folder");
    $("pane-upload").classList.toggle("hidden", name !== "upload");
  });
});

// --------------------------------------------------------------------------- //
// Source: scan folder
// --------------------------------------------------------------------------- //
$("scanBtn").addEventListener("click", async () => {
  const folder = $("folderPath").value.trim();
  if (!folder) return;
  setSrcInfo("Skanowanie…");
  try {
    const r = await api("/api/scan", { folder });
    state.folder = r.folder;
    state.count = r.count;
    setSrcInfo(`Found ${r.count} images in: ${r.folder}`, "ok");
    $("processBtn").disabled = r.count === 0;
  } catch (e) {
    setSrcInfo("Error: " + e.message, "err");
    $("processBtn").disabled = true;
  }
});

// --------------------------------------------------------------------------- //
// Source: upload
// --------------------------------------------------------------------------- //
const dropzone = $("dropzone");
dropzone.addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => uploadFiles(e.target.files));
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); })
);
dropzone.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

async function uploadFiles(fileList) {
  if (!fileList || !fileList.length) return;
  setSrcInfo("Uploading " + fileList.length + " files…");
  const fd = new FormData();
  for (const f of fileList) fd.append("files", f);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const r = await res.json();
    state.folder = r.folder;
    state.count = r.count;
    setSrcInfo(`Uploaded ${r.count} images.`, "ok");
    $("processBtn").disabled = r.count === 0;
  } catch (e) {
    setSrcInfo("Upload error: " + e.message, "err");
  }
}

function setSrcInfo(msg, cls) {
  const el = $("srcInfo");
  el.textContent = msg;
  el.className = "info" + (cls ? " " + cls : "");
}

// --------------------------------------------------------------------------- //
// Process
// --------------------------------------------------------------------------- //
$("processBtn").addEventListener("click", async () => {
  if (!state.folder) return;
  const req = {
    folder: state.folder,
    mode: $("mode").value,
    style: $("style").value,
    resolution: parseInt($("resolution").value, 10),
    step: parseInt($("step").value, 10),
    square: $("square").value === "true",
    fmt: $("fmt").value,
    jpg_quality: parseInt($("jpgQuality").value, 10),
    model: $("model").value,
    quant: $("quant").value,
    max_tokens: parseInt($("maxTokens").value, 10),
    do_caption: $("doCaption").checked,
    caption_format: $("captionFormat").value,
  };

  $("processBtn").disabled = true;
  $("progressCard").classList.remove("hidden");
  $("resultsCard").classList.add("hidden");
  $("exportCard").classList.add("hidden");
  $("results").innerHTML = "";       // clear previous results
  state.deleted = new Set();          // and the removed list
  setProgress(0, "Start…");

  try {
    const { job_id, total } = await api("/api/process", req);
    state.jobId = job_id;
    pollJob(job_id, total);
  } catch (e) {
    setProgress(0, "Error: " + e.message, "err");
    $("processBtn").disabled = false;
  }
});

async function pollJob(jobId, total) {
  try {
    const job = await api("/api/job/" + jobId);

    if (job.state === "loading_model") {
      setProgress(2, job.current || "Loading the model…");
    } else if (job.state === "processing" || job.state === "pending") {
      const pct = total ? Math.round((job.processed / total) * 100) : 0;
      setProgress(pct, `Przetworzono ${job.processed}/${total} — ${job.current}`);
      renderResults(job);
    } else if (job.state === "done") {
      setProgress(100, `Done: ${job.processed} images.`, "ok");
      renderResults(job);
      $("exportCard").classList.remove("hidden");
      $("processBtn").disabled = false;
      refreshGpu();
      return;
    } else if (job.state === "error") {
      setProgress(0, "Processing error: " + job.error, "err");
      $("processBtn").disabled = false;
      return;
    }
    setTimeout(() => pollJob(jobId, total), 1000);
  } catch (e) {
    setProgress(0, "Error: " + e.message, "err");
    $("processBtn").disabled = false;
  }
}

function setProgress(pct, text, cls) {
  $("progressBar").style.width = pct + "%";
  const el = $("progressText");
  el.textContent = text;
  el.className = "info" + (cls ? " " + cls : "");
}

// --------------------------------------------------------------------------- //
// Results grid
// --------------------------------------------------------------------------- //
function renderResults(job) {
  const container = $("results");
  if (!job.results.length) return;
  $("resultsCard").classList.remove("hidden");

  for (const r of job.results) {
    let card = document.getElementById("res-" + r.idx);
    if (!card) {
      card = document.createElement("div");
      card.className = "result";
      card.id = "res-" + r.idx;
      card.innerHTML = `
        <button class="del" title="Remove this photo from the dataset" data-idx="${r.idx}">✕</button>
        <img src="/api/thumb/${job.id}/${r.idx}" loading="lazy" />
        <div class="meta">
          <span>${r.out_name || r.src_name}</span>
          <span>${r.width}×${r.height}</span>
        </div>
        <div class="trigprefix" data-idx="${r.idx}"></div>
        <textarea data-idx="${r.idx}" placeholder="(opis)"></textarea>`;
      container.appendChild(card);
      // Set caption once; don't clobber user edits on subsequent polls.
      card.querySelector("textarea").value = r.caption || "";

      // Removing a photo from the dataset.
      card.querySelector(".del").addEventListener("click", () => {
        state.deleted.add(r.idx);
        card.remove();
        updateExportCount();
      });
    }
  }
  updateTriggerPreviews();
  updateExportCount();
}

// Live preview of the trigger word prepended to every caption.
function updateTriggerPreviews() {
  const trigger = $("trigger").value.trim();
  const on = $("prependTrigger").checked && trigger;
  document.querySelectorAll("#results .trigprefix").forEach((el) => {
    if (on) {
      el.textContent = "trigger: " + trigger + ",";
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });
}

function updateExportCount() {
  const total = document.querySelectorAll("#results .result").length;
  const el = $("exportCount");
  if (el) {
    const removed = state.deleted.size;
    el.textContent =
      `To export: ${total} images` + (removed ? ` (${removed} removed).` : ".");
  }
}

// Refresh the trigger preview when the field or checkbox changes.
$("trigger").addEventListener("input", updateTriggerPreviews);
$("prependTrigger").addEventListener("change", updateTriggerPreviews);

// --------------------------------------------------------------------------- //
// Export
// --------------------------------------------------------------------------- //
// Collects the shared export payload (captions, trigger, removed indices).
function exportPayload() {
  const captions = {};
  document.querySelectorAll("#results textarea").forEach((ta) => {
    captions[ta.dataset.idx] = ta.value;
  });
  return {
    job_id: state.jobId,
    trigger: $("trigger").value.trim(),
    prepend_trigger: $("prependTrigger").checked,
    captions,
    exclude_idx: Array.from(state.deleted),
  };
}

$("exportBtn").addEventListener("click", async () => {
  const output = $("outputFolder").value.trim();
  if (!output) { setExportInfo("Enter a destination folder.", "err"); return; }
  if (!state.jobId) return;

  setExportInfo("Eksportowanie…");
  try {
    const r = await api("/api/export", { ...exportPayload(), output_folder: output });
    setExportInfo(`Saved ${r.written} pairs (image + .txt) to: ${r.output_folder}`, "ok");
  } catch (e) {
    setExportInfo("Export error: " + e.message, "err");
  }
});

// Download the whole dataset as a .zip.
$("zipBtn").addEventListener("click", async () => {
  if (!state.jobId) return;
  setExportInfo("Pakowanie do .zip…");
  try {
    const res = await fetch("/api/zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportPayload()),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^"]+)"?/);
    const fname = m ? m[1] : "dataset.zip";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportInfo(`Downloaded: ${fname}`, "ok");
  } catch (e) {
    setExportInfo("Packaging error: " + e.message, "err");
  }
});

function setExportInfo(msg, cls) {
  const el = $("exportInfo");
  el.textContent = msg;
  el.className = "info" + (cls ? " " + cls : "");
}

// --------------------------------------------------------------------------- //
// Prompt studio
// --------------------------------------------------------------------------- //
let pAction = "expand";

const P_PLACEHOLDERS = {
  expand: "e.g. a woman with red hair in a cafe",
  refine: "e.g. woman, red hair, cafe, masterpiece, best quality, 8k, detailed",
};

// Target-format label for the hint (depends on the dropdown).
function _promptFormatLabel() {
  const f = $("promptFormat") ? $("promptFormat").value : "flux";
  if (f === "ideogram") return "Ideogram 4 (JSON)";
  if (f === "aitoolkit") return "ai-toolkit (JSON)";
  return "FLUX.2";
}

// Hint depends on the action (expand/refine) and the selected target format.
function updatePHint() {
  const fmt = _promptFormatLabel();
  const hint = pAction === "refine"
    ? `Paste a longer/existing prompt — the model will clean it up and adapt it to: ${fmt}.`
    : `Type a short idea and the model will expand it into a full prompt: ${fmt}.`;
  if ($("pHint")) $("pHint").textContent = hint;
  if ($("pInput")) $("pInput").placeholder = P_PLACEHOLDERS[pAction];
}

document.querySelectorAll(".ptab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".ptab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    pAction = tab.dataset.action;
    updatePHint();
  });
});
if ($("promptFormat")) $("promptFormat").addEventListener("change", updatePHint);
updatePHint();

async function generatePrompt() {
  const text = $("pInput").value.trim();
  if (!text) { setPStatus("Type a prompt to process.", "err"); return; }

  $("pGenBtn").disabled = true;
  $("pRegenBtn").disabled = true;
  setPStatus("Generating… (first use loads the model)", "");
  try {
    const r = await api("/api/prompt", {
      text,
      action: pAction,
      subject: $("pSubject").value,
      model: $("pModel").value,
      quant: $("pQuant").value,
      max_tokens: parseInt($("pMaxTokens").value, 10),
      caption_format: $("promptFormat").value,
      elements_detail: $("pElemDetail") ? $("pElemDetail").value : "balanced",
      desc_detail: $("pDescDetail") ? $("pDescDetail").value : "balanced",
    });
    $("pOutput").value = r.prompt;
    $("pResultCard").classList.remove("hidden");
    if (window.renderStudioWarnings) window.renderStudioWarnings(r.warnings);
    updateToCanvasBtn();
    setPStatus("Done. Saved to the library.", "ok");
    loadPromptLib();
  } catch (e) {
    setPStatus("Error: " + e.message, "err");
  } finally {
    $("pGenBtn").disabled = false;
    $("pRegenBtn").disabled = false;
    refreshGpu();
  }
}

$("pGenBtn").addEventListener("click", generatePrompt);
$("pRegenBtn").addEventListener("click", generatePrompt);

$("pCopyBtn").addEventListener("click", async () => {
  const txt = $("pOutput").value;
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    setPStatus("Copied to clipboard.", "ok");
  } catch {
    $("pOutput").select();
    document.execCommand("copy");
    setPStatus("Copied.", "ok");
  }
});

$("pUseBtn").addEventListener("click", () => {
  const txt = $("pOutput").value.trim();
  if (!txt) return;
  $("pInput").value = txt;
  // Editing an existing prompt => switch to "Refine" mode.
  document.querySelector('.ptab[data-action="refine"]').click();
  $("pInput").focus();
  setPStatus("Moved the result to the input.", "");
});

// "Edit on canvas" — JSON formats only (Ideogram/ai-toolkit).
function updateToCanvasBtn() {
  const fmt = $("promptFormat") ? $("promptFormat").value : "flux";
  if ($("pToCanvasBtn")) $("pToCanvasBtn").classList.toggle("hidden", fmt === "flux");
}
if ($("pToCanvasBtn")) $("pToCanvasBtn").addEventListener("click", () => {
  const txt = $("pOutput").value.trim();
  if (!txt || !window.BboxEditor) return;
  switchView("bbox");
  window.BboxEditor.open(txt);
});
if ($("promptFormat")) $("promptFormat").addEventListener("change", updateToCanvasBtn);

function setPStatus(msg, cls) {
  const el = $("pStatus");
  el.textContent = msg;
  el.className = "info" + (cls ? " " + cls : "");
}

// --------------------------------------------------------------------------- //
// 📚 Prompt library (SQLite on the backend)
// --------------------------------------------------------------------------- //
let pLibCat = "all";

function setPLibStatus(msg, cls) {
  const el = $("pLibStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "info" + (cls ? " " + cls : "");
}

async function copyTextToClipboard(txt) {
  try {
    await navigator.clipboard.writeText(txt);
  } catch {
    // Fallback dla http:// bez clipboard API — tymczasowa textarea.
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function renderPromptLib(items) {
  const list = $("pLibList");
  if (!list) return;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "info";
    empty.textContent = "The library is empty — generate your first prompt above.";
    list.appendChild(empty);
    return;
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "plib-item";

    const badge = document.createElement("span");
    badge.className = "plib-badge " + it.category;
    badge.textContent = it.category === "ideogram" ? "Ideogram JSON" : "FLUX.2";

    const body = document.createElement("div");
    body.className = "plib-body";
    const text = document.createElement("div");
    text.className = "plib-text";
    text.textContent = it.prompt;
    text.title = "Click to expand/collapse";
    text.addEventListener("click", () => text.classList.toggle("expanded"));
    const meta = document.createElement("div");
    meta.className = "plib-meta";
    const when = new Date(it.created * 1000).toLocaleString("pl-PL");
    meta.textContent = `#${it.id} · ${when}` + (it.input_text ? ` · „${it.input_text.slice(0, 60)}”` : "");
    body.appendChild(text);
    body.appendChild(meta);

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋 Copy";
    copyBtn.title = "Copy the whole prompt to clipboard";
    copyBtn.addEventListener("click", async () => {
      await copyTextToClipboard(it.prompt);
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 1500);
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.title = "Delete from the library";
    delBtn.addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/prompts/library/${it.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(await res.text());
        loadPromptLib();
      } catch (e) {
        setPLibStatus("Delete error: " + e.message, "err");
      }
    });

    const btns = document.createElement("div");
    btns.className = "plib-btns";
    btns.appendChild(copyBtn);
    if (it.category === "ideogram" && window.BboxEditor) {
      const canvasBtn = document.createElement("button");
      canvasBtn.textContent = "🧩";
      canvasBtn.title = "Open in the bbox editor";
      canvasBtn.addEventListener("click", () => {
        switchView("bbox");
        window.BboxEditor.open(it.prompt);
      });
      btns.appendChild(canvasBtn);
    }
    btns.appendChild(delBtn);

    row.appendChild(badge);
    row.appendChild(body);
    row.appendChild(btns);
    list.appendChild(row);
  }
}

async function loadPromptLib() {
  if (!$("pLibList")) return;
  try {
    const r = await api(`/api/prompts/library?category=${pLibCat}`);
    renderPromptLib(r.prompts);
    setPLibStatus(`Items: ${r.prompts.length}`, "");
  } catch (e) {
    setPLibStatus("Library load error: " + e.message, "err");
  }
}

document.querySelectorAll(".plibtab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".plibtab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    pLibCat = tab.dataset.cat;
    loadPromptLib();
  });
});

if ($("pLibExportBtn")) $("pLibExportBtn").addEventListener("click", () => {
  // Pobranie pliku .sql zgodnie z aktywnym filtrem kategorii.
  window.location.href = `/api/prompts/library/export?category=${pLibCat}`;
});

if ($("pLibRefreshBtn")) $("pLibRefreshBtn").addEventListener("click", loadPromptLib);
loadPromptLib();

// --------------------------------------------------------------------------- //
// 🎨 ComfyUI: konfiguracja, biblioteki, generacja z progress + preview, galeria
// --------------------------------------------------------------------------- //
const cInfo = (id, msg, cls) => {
  const el = $(id);
  if (!el) return;
  el.textContent = msg || "";
  el.className = "info" + (cls ? " " + cls : "");
};

let comfyMapping = null;
let comfyLoras = [];          // full LoRA list from /api/comfy/loras
let comfyLoraSlots = 0;       // how many LoRA loaders the mapping detected
let comfyJobId = null;
let comfyJobTimer = null;

async function loadComfyConfig() {
  try {
    const c = await api("/api/comfy/config");
    $("cUrl").value = c.url || "http://127.0.0.1:8188";
    if (c.has_workflow && c.mapping) {
      comfyMapping = c.mapping;
      comfyLoraSlots = (c.mapping.lora_nodes || []).length;
      $("cMapping").value = JSON.stringify(c.mapping, null, 2);
      $("cMappingBox").classList.remove("hidden");
      cInfo("cWorkflowInfo",
        `Workflow in memory: ${c.workflow_node_count} nodes, ${comfyLoraSlots} LoRA slot(s). Upload another one to replace it.`,
        "ok");
      ensureLoraRows();
    } else {
      $("cMappingBox").classList.add("hidden");
      cInfo("cWorkflowInfo", "Brak wgranego workflow.", "");
    }
  } catch (e) {
    cInfo("cUrlInfo", "Config load error: " + e.message, "err");
  }
  await Promise.all([refreshMappingLib(), refreshPromptLib(), refreshGallery(), refreshEdLib()]);
}

// ---- URL + connection test ---- //
$("cUrlSave").addEventListener("click", async () => {
  try {
    const r = await api("/api/comfy/url", { url: $("cUrl").value.trim() });
    cInfo("cUrlInfo", "Saved: " + r.url, "ok");
  } catch (e) { cInfo("cUrlInfo", "Error: " + e.message, "err"); }
});

$("cTest").addEventListener("click", async () => {
  cInfo("cUrlInfo", "Connecting to ComfyUI…");
  try {
    const r = await api("/api/comfy/test", {});
    const v = r.stats?.system?.comfyui_version || r.stats?.system?.os || "ok";
    cInfo("cUrlInfo", `Connected to ${r.url} (${v}).`, "ok");
  } catch (e) { cInfo("cUrlInfo", "No connection: " + e.message, "err"); }
});

// ---- Workflow upload (drop + click) ---- //
const cDz = $("cDropzone");
cDz.addEventListener("click", () => $("cFileInput").click());
$("cFileInput").addEventListener("change", (e) => uploadWorkflow(e.target.files?.[0]));
["dragover", "dragenter"].forEach((ev) =>
  cDz.addEventListener(ev, (e) => { e.preventDefault(); cDz.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  cDz.addEventListener(ev, (e) => { e.preventDefault(); cDz.classList.remove("drag"); })
);
cDz.addEventListener("drop", (e) => uploadWorkflow(e.dataTransfer.files?.[0]));

async function uploadWorkflow(file) {
  if (!file) return;
  cInfo("cWorkflowInfo", `Loading ${file.name}…`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/comfy/workflow", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const r = await res.json();
    comfyMapping = r.mapping;
    comfyLoraSlots = (r.mapping.lora_nodes || []).length;
    $("cMapping").value = JSON.stringify(r.mapping, null, 2);
    $("cMappingBox").classList.remove("hidden");
    const src = r.source === "png" ? "z metadanych PNG" : "z pliku JSON";
    cInfo("cWorkflowInfo",
      `Loaded workflow ${src}: ${r.node_count} nodes, ${comfyLoraSlots} LoRA slot(s).`,
      "ok");
    if (r.current_prompt && !$("cPrompt").value.trim()) {
      $("cPrompt").value = r.current_prompt;  // auto-wpis aktualnego promptu
    }
    ensureLoraRows();
  } catch (e) {
    cInfo("cWorkflowInfo", "Error: " + e.message, "err");
  }
}

// ---- Active mapping save ---- //
$("cMappingSave").addEventListener("click", async () => {
  let parsed;
  try { parsed = JSON.parse($("cMapping").value); }
  catch (e) { cInfo("cMappingInfo", "Niepoprawny JSON: " + e.message, "err"); return; }
  try {
    const r = await api("/api/comfy/mapping", { mapping: parsed });
    comfyMapping = r.mapping;
    comfyLoraSlots = (r.mapping.lora_nodes || []).length;
    ensureLoraRows();
    cInfo("cMappingInfo", "Mapping saved.", "ok");
  } catch (e) { cInfo("cMappingInfo", "Save error: " + e.message, "err"); }
});

// ---- Mapping library ---- //
async function refreshMappingLib() {
  try {
    const r = await api("/api/comfy/mappings");
    const sel = $("cMappingLib");
    sel.innerHTML = '<option value="">— saved mappings —</option>';
    for (const name of Object.keys(r.items || {})) {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    }
  } catch (e) { console.error(e); }
}

$("cMappingLibSave").addEventListener("click", async () => {
  const name = $("cMappingLibName").value.trim();
  if (!name) { cInfo("cMappingInfo", "Enter a name.", "err"); return; }
  let value;
  try { value = JSON.parse($("cMapping").value); }
  catch (e) { cInfo("cMappingInfo", "Niepoprawny JSON: " + e.message, "err"); return; }
  try {
    await api("/api/comfy/mappings", { name, value });
    $("cMappingLibName").value = "";
    await refreshMappingLib();
    cInfo("cMappingInfo", `Saved "${name}".`, "ok");
  } catch (e) { cInfo("cMappingInfo", "Error: " + e.message, "err"); }
});

$("cMappingLibLoad").addEventListener("click", async () => {
  const name = $("cMappingLib").value;
  if (!name) return;
  try {
    const r = await api("/api/comfy/mappings");
    const m = r.items[name];
    if (!m) return;
    $("cMapping").value = JSON.stringify(m, null, 2);
    await api("/api/comfy/mapping", { mapping: m });
    comfyMapping = m;
    comfyLoraSlots = (m.lora_nodes || []).length;
    ensureLoraRows();
    cInfo("cMappingInfo", `Loaded "${name}".`, "ok");
  } catch (e) { cInfo("cMappingInfo", "Error: " + e.message, "err"); }
});

$("cMappingLibDel").addEventListener("click", async () => {
  const name = $("cMappingLib").value;
  if (!name) return;
  if (!confirm(`Delete mapping "${name}"?`)) return;
  try {
    await fetch("/api/comfy/mappings/" + encodeURIComponent(name), { method: "DELETE" });
    await refreshMappingLib();
    cInfo("cMappingInfo", `Deleted "${name}".`, "ok");
  } catch (e) { cInfo("cMappingInfo", "Error: " + e.message, "err"); }
});

// ---- Prompt library ---- //
async function refreshPromptLib() {
  try {
    const r = await api("/api/comfy/prompts");
    const sel = $("cPromptLib");
    sel.innerHTML = '<option value="">— saved prompts —</option>';
    for (const name of Object.keys(r.items || {})) {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    }
  } catch (e) { console.error(e); }
}

$("cPromptLibSave").addEventListener("click", async () => {
  const name = $("cPromptLibName").value.trim();
  if (!name) { cInfo("cLoraStatus", "Enter a prompt name.", "err"); return; }
  const value = $("cPrompt").value.trim();
  if (!value) { cInfo("cLoraStatus", "Najpierw wpisz prompt.", "err"); return; }
  try {
    await api("/api/comfy/prompts", { name, value });
    $("cPromptLibName").value = "";
    await refreshPromptLib();
    cInfo("cLoraStatus", `Saved prompt "${name}".`, "ok");
  } catch (e) { cInfo("cLoraStatus", "Error: " + e.message, "err"); }
});

$("cPromptLibLoad").addEventListener("click", async () => {
  const name = $("cPromptLib").value;
  if (!name) return;
  try {
    const r = await api("/api/comfy/prompts");
    if (r.items[name] != null) $("cPrompt").value = r.items[name];
  } catch (e) { cInfo("cLoraStatus", "Error: " + e.message, "err"); }
});

$("cPromptLibDel").addEventListener("click", async () => {
  const name = $("cPromptLib").value;
  if (!name) return;
  if (!confirm(`Delete prompt "${name}"?`)) return;
  try {
    await fetch("/api/comfy/prompts/" + encodeURIComponent(name), { method: "DELETE" });
    await refreshPromptLib();
    cInfo("cLoraStatus", `Deleted "${name}".`, "ok");
  } catch (e) { cInfo("cLoraStatus", "Error: " + e.message, "err"); }
});

// ---- LoRA list + search + stack ---- //
async function refreshLoras() {
  cInfo("cLoraStatus", "Fetching the LoRA list from ComfyUI…");
  try {
    const r = await api("/api/comfy/loras");
    comfyLoras = r.loras || [];
    const dl = $("cLoraDatalist");
    dl.innerHTML = "";
    for (const name of comfyLoras) {
      const opt = document.createElement("option");
      opt.value = name;
      dl.appendChild(opt);
    }
    $("cLoraCount").textContent = `(${comfyLoras.length} available)`;
    cInfo("cLoraStatus", `Znaleziono ${comfyLoras.length} LoRA.`, "ok");
    // Re-bind datalist to all rows.
    document.querySelectorAll(".lora-row input").forEach((i) =>
      i.setAttribute("list", "cLoraDatalist")
    );
  } catch (e) { cInfo("cLoraStatus", "LoRA list error: " + e.message, "err"); }
}
$("cLoraRefresh").addEventListener("click", refreshLoras);

// The search box filters the datalist (matching names only).
$("cLoraSearch").addEventListener("input", () => {
  const q = $("cLoraSearch").value.toLowerCase();
  const dl = $("cLoraDatalist");
  dl.innerHTML = "";
  for (const name of comfyLoras) {
    if (!q || name.toLowerCase().includes(q)) {
      const opt = document.createElement("option");
      opt.value = name;
      dl.appendChild(opt);
    }
  }
});

function loraRowsCount() {
  return $("cLoraRows").querySelectorAll(".lora-row").length;
}

function addLoraRow(initial = "") {
  if (loraRowsCount() >= Math.max(comfyLoraSlots, 1)) {
    cInfo("cLoraStatus",
      `The workflow has only ${comfyLoraSlots} LoRA loader(s). Add more LoRA loaders in ComfyUI to stack more.`,
      "err");
    return;
  }
  const row = document.createElement("div");
  row.className = "lora-row";
  row.innerHTML = `
    <input type="text" list="cLoraDatalist" placeholder="pick or type a name…" value="${initial}" />
    <button class="lora-del danger" title="Remove this slot">−</button>`;
  row.querySelector(".lora-del").addEventListener("click", () => row.remove());
  $("cLoraRows").appendChild(row);
}

function ensureLoraRows() {
  const rows = $("cLoraRows");
  rows.innerHTML = "";
  if (comfyLoraSlots > 0) addLoraRow();
}

$("cLoraAdd").addEventListener("click", () => addLoraRow());

function collectLoras() {
  return Array.from($("cLoraRows").querySelectorAll(".lora-row input"))
    .map((i) => i.value.trim());
}

// ---- Progress formatting: speed (it/s) + ETA ---- //
function fmtEta(sec) {
  sec = Math.round(sec);
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60), r = sec % 60;
  if (m < 60) return m + "m " + (r < 10 ? "0" : "") + r + "s";
  const h = Math.floor(m / 60), mm = m % 60;
  return h + "h " + (mm < 10 ? "0" : "") + mm + "m";
}
function fmtProgress(p) {
  if (!p) return "";
  const parts = [];
  if (p.max) parts.push(`${p.value || 0}/${p.max}`);
  if (p.speed > 0) parts.push(`${p.speed.toFixed(2)} it/s`);
  if (p.eta > 0) parts.push(`~${fmtEta(p.eta)} left`);
  return parts.length ? "  ·  " + parts.join("  ·  ") : "";
}

// ---- Generation: async job + progress + preview ---- //
function setJobUi(active) {
  $("cJobBox").classList.toggle("hidden", !active);
  $("cGenLoraCancel").classList.toggle("hidden", !active);
  $("cGenLoraBtn").disabled = active;
}

function startJobPolling(jobId, onDone) {
  comfyJobId = jobId;
  setJobUi(true);
  if (comfyJobTimer) clearInterval(comfyJobTimer);
  comfyJobTimer = setInterval(async () => {
    try {
      const j = await api("/api/comfy/job/" + jobId);
      const p = j.progress || {};
      $("cJobStatus").textContent = (j.current || j.state) + fmtProgress(p);
      const pct = p.max > 0 ? Math.round((p.value / p.max) * 100) : 0;
      $("cJobBar").style.width = pct + "%";
      if (j.has_preview) {
        $("cPrevWrap").classList.remove("hidden");
        $("cPrevImg").src = `/api/comfy/job/${jobId}/preview?t=${j.preview_ts}`;
      }
      if (j.state === "done" || j.state === "error" || j.state === "cancelled") {
        clearInterval(comfyJobTimer);
        comfyJobTimer = null;
        comfyJobId = null;
        setJobUi(false);
        if (j.state === "error") cInfo("cLoraStatus", "Error: " + j.error, "err");
        else if (j.state === "cancelled") cInfo("cLoraStatus", "Anulowano.", "");
        else cInfo("cLoraStatus", `Done: ${j.images.length} image(s).`, "ok");
        await refreshGallery();
        onDone?.(j);
      }
    } catch (e) {
      cInfo("cLoraStatus", "Polling error: " + e.message, "err");
      clearInterval(comfyJobTimer); comfyJobTimer = null;
      setJobUi(false);
    }
  }, 700);
}

$("cGenLoraBtn").addEventListener("click", async () => {
  const prompt = $("cPrompt").value.trim();
  if (!prompt) { cInfo("cLoraStatus", "Wpisz prompt.", "err"); return; }
  const seed = parseInt($("cSeed").value, 10);
  try {
    const { job_id } = await api("/api/comfy/generate", {
      prompt,
      loras: collectLoras(),
      width: parseInt($("cWidth").value, 10),
      height: parseInt($("cHeight").value, 10),
      steps: parseInt($("cSteps").value, 10),
      cfg: parseFloat($("cCfg").value),
      seed: seed < 0 ? null : seed,
      batch: parseInt($("cBatch").value, 10),
    });
    cInfo("cLoraStatus", "Zakolejkowano w ComfyUI — czekam na obrazy…", "");
    startJobPolling(job_id);
  } catch (e) {
    cInfo("cLoraStatus", "Error: " + e.message, "err");
  }
});

$("cGenLoraCancel").addEventListener("click", async () => {
  if (!comfyJobId) return;
  try { await fetch("/api/comfy/job/" + comfyJobId + "/cancel", { method: "POST" }); }
  catch (e) { console.error(e); }
});

// ---- Reference batch: sequencyjnie ten sam endpoint generate ---- //
let refCancel = false;

$("cGenRefBtn").addEventListener("click", async () => {
  const lines = $("cRefPrompts").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { cInfo("cRefStatus", "Dodaj co najmniej jeden prompt.", "err"); return; }
  const w = parseInt($("cRefWidth").value, 10);
  const h = parseInt($("cRefHeight").value, 10);
  const steps = parseInt($("cRefSteps").value, 10);
  const cfg = parseFloat($("cRefCfg").value);
  $("cGenRefBtn").disabled = true;
  $("cGenRefCancel").classList.remove("hidden");
  refCancel = false;

  for (let i = 0; i < lines.length && !refCancel; i++) {
    cInfo("cRefStatus", `Generating ${i + 1}/${lines.length}: "${lines[i].slice(0, 60)}…"`);
    try {
      const { job_id } = await api("/api/comfy/generate", {
        prompt: lines[i], width: w, height: h, steps, cfg, batch: 1,
      });
      // poll inline
      while (true) {
        if (refCancel) {
          try { await fetch("/api/comfy/job/" + job_id + "/cancel", { method: "POST" }); }
          catch {}
          break;
        }
        const j = await api("/api/comfy/job/" + job_id);
        if (j.state === "done" || j.state === "error" || j.state === "cancelled") {
          if (j.state === "error") throw new Error(j.error);
          break;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      await refreshGallery();
    } catch (e) {
      cInfo("cRefStatus", `Error: ${e.message}`, "err");
      $("cGenRefBtn").disabled = false;
      $("cGenRefCancel").classList.add("hidden");
      return;
    }
  }
  cInfo("cRefStatus", refCancel ? "Cancelled." : `Done: ${lines.length}.`, "ok");
  $("cGenRefBtn").disabled = false;
  $("cGenRefCancel").classList.add("hidden");
});

$("cGenRefCancel").addEventListener("click", () => { refCancel = true; });

// ---- Gallery (accumulating, from disk via /api/comfy/gallery) ---- //
async function refreshGallery() {
  try {
    const r = await api("/api/comfy/gallery");
    const c = $("cGallery");
    c.innerHTML = "";
    for (const im of r.items || []) {
      const card = document.createElement("div");
      card.className = "result simple";
      const promptShort = (im.prompt || "").slice(0, 70) + ((im.prompt || "").length > 70 ? "…" : "");
      const img = document.createElement("img");
      img.src = im.url;
      img.loading = "lazy";
      img.title = "Click to see the prompt";
      img.addEventListener("click", () => openGalModal(im));
      const del = document.createElement("button");
      del.className = "del";
      del.title = "Delete";
      del.textContent = "✕";
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete this image?")) return;
        await fetch("/api/comfy/gallery/" + im.id, { method: "DELETE" });
        refreshGallery();
      });
      const meta = document.createElement("div");
      meta.className = "meta";
      const s1 = document.createElement("span");
      s1.title = im.prompt || "";
      s1.textContent = promptShort || im.filename;
      const s2 = document.createElement("span");
      s2.textContent = "seed: " + im.seed;
      meta.append(s1, s2);
      card.append(del, img, meta);
      c.appendChild(card);
    }
  } catch (e) { console.error(e); }
}
$("cGalRefresh").addEventListener("click", refreshGallery);

// ---- Lightbox: full image + prompt + download ---- //
let galCurrent = null;
function openGalModal(im) {
  galCurrent = im;
  $("galImg").src = im.url;
  $("galPrompt").value = im.prompt || "(brak promptu)";
  $("galSeed").textContent = "seed: " + (im.seed ?? "—");
  $("galSource").textContent = im.source === "editor" ? "edytor" : "test LoRA";
  $("galFile").textContent = im.filename || "";
  const lb = $("galLoras");
  lb.innerHTML = "";
  for (const l of im.loras || []) {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = "LoRA: " + (typeof l === "string" ? l : (l.lora || JSON.stringify(l)));
    lb.appendChild(t);
  }
  const dl = $("galDownload");
  dl.href = im.url;
  dl.setAttribute("download", (im.filename || im.id || "obraz") + (/\.\w+$/.test(im.filename || "") ? "" : ".png"));
  $("galModal").classList.remove("hidden");
}
function closeGalModal() { $("galModal").classList.add("hidden"); galCurrent = null; }
$("galClose").addEventListener("click", closeGalModal);
$("galModal").querySelector(".modal-backdrop").addEventListener("click", closeGalModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("galModal").classList.contains("hidden")) closeGalModal();
});
$("galCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("galPrompt").value); $("galCopy").textContent = "✓ copied"; setTimeout(() => $("galCopy").textContent = "📋 copy", 1500); }
  catch { $("galPrompt").select(); document.execCommand("copy"); }
});
$("galDelete").addEventListener("click", async () => {
  if (!galCurrent || !confirm("Delete this image?")) return;
  await fetch("/api/comfy/gallery/" + galCurrent.id, { method: "DELETE" });
  closeGalModal();
  refreshGallery();
});

// --------------------------------------------------------------------------- //
// 📝 Edytor workflow: node-cards z parametrami + SVG graf
// --------------------------------------------------------------------------- //
const editor = {
  workflow: null,        // {id: {class_type, inputs: {...}}}
  objectInfo: null,      // {class_type: {input: {required, optional}, ...}}
  knownEnums: null,      // {field_name: [choices...]} — union of enums across all nodes
  mode: "list",          // "list" | "hybrid"
  jobId: null,
  jobTimer: null,
};

document.querySelectorAll(".etab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".etab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    editor.mode = tab.dataset.etab;
    $("cEdGraphPane").classList.toggle("hidden", editor.mode !== "hybrid");
    if (editor.mode === "hybrid" && editor.workflow) renderEditorGraph();
  });
});

// Dropzone (klik + drag)
const cEdDz = $("cEdDropzone");
cEdDz.addEventListener("click", () => $("cEdFileInput").click());
$("cEdFileInput").addEventListener("change", (e) => uploadEditorWorkflow(e.target.files?.[0]));
["dragover", "dragenter"].forEach((ev) =>
  cEdDz.addEventListener(ev, (e) => { e.preventDefault(); cEdDz.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  cEdDz.addEventListener(ev, (e) => { e.preventDefault(); cEdDz.classList.remove("drag"); })
);
cEdDz.addEventListener("drop", (e) => uploadEditorWorkflow(e.dataTransfer.files?.[0]));

async function fetchObjectInfo({ force = false } = {}) {
  if (editor.objectInfo && !force) return;
  try {
    editor.objectInfo = await api("/api/comfy/object_info");
    editor.knownEnums = buildKnownEnums(editor.objectInfo);
    cInfo("cEdInfo",
      `ComfyUI schemas: ${Object.keys(editor.objectInfo).length} node types, ${Object.keys(editor.knownEnums).length} fields with dropdowns.`,
      "ok");
  } catch (e) {
    cInfo("cEdInfo",
      "Note: /object_info unavailable (" + e.message + "). Start ComfyUI and click ↻ Schemas to get dropdowns for lora/model/sampler.",
      "");
  }
}

// Collects the union of enums from the whole /object_info — a field with the
// same name across nodes usually shares the allowed values (e.g. lora_name).
function buildKnownEnums(info) {
  const map = {};
  for (const node of Object.values(info || {})) {
    const ins = node.input || {};
    for (const section of ["required", "optional"]) {
      const fields = ins[section] || {};
      for (const [fname, spec] of Object.entries(fields)) {
        if (Array.isArray(spec) && Array.isArray(spec[0])) {
          (map[fname] ||= new Set());
          for (const c of spec[0]) map[fname].add(String(c));
        }
      }
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = [...v].sort();
  return out;
}

// Gdy schemy dla danej klasy nie ma (custom node), zgadnij dropdown po nazwie pola.
function getSchemaForName(fname) {
  if (!editor.knownEnums) return null;
  if (editor.knownEnums[fname]) return [editor.knownEnums[fname], {}];
  const ln = fname.toLowerCase();
  if (ln.includes("lora") && editor.knownEnums.lora_name)
    return [editor.knownEnums.lora_name, {}];
  if ((ln.includes("ckpt") || ln.includes("checkpoint") || ln === "model")
      && editor.knownEnums.ckpt_name)
    return [editor.knownEnums.ckpt_name, {}];
  if (ln.includes("unet") && editor.knownEnums.unet_name)
    return [editor.knownEnums.unet_name, {}];
  if (ln.includes("vae") && editor.knownEnums.vae_name)
    return [editor.knownEnums.vae_name, {}];
  if (ln.includes("clip_name") && editor.knownEnums.clip_name1)
    return [editor.knownEnums.clip_name1, {}];
  if (ln.includes("sampler") && editor.knownEnums.sampler_name)
    return [editor.knownEnums.sampler_name, {}];
  if (ln.includes("scheduler") && editor.knownEnums.scheduler)
    return [editor.knownEnums.scheduler, {}];
  return null;
}

async function loadEditorWorkflowFromServer() {
  try {
    const r = await api("/api/comfy/editor/workflow");
    if (r.workflow) {
      editor.workflow = r.workflow;
      await fetchObjectInfo();
      renderEditorAll();
      cInfo("cEdInfo", `Loaded the workflow from the last session: ${r.node_count} nodes.`, "");
    }
  } catch (e) {
    console.error(e);
  }
}

async function uploadEditorWorkflow(file) {
  if (!file) return;
  cInfo("cEdInfo", `Loading ${file.name}…`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/comfy/editor/load", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const r = await res.json();
    editor.workflow = r.workflow;
    await fetchObjectInfo();
    renderEditorAll();
    const src = r.source === "png" ? "z metadanych PNG" : "z pliku JSON";
    cInfo("cEdInfo", `Loaded workflow ${src}: ${r.node_count} nodes.`, "ok");
  } catch (e) {
    cInfo("cEdInfo", "Error: " + e.message, "err");
  }
}

function renderEditorAll() {
  $("cEdActions").style.display = editor.workflow ? "flex" : "none";
  $("cEdLibBar").style.display = editor.workflow ? "flex" : "none";
  $("cEdFilterBar").classList.toggle("hidden", !editor.workflow);
  renderEditorNodes();
  if (editor.mode === "hybrid") renderEditorGraph();
}

// ---- Renderowanie node-cards ---- //
function getSchema(classType, fieldName) {
  if (!editor.objectInfo) return null;
  const node = editor.objectInfo[classType];
  if (!node) return null;
  const ins = node.input || {};
  return (ins.required || {})[fieldName] || (ins.optional || {})[fieldName] || null;
}

function isLinkValue(v) { return Array.isArray(v) && v.length >= 2 && typeof v[0] !== "object"; }
function isDictValue(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function renderEditorNodes() {
  const container = $("cEdNodes");
  container.innerHTML = "";
  if (!editor.workflow) return;
  // Stable sort by numeric ID when possible, alphabetically otherwise.
  const ids = Object.keys(editor.workflow).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
  for (const id of ids) {
    container.appendChild(renderNodeCard(id, editor.workflow[id]));
  }
}

function renderNodeCard(id, node) {
  const card = document.createElement("div");
  card.className = "ed-node";
  card.id = `edn-${id}`;
  card.dataset.nodeId = id;
  card.dataset.classType = node.class_type || "";

  const head = document.createElement("div");
  head.className = "ed-node-h";
  head.innerHTML = `
    <span class="ed-id">#${id}</span>
    <span class="ed-class"></span>
    <span class="ed-chev"></span>`;
  head.querySelector(".ed-class").textContent = node.class_type || "(unknown)";
  head.addEventListener("click", () => card.classList.toggle("collapsed"));
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "ed-body";
  card.appendChild(body);

  const inputs = node.inputs || {};
  // Show all editable (literal) fields first, then links/CONNECTION.
  const fields = Object.entries(inputs);
  const editable = fields.filter(([, v]) => !isLinkValue(v));
  const links = fields.filter(([, v]) => isLinkValue(v));

  for (const [fname, value] of editable) {
    body.appendChild(renderEditableField(id, node.class_type, fname, value));
  }
  for (const [fname, value] of links) {
    body.appendChild(renderLinkField(id, fname, value));
  }
  // Schema-only "CONNECTION" inputs not wired in the workflow → skip (nothing to edit).
  return card;
}

function renderEditableField(id, classType, fname, value) {
  const row = document.createElement("div");
  row.className = "ed-field";
  const lab = document.createElement("label");
  lab.textContent = fname;
  row.appendChild(lab);

  // Dict-input (np. rgthree Power Lora Loader: lora_1 = {on, lora, strength, ...}).
  // Render every key as a sub-field with its own control + nested commit.
  if (isDictValue(value)) {
    const wrap = document.createElement("div");
    wrap.className = "ed-dict";
    const keys = Object.keys(value);
    if (!keys.length) {
      const empty = document.createElement("div");
      empty.className = "ed-link-only";
      empty.textContent = "(pusty obiekt)";
      wrap.appendChild(empty);
    }
    for (const k of keys) {
      const sub = document.createElement("div");
      sub.className = "ed-dict-row";
      const sl = document.createElement("label");
      sl.textContent = k;
      sub.appendChild(sl);
      const subVal = value[k];
      if (isDictValue(subVal) || (Array.isArray(subVal) && !isLinkValue(subVal))) {
        // deeper dict / list — JSON text fallback
        const ta = document.createElement("textarea");
        ta.value = JSON.stringify(subVal, null, 2);
        ta.addEventListener("change", () => {
          try { editor.workflow[id].inputs[fname][k] = JSON.parse(ta.value); }
          catch (e) { /* zostaw poprzednie */ }
        });
        sub.appendChild(ta);
      } else {
        const ctrl = makeControl(subVal, getSchemaForName(k), (nv) => {
          editor.workflow[id].inputs[fname] = editor.workflow[id].inputs[fname] || {};
          editor.workflow[id].inputs[fname][k] = nv;
        });
        sub.appendChild(ctrl);
      }
      wrap.appendChild(sub);
    }
    row.appendChild(wrap);
    return row;
  }

  const schema = getSchema(classType, fname) || getSchemaForName(fname);
  const ctrl = makeControl(value, schema, (nv) => {
    editor.workflow[id].inputs[fname] = nv;
  });
  row.appendChild(ctrl);
  return row;
}

// Builds the edit control for one value. schema = one of the /object_info specs
// (np. ["INT", {min,max,step}], [["a","b"], {}]) albo null = wnioskuj z typu.
function makeControl(value, schema, onChange) {
  let ctrl, parser;

  if (schema && Array.isArray(schema[0])) {
    // Enum (dropdown)
    ctrl = document.createElement("select");
    const choices = schema[0];
    let sval = value == null ? "" : String(value);
    // ComfyUI lists paths with forward slashes; a workflow saved on Windows
    // bywa z "\" (np. LORA-flux2\plik.safetensors) → ComfyUI go nie znajdzie.
    // If the value matches the list after switching to "/", use the fixed one and save.
    if (sval && !choices.includes(sval) && choices.includes(sval.replace(/\\/g, "/"))) {
      sval = sval.replace(/\\/g, "/");
      onChange(sval);
    }
    let hasCurrent = false;
    for (const opt of choices) {
      const o = document.createElement("option");
      o.value = String(opt);
      o.textContent = String(opt);
      if (String(opt) === sval) { o.selected = true; hasCurrent = true; }
      ctrl.appendChild(o);
    }
    // If the workflow value is missing from the current list (e.g. a lora you
    // deleted from disk), keep it at the top of the list so it doesn't get lost.
    if (!hasCurrent && sval) {
      const o = document.createElement("option");
      o.value = sval;
      o.textContent = sval + "  (z workflow)";
      o.selected = true;
      ctrl.prepend(o);
    }
    parser = () => ctrl.value;
  } else if (schema && schema[0] === "BOOLEAN") {
    ctrl = document.createElement("input");
    ctrl.type = "checkbox";
    ctrl.checked = !!value;
    parser = () => ctrl.checked;
  } else if (schema && (schema[0] === "INT" || schema[0] === "FLOAT")) {
    ctrl = document.createElement("input");
    ctrl.type = "number";
    const meta = schema[1] || {};
    if (meta.min !== undefined) ctrl.min = meta.min;
    if (meta.max !== undefined && meta.max < 1e15) ctrl.max = meta.max;
    if (meta.step !== undefined) ctrl.step = meta.step;
    else if (schema[0] === "FLOAT") ctrl.step = "0.01";
    if (value !== null && value !== undefined) ctrl.value = value;
    parser = () => {
      if (ctrl.value === "") return null;
      const n = schema[0] === "INT" ? parseInt(ctrl.value, 10) : parseFloat(ctrl.value);
      return isNaN(n) ? null : n;
    };
  } else if (schema && schema[0] === "STRING") {
    const multi = (schema[1] || {}).multiline === true
      || (typeof value === "string" && (value.length > 60 || value.includes("\n")));
    ctrl = document.createElement(multi ? "textarea" : "input");
    if (ctrl.tagName === "INPUT") ctrl.type = "text";
    ctrl.value = value ?? "";
    parser = () => ctrl.value;
  } else if (typeof value === "boolean") {
    ctrl = document.createElement("input");
    ctrl.type = "checkbox";
    ctrl.checked = value;
    parser = () => ctrl.checked;
  } else if (typeof value === "number") {
    ctrl = document.createElement("input");
    ctrl.type = "number";
    const isFloat = !Number.isInteger(value);
    ctrl.step = isFloat ? "0.01" : "1";
    ctrl.value = value;
    parser = () => {
      if (ctrl.value === "") return null;
      const n = isFloat ? parseFloat(ctrl.value) : parseInt(ctrl.value, 10);
      return isNaN(n) ? null : n;
    };
  } else if (value === null || value === undefined) {
    ctrl = document.createElement("input");
    ctrl.type = "text";
    ctrl.placeholder = "(null)";
    parser = () => (ctrl.value === "" ? null : ctrl.value);
  } else {
    const s = String(value);
    const multi = s.length > 60 || s.includes("\n");
    ctrl = document.createElement(multi ? "textarea" : "input");
    if (ctrl.tagName === "INPUT") ctrl.type = "text";
    ctrl.value = s;
    parser = () => ctrl.value;
  }

  const fire = () => {
    const v = parser();
    if (v !== undefined) onChange(v);
  };
  ctrl.addEventListener("change", fire);
  ctrl.addEventListener("input", fire);
  return ctrl;
}

function renderLinkField(id, fname, value) {
  const row = document.createElement("div");
  row.className = "ed-field";
  const lab = document.createElement("label");
  lab.textContent = fname;
  row.appendChild(lab);

  const ref = document.createElement("div");
  ref.className = "ed-link";
  const srcId = String(value[0]);
  const srcNode = editor.workflow?.[srcId];
  const srcType = srcNode ? srcNode.class_type : "?";
  ref.textContent = `→ #${srcId} (${srcType}) · output ${value[1]}`;
  ref.title = "Click to jump to the source";
  ref.addEventListener("click", () => focusNode(srcId));
  row.appendChild(ref);
  return row;
}

function focusNode(id) {
  const card = document.getElementById(`edn-${id}`);
  if (!card) return;
  if (card.classList.contains("collapsed")) card.classList.remove("collapsed");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1500);
  document.querySelectorAll(".ed-graph-node.active").forEach((n) => n.classList.remove("active"));
  const gn = document.querySelector(`.ed-graph-node[data-node-id="${id}"]`);
  if (gn) gn.classList.add("active");
}

// ---- Filtr nazw / typu / ID ---- //
$("cEdFilter").addEventListener("input", () => {
  const q = $("cEdFilter").value.toLowerCase().trim();
  document.querySelectorAll(".ed-node").forEach((card) => {
    if (!q) { card.classList.remove("dim"); return; }
    const match = card.dataset.nodeId.toLowerCase().includes(q)
      || (card.dataset.classType || "").toLowerCase().includes(q);
    card.classList.toggle("dim", !match);
  });
});
$("cEdExpandAll").addEventListener("click", () =>
  document.querySelectorAll(".ed-node").forEach((c) => c.classList.remove("collapsed"))
);
$("cEdCollapseAll").addEventListener("click", () =>
  document.querySelectorAll(".ed-node").forEach((c) => c.classList.add("collapsed"))
);

// ---- SVG graf z toposort ---- //
function layoutGraph(wf) {
  const ids = Object.keys(wf);
  const incoming = {};
  for (const id of ids) {
    incoming[id] = [];
    const ins = wf[id].inputs || {};
    for (const v of Object.values(ins)) {
      if (isLinkValue(v) && wf[String(v[0])]) incoming[id].push(String(v[0]));
    }
  }
  // Longest path from the sources = layer.
  const layer = {};
  function depth(id, stack) {
    if (layer[id] !== undefined) return layer[id];
    if (stack.has(id)) return 0;  // cykl — defensywnie
    stack.add(id);
    const ups = incoming[id];
    const d = ups.length ? Math.max(...ups.map((u) => depth(u, new Set(stack)))) + 1 : 0;
    layer[id] = d;
    return d;
  }
  for (const id of ids) depth(id, new Set());
  const byLayer = {};
  for (const id of ids) (byLayer[layer[id]] ||= []).push(id);
  // Sort within a layer by numeric ID, for stability.
  for (const k in byLayer) byLayer[k].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  const NODE_W = 170, NODE_H = 36, COL_GAP = 60, ROW_GAP = 24, MARGIN = 12;
  const pos = {};
  for (const [l, list] of Object.entries(byLayer)) {
    list.forEach((id, i) => {
      pos[id] = {
        x: MARGIN + parseInt(l, 10) * (NODE_W + COL_GAP),
        y: MARGIN + i * (NODE_H + ROW_GAP),
      };
    });
  }
  return { pos, NODE_W, NODE_H };
}

function renderEditorGraph() {
  const container = $("cEdGraph");
  container.innerHTML = "";
  if (!editor.workflow) return;
  const { pos, NODE_W, NODE_H } = layoutGraph(editor.workflow);
  const xs = Object.values(pos).map((p) => p.x + NODE_W);
  const ys = Object.values(pos).map((p) => p.y + NODE_H);
  const W = Math.max(...xs, 200) + 16;
  const H = Math.max(...ys, 100) + 16;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  // Links first, so they sit under the nodes.
  for (const [id, node] of Object.entries(editor.workflow)) {
    const ins = node.inputs || {};
    for (const v of Object.values(ins)) {
      if (!isLinkValue(v)) continue;
      const srcId = String(v[0]);
      if (!pos[srcId] || !pos[id]) continue;
      const a = pos[srcId], b = pos[id];
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
      const x2 = b.x, y2 = b.y + NODE_H / 2;
      const cp = Math.max(30, Math.abs(x2 - x1) * 0.4);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "ed-link-path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`);
      svg.appendChild(path);
    }
  }

  for (const [id, node] of Object.entries(editor.workflow)) {
    const p = pos[id];
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "ed-graph-node");
    g.setAttribute("transform", `translate(${p.x}, ${p.y})`);
    g.dataset.nodeId = id;
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("width", NODE_W);
    rect.setAttribute("height", NODE_H);
    rect.setAttribute("rx", 6);
    g.appendChild(rect);
    const t1 = document.createElementNS(NS, "text");
    t1.setAttribute("x", 8);
    t1.setAttribute("y", 14);
    t1.textContent = `#${id}`;
    t1.setAttribute("fill", "#9aa3b2");
    g.appendChild(t1);
    const t2 = document.createElementNS(NS, "text");
    t2.setAttribute("x", 8);
    t2.setAttribute("y", 28);
    const label = (node.class_type || "?");
    t2.textContent = label.length > 22 ? label.slice(0, 21) + "…" : label;
    g.appendChild(t2);
    g.addEventListener("click", () => focusNode(id));
    svg.appendChild(g);
  }

  container.appendChild(svg);
}

// ---- Generate ---- //
function setEdJobUi(active) {
  $("cEdJobBox").classList.toggle("hidden", !active);
  $("cEdGenCancel").classList.toggle("hidden", !active);
  $("cEdGenBtn").disabled = active;
}

$("cEdGenBtn").addEventListener("click", async () => {
  if (!editor.workflow) { cInfo("cEdStatus", "No workflow loaded.", "err"); return; }
  try {
    const { job_id } = await api("/api/comfy/editor/generate", { workflow: editor.workflow });
    cInfo("cEdStatus", "Zakolejkowano w ComfyUI — czekam na obrazy…", "");
    startEditorJobPolling(job_id);
  } catch (e) {
    cInfo("cEdStatus", "Error: " + e.message, "err");
  }
});

$("cEdGenCancel").addEventListener("click", async () => {
  if (!editor.jobId) return;
  try { await fetch("/api/comfy/job/" + editor.jobId + "/cancel", { method: "POST" }); }
  catch (e) { console.error(e); }
});

$("cEdReset").addEventListener("click", loadEditorWorkflowFromServer);
$("cEdSchemas").addEventListener("click", async () => {
  cInfo("cEdInfo", "Pobieram /object_info z ComfyUI…");
  await fetchObjectInfo({ force: true });
  if (editor.workflow) renderEditorAll();   // przerenderuj z dropdownami
});

// ---- Saving workflows: .json file + server-side library ---- //
$("cEdSaveFile").addEventListener("click", () => {
  if (!editor.workflow) { cInfo("cEdStatus", "Brak workflow.", "err"); return; }
  const blob = new Blob([JSON.stringify(editor.workflow, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ($("cEdSaveName").value.trim() || "workflow_api") + ".json";
  a.style.display = "none";
  document.body.appendChild(a);   // some browsers require the anchor to be in the DOM
  a.click();
  // revoke + remove dopiero po starcie pobierania
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  cInfo("cEdStatus", `Pobrano ${a.download} (format API ComfyUI).`, "ok");
});

async function refreshEdLib() {
  try {
    const r = await api("/api/comfy/workflows");
    const sel = $("cEdLibSel");
    const prev = sel.value;
    sel.innerHTML = '<option value="">— saved workflows —</option>';
    for (const it of r.items || []) {
      const o = document.createElement("option");
      o.value = it.name;
      o.textContent = it.node_count ? `${it.name} (${it.node_count} nodes)` : it.name;
      sel.appendChild(o);
    }
    if (prev) sel.value = prev;
  } catch (e) { console.error(e); }
}

$("cEdSaveLib").addEventListener("click", async () => {
  if (!editor.workflow) { cInfo("cEdStatus", "Brak workflow.", "err"); return; }
  const name = $("cEdSaveName").value.trim();
  if (!name) { cInfo("cEdStatus", "Enter a workflow name.", "err"); return; }
  try {
    await api("/api/comfy/workflows", { name, value: editor.workflow });
    $("cEdSaveName").value = "";
    await refreshEdLib();
    $("cEdLibSel").value = name;
    cInfo("cEdStatus", `Saved workflow "${name}" to the library.`, "ok");
  } catch (e) { cInfo("cEdStatus", "Save error: " + e.message, "err"); }
});

$("cEdImportBtn").addEventListener("click", () => $("cEdImportFile").click());
$("cEdImportFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const nm = $("cEdSaveName").value.trim();
  if (nm) fd.append("name", nm);
  try {
    cInfo("cEdStatus", "Importing workflow…");
    const res = await fetch("/api/comfy/workflows/import", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const r = await res.json();
    editor.workflow = r.workflow;     // load straight into the editor
    renderEditorAll();
    await refreshEdLib();
    $("cEdLibSel").value = r.name;
    cInfo("cEdStatus", `Imported "${r.name}" (${r.node_count} nodes) and saved to the library.`, "ok");
  } catch (err) {
    cInfo("cEdStatus", "Import error: " + err.message, "err");
  } finally {
    e.target.value = "";   // allow importing the same file again
  }
});

$("cEdLibLoad").addEventListener("click", async () => {
  const name = $("cEdLibSel").value;
  if (!name) { cInfo("cEdStatus", "Wybierz workflow z listy.", "err"); return; }
  try {
    const r = await api("/api/comfy/workflows/" + encodeURIComponent(name));
    editor.workflow = r.workflow;
    renderEditorAll();
    cInfo("cEdStatus", `Loaded "${name}" (${Object.keys(r.workflow).length} nodes).`, "ok");
  } catch (e) { cInfo("cEdStatus", "Load error: " + e.message, "err"); }
});

$("cEdLibDel").addEventListener("click", async () => {
  const name = $("cEdLibSel").value;
  if (!name) return;
  if (!confirm(`Delete workflow "${name}" from the library?`)) return;
  try {
    await fetch("/api/comfy/workflows/" + encodeURIComponent(name), { method: "DELETE" });
    await refreshEdLib();
    cInfo("cEdStatus", `Deleted "${name}".`, "");
  } catch (e) { cInfo("cEdStatus", "Error: " + e.message, "err"); }
});

function startEditorJobPolling(jobId) {
  editor.jobId = jobId;
  setEdJobUi(true);
  if (editor.jobTimer) clearInterval(editor.jobTimer);
  editor.jobTimer = setInterval(async () => {
    try {
      const j = await api("/api/comfy/job/" + jobId);
      const p = j.progress || {};
      $("cEdJobStatus").textContent = (j.current || j.state) + fmtProgress(p);
      const pct = p.max > 0 ? Math.round((p.value / p.max) * 100) : 0;
      $("cEdJobBar").style.width = pct + "%";
      if (j.current_node) {
        // Highlight the currently executing node on the graph.
        document.querySelectorAll(".ed-graph-node.active").forEach((n) => n.classList.remove("active"));
        const gn = document.querySelector(`.ed-graph-node[data-node-id="${j.current_node}"]`);
        if (gn) gn.classList.add("active");
      }
      if (j.has_preview) {
        $("cEdPrevWrap").classList.remove("hidden");
        $("cEdPrevImg").src = `/api/comfy/job/${jobId}/preview?t=${j.preview_ts}`;
      }
      if (j.state === "done" || j.state === "error" || j.state === "cancelled") {
        clearInterval(editor.jobTimer); editor.jobTimer = null; editor.jobId = null;
        setEdJobUi(false);
        if (j.state === "error") cInfo("cEdStatus", "Error: " + j.error, "err");
        else if (j.state === "cancelled") cInfo("cEdStatus", "Anulowano.", "");
        else cInfo("cEdStatus", `Done: ${j.images.length} image(s). Check the gallery.`, "ok");
        await refreshGallery();
      }
    } catch (e) {
      cInfo("cEdStatus", "Polling error: " + e.message, "err");
      clearInterval(editor.jobTimer); editor.jobTimer = null;
      setEdJobUi(false);
    }
  }, 700);
}

// --------------------------------------------------------------------------- //
// Custom model: clicking "Add" opens the system folder picker right away.
// --------------------------------------------------------------------------- //
async function pickModelFolder() {
  try {
    const picked = await api("/api/fs/pick");           // otwiera systemowe okno
    if (picked.cancelled || !picked.path) return;        // anulowano
    const data = await api("/api/models/custom", { path: picked.path });
    populateModels(data.models, data.default, data.added);
    alert("Dodano model: " + (data.models[data.added] || data.added));
  } catch (e) {
    let msg = e.message;
    try { msg = JSON.parse(e.message).detail || msg; } catch (_) {}
    alert("Nie dodano: " + msg);
  }
}

// Remove the currently selected CUSTOM model (key = path, starts with "/").
async function removeCustomModel(selId) {
  const sel = $(selId);
  if (!sel || !sel.value) return;
  const id = sel.value;
  if (!id.startsWith("/")) { alert("To wbudowany model — nie usuwam."); return; }
  if (!confirm("Remove from the list: " + sel.options[sel.selectedIndex].textContent + " ?")) return;
  try {
    const res = await fetch("/api/models/custom", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: id }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    populateModels(data.models, data.default);
  } catch (e) { alert("Delete error: " + e.message); }
}

if ($("addModelBtn")) $("addModelBtn").onclick = pickModelFolder;

async function refreshModels() {
  try {
    if ($("lmstudioUrl")) await api("/api/lmstudio", { url: $("lmstudioUrl").value.trim() });
    const { models, default: def } = await api("/api/models");
    populateModels(models, def);
    alert("Model list refreshed.");
  } catch (e) {
    alert("Refresh error: " + e.message);
  }
}
if ($("refreshModelsBtn")) $("refreshModelsBtn").onclick = refreshModels;
if ($("pAddModelBtn")) $("pAddModelBtn").onclick = pickModelFolder;
if ($("removeModelBtn")) $("removeModelBtn").onclick = () => removeCustomModel("model");
if ($("pRemoveModelBtn")) $("pRemoveModelBtn").onclick = () => removeCustomModel("pModel");

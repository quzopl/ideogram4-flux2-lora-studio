/* =========================================================================== //
// Image -> v15 prompt draft — standalone module. Sends a reference photo to
// /api/ideogram/analyze (Florence-2: scene caption + real bboxes + OCR) and
// loads the returned draft into the bbox editor, where it can be cleaned up,
// refined in the studio or rendered right away.
// =========================================================================== */
"use strict";

(function () {
  const byId = (id) => document.getElementById(id);

  function setStatus(msg, cls) {
    const el = byId("bxStatus");
    if (el) { el.textContent = msg || ""; el.className = "info" + (cls ? " " + cls : ""); }
  }

  // Vision-model picker for the "hybrid" / "vlm" engines — same model list as
  // the captioner/studio (local Qwen, custom folders, LM Studio).
  async function loadModels() {
    const sel = byId("bxImgModel");
    if (!sel || sel.options.length) return;
    try {
      const res = await fetch("/api/models");
      if (!res.ok) return;
      const { models, default: def } = await res.json();
      for (const [id, label] of Object.entries(models || {})) {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = label;
        if (id === def) o.selected = true;
        sel.appendChild(o);
      }
    } catch (_) { /* offline — the default model name still goes through */ }
  }

  function updateModelVisibility() {
    const engine = byId("bxImgEngine") ? byId("bxImgEngine").value : "florence";
    const sel = byId("bxImgModel");
    if (sel) sel.classList.toggle("hidden", engine === "florence");
    if (engine !== "florence") loadModels();
  }

  async function analyze(file) {
    if (!file || !window.BboxEditor) return;
    const btn = byId("bxFromImage");
    const engine = byId("bxImgEngine") ? byId("bxImgEngine").value : "florence";
    btn.disabled = true;
    setStatus("Analyzing the image… First use downloads and loads the model — this can take a while.", "");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("engine", engine);
      if (engine !== "florence" && byId("bxImgModel") && byId("bxImgModel").value) {
        form.append("model", byId("bxImgModel").value);
      }
      const res = await fetch("/api/ideogram/analyze", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const out = await res.json();
      window.BboxEditor.open(out.json);
      setStatus(`Draft ready: ${out.elements} elements (${out.model}). ` +
        "Fix the descriptions on the canvas or run it through the studio (Refine) for full v15 descs.", "ok");
    } catch (e) {
      setStatus("Analysis error: " + e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = byId("bxFromImage"), input = byId("bxFromImageFile");
    if (!btn || !input) return;
    const engineSel = byId("bxImgEngine");
    if (engineSel) engineSel.addEventListener("change", updateModelVisibility);
    updateModelVisibility();
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) analyze(input.files[0]);
      input.value = "";
    });
    // drag&drop an image straight onto the canvas
    const host = document.querySelector("#view-bbox .bxhost");
    if (host) {
      host.addEventListener("dragover", (ev) => ev.preventDefault());
      host.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f && f.type.startsWith("image/")) analyze(f);
      });
    }
  });
})();

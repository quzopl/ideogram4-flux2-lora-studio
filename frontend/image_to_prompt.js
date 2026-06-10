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

  async function analyze(file) {
    if (!file || !window.BboxEditor) return;
    const btn = byId("bxFromImage");
    btn.disabled = true;
    setStatus("Analyzing the image (Florence-2)… First use downloads and loads the model — this can take a while.", "");
    try {
      const form = new FormData();
      form.append("file", file);
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

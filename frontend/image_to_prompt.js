/* =========================================================================== //
// Obraz -> szkic promptu v15 — osobny moduł. Wysyła zdjęcie referencyjne do
// /api/ideogram/analyze (Florence-2: opis sceny + realne bboxy + OCR) i ładuje
// zwrócony szkic do edytora bbox, gdzie można go poprawić i wysłać do studia
// ("Popraw") albo od razu wyrenderować.
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
    setStatus("Analizuję obraz (Florence-2)… Pierwsze użycie pobiera i ładuje model — to może potrwać.", "");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/ideogram/analyze", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const out = await res.json();
      window.BboxEditor.open(out.json);
      setStatus(`Szkic gotowy: ${out.elements} elementów (${out.model}). ` +
        "Popraw opisy na kanwie albo przepuść przez studio („Popraw”) po pełne descy v15.", "ok");
    } catch (e) {
      setStatus("Błąd analizy: " + e.message, "err");
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
    // drag&drop obrazka wprost na kanwę
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

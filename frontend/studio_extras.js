/* =========================================================================== //
// Prompt studio extras — standalone module (pattern: Ideogrammar):
//  - detail controls (element count / desc density) for Ideogram formats,
//  - style presets (era / style / genre) appending an instruction to the input,
//  - shared renderer for v15 lint findings (studio + bbox editor).
// =========================================================================== */
"use strict";

(function () {
  const byId = (id) => document.getElementById(id);

  /* ---- shared v15 findings renderer ---- */
  window.renderV15Findings = function (box, findings) {
    if (!box) return;
    box.innerHTML = "";
    if (!findings || !findings.length) {
      const d = document.createElement("div");
      d.className = "v15item ok";
      d.innerHTML = '<span class="ico">&#10003;</span><span>No warnings — compliant with the v15 guidelines</span>';
      box.appendChild(d);
      return;
    }
    for (const f of findings) {
      const d = document.createElement("div");
      d.className = "v15item " + (f.level === "err" ? "err" : "warn");
      const ico = document.createElement("span");
      ico.className = "ico";
      ico.textContent = f.level === "err" ? "✕" : "!";
      const msg = document.createElement("span");
      msg.textContent = f.msg;
      d.appendChild(ico);
      d.appendChild(msg);
      box.appendChild(d);
    }
  };

  // Warnings from /api/prompt under the studio result (JSON formats only).
  window.renderStudioWarnings = function (warnings) {
    const box = byId("pWarnBox");
    if (!box) return;
    const fmt = byId("promptFormat") ? byId("promptFormat").value : "flux";
    if (fmt === "flux" || warnings === undefined) {
      box.innerHTML = "";
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    window.renderV15Findings(box, warnings || []);
  };

  /* ---- style presets (preserve composition, change content) ---- */
  const PRESETS = {
    era: {
      label: "Era",
      options: ["Mesopotamia", "Ancient Egypt", "Ancient Rome", "Medieval",
        "Renaissance", "Victorian (1890s)", "Roaring 1920s", "1950s Americana",
        "1970s", "1980s", "1990s", "Cyberpunk near-future", "Far future / sci-fi"],
      guide: (v) => `Time travel: keep the exact same composition, framing and element positions, but depict the scene as a period-accurate ${v} version — adjust clothing, technology, vehicles, architecture and materials to that era.`,
    },
    style: {
      label: "Style",
      options: ["Oil painting", "Watercolor", "Anime", "Pixel art", "Comic book",
        "3D render", "Pencil sketch", "Pop art", "Low-poly", "Claymation"],
      guide: (v) => `Re-render the scene in this medium/style: ${v}. Keep the exact same composition and layout; only change the rendering style.`,
    },
    genre: {
      label: "Genre / mood",
      options: ["Cyberpunk", "Film noir", "High fantasy", "Post-apocalyptic", "Vaporwave",
        "Steampunk", "Horror", "Solarpunk", "Western", "Fairy tale"],
      guide: (v) => `Re-theme the scene as ${v}. Keep the exact same composition and layout; restyle the content, lighting and mood to match the theme.`,
    },
  };

  function appendToInput(text) {
    const inp = byId("pInput");
    if (!inp || !text) return;
    inp.value = (inp.value.trim() ? inp.value.trim() + "\n\n" : "") + text;
    inp.focus();
  }

  function buildPresetRow() {
    const host = byId("pPresets");
    if (!host) return;
    for (const key of Object.keys(PRESETS)) {
      const p = PRESETS[key];
      const sel = document.createElement("select");
      sel.title = "Appends a composition-preserving instruction to the prompt";
      const first = document.createElement("option");
      first.value = "";
      first.textContent = p.label + "…";
      sel.appendChild(first);
      for (const o of p.options) {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        appendToInput(p.guide(sel.value));
        sel.value = "";
      });
      host.appendChild(sel);
    }
  }

  /* ---- control visibility depends on the format ---- */
  function updateDetailVisibility() {
    const fmt = byId("promptFormat") ? byId("promptFormat").value : "flux";
    const ideo = fmt === "ideogram" || fmt === "aitoolkit";
    for (const id of ["pElemDetailField", "pDescDetailField"]) {
      const el = byId(id);
      if (el) el.classList.toggle("hidden", !ideo);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    buildPresetRow();
    updateDetailVisibility();
    const fmtSel = byId("promptFormat");
    if (fmtSel) fmtSel.addEventListener("change", updateDetailVisibility);
  });
})();

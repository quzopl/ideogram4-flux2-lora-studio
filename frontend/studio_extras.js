/* =========================================================================== //
// Dodatki studia promptów — osobny moduł (wzór: Ideogrammar):
//  - kontrolki szczegółowości (liczba elementów / gęstość desc) dla Ideogram,
//  - presety stylów (epoka / styl / gatunek) doklejające instrukcję do wejścia,
//  - współdzielony renderer znalezisk lintera v15 (studio + edytor bbox).
// =========================================================================== */
"use strict";

(function () {
  const byId = (id) => document.getElementById(id);

  /* ---- współdzielony renderer znalezisk v15 ---- */
  window.renderV15Findings = function (box, findings) {
    if (!box) return;
    box.innerHTML = "";
    if (!findings || !findings.length) {
      const d = document.createElement("div");
      d.className = "v15item ok";
      d.innerHTML = '<span class="ico">&#10003;</span><span>Brak ostrzeżeń — zgodne z wytycznymi v15</span>';
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

  // Ostrzeżenia z /api/prompt pod wynikiem studia (tylko dla formatów JSON).
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

  /* ---- presety stylów (zachowują kompozycję, zmieniają treść) ---- */
  const PRESETS = {
    era: {
      label: "Epoka",
      options: ["Mezopotamia", "Starożytny Egipt", "Starożytny Rzym", "Średniowiecze",
        "Renesans", "Wiktoriańska (1890s)", "Lata 20.", "Lata 50. (Americana)",
        "Lata 70.", "Lata 80.", "Lata 90.", "Cyberpunk (bliska przyszłość)", "Daleka przyszłość / sci-fi"],
      guide: (v) => `Time travel: keep the exact same composition, framing and element positions, but depict the scene as a period-accurate ${v} version — adjust clothing, technology, vehicles, architecture and materials to that era.`,
    },
    style: {
      label: "Styl",
      options: ["Obraz olejny", "Akwarela", "Anime", "Pixel art", "Komiks",
        "Render 3D", "Szkic ołówkiem", "Pop art", "Low-poly", "Claymation"],
      guide: (v) => `Re-render the scene in this medium/style: ${v}. Keep the exact same composition and layout; only change the rendering style.`,
    },
    genre: {
      label: "Gatunek / nastrój",
      options: ["Cyberpunk", "Film noir", "High fantasy", "Postapokalipsa", "Vaporwave",
        "Steampunk", "Horror", "Solarpunk", "Western", "Baśń"],
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
      sel.title = "Dokleja do promptu instrukcję zachowującą kompozycję";
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

  /* ---- widoczność kontrolek zależna od formatu ---- */
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

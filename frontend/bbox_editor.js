/* =========================================================================== //
// Edytor bbox v15 — osobny moduł (adaptacja samodzielnej appki użytkownika).
// Kanwa 0-1000 [y1,x1,y2,x2], karty obj/text z licznikami słów, z-order,
// import starych/zepsutych JSON-ów, żywy linter v15, zapis do biblioteki.
// API: window.BboxEditor = { open(jsonString), onShow() }
// =========================================================================== */
"use strict";

(function () {
  const ARP = { "1:1": [1, 1], "4:5": [4, 5], "9:16": [9, 16], "16:9": [16, 9], "3:1": [3, 1] };
  let ar = "1:1", hld = "", bg = "", els = [], sel = null, uid = 0, hadLegacyStyle = false;
  const byId = (id) => document.getElementById(id);
  const frame = () => byId("bxFrame");

  /* ---- normalizacja wejścia (wrappery, podwójne kodowanie, size->ratio) ---- */
  function normalize(obj) {
    if (typeof obj === "string") obj = JSON.parse(obj);
    for (const k of ["caption", "data", "result", "output"]) {
      if (obj && typeof obj[k] === "object" && obj[k]
          && (obj[k].compositional_deconstruction || obj[k].high_level_description)) {
        const inner = normalize(obj[k]);
        if (inner.aspect_ratio === undefined && obj.aspect_ratio !== undefined) inner.aspect_ratio = obj.aspect_ratio;
        if (inner.size === undefined && obj.size !== undefined) inner.size = obj.size;
        return inner;
      }
    }
    const hd = obj.high_level_description;
    if (typeof hd === "string" && hd.includes("{") && /high_level_description|compositional_deconstruction/.test(hd)) {
      const s = hd.indexOf("{"), e = hd.lastIndexOf("}");
      if (s !== -1 && e > s) {
        try { const inner = JSON.parse(hd.slice(s, e + 1)); if (inner && inner.compositional_deconstruction) return normalize(inner); } catch (_) {}
      }
    }
    return obj;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  function ratioFromSize(sz) {
    const m = ("" + sz).match(/(\d+)\s*[xX*\s]\s*(\d+)/);
    if (!m) return null;
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!w || !h) return null;
    const g = gcd(w, h);
    return (w / g) + ":" + (h / g);
  }
  function loadCaption(raw) {
    const o = normalize(raw);
    if (typeof o.aspect_ratio === "string" && /^\d+:\d+$/.test(o.aspect_ratio.trim())) setAR(o.aspect_ratio.trim());
    else if (o.size) { const r = ratioFromSize(o.size); if (r) setAR(r); }
    hld = o.high_level_description || "";
    const cd = o.compositional_deconstruction || {};
    bg = cd.background || "";
    els = (cd.elements || []).map((e, i) => {
      uid++;
      return {
        id: uid, type: e.type === "text" ? "text" : "obj",
        hasBbox: Array.isArray(e.bbox) && e.bbox.length === 4,
        bbox: Array.isArray(e.bbox) && e.bbox.length === 4 ? e.bbox.map(Number) : defBbox("obj"),
        desc: e.desc || "", text: e.text || "", z: i + 1,
      };
    });
    hadLegacyStyle = !!(o.style_description && (o.style_description.aesthetics || o.style_description.lighting
      || o.style_description.photo || o.style_description.art_style || o.style_description.color_palette));
    sel = els.length ? els[0].id : null;
  }

  /* ---- kanwa ---- */
  function setAR(val) {
    ar = val;
    if (byId("bxArCustom")) byId("bxArCustom").value = val;
    document.querySelectorAll("#bxAr button").forEach((b) => b.classList.toggle("on", b.dataset.ar === val));
    fitFrame();
  }
  function arRatio() { const m = ar.match(/^(\d+):(\d+)$/); return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [1, 1]; }
  function fitFrame() {
    const f = frame();
    if (!f || !f.parentElement) return;
    const host = f.parentElement, pad = 32, availW = host.clientWidth - pad, availH = Math.max(host.clientHeight - pad, 320), [aw, ah] = arRatio();
    let w = availW, h = w * ah / aw;
    if (h > availH) { h = availH; w = h * aw / ah; }
    f.style.width = Math.max(120, w) + "px";
    f.style.height = Math.max(120, h) + "px";
    render();
  }
  function defBbox(type) {
    const [aw, ah] = arRatio(), wide = aw / ah >= 1.4;
    if (type === "text") return wide ? [120, 300, 300, 700] : [120, 250, 260, 750];
    return wide ? [80, 400, 1000, 620] : (aw / ah <= 0.85 ? [40, 250, 1000, 750] : [60, 300, 1000, 700]);
  }
  const clamp = (v) => Math.max(0, Math.min(1000, v));
  function pxFromBbox(b) {
    const f = frame(), W = f.clientWidth, H = f.clientHeight, [y0, x0, y1, x1] = b;
    return { left: x0 / 1000 * W, top: y0 / 1000 * H, width: (x1 - x0) / 1000 * W, height: (y1 - y0) / 1000 * H };
  }
  function bboxFromPx(left, top, width, height) {
    const f = frame(), W = f.clientWidth, H = f.clientHeight;
    let x0 = clamp(Math.round(left / W * 1000)), y0 = clamp(Math.round(top / H * 1000)),
        x1 = clamp(Math.round((left + width) / W * 1000)), y1 = clamp(Math.round((top + height) / H * 1000));
    if (x1 <= x0) x1 = Math.min(1000, x0 + 10);
    if (y1 <= y0) y1 = Math.min(1000, y0 + 10);
    return [y0, x0, y1, x1];
  }

  function render() {
    const f = frame();
    if (!f) return;
    f.querySelectorAll(".bx").forEach((n) => n.remove());
    els.forEach((e) => {
      if (!e.hasBbox) return;
      const p = pxFromBbox(e.bbox), d = document.createElement("div");
      d.className = "bx " + e.type + (e.id === sel ? " sel" : "");
      d.style.left = p.left + "px"; d.style.top = p.top + "px";
      d.style.width = p.width + "px"; d.style.height = p.height + "px";
      d.style.zIndex = (e.id === sel ? 1000 : e.z);
      d.dataset.id = e.id;
      const tag = e.type === "text" ? ("text: " + (e.text || "…")) : ("obj #" + e.id);
      d.innerHTML = '<span class="tag">' + esc(tag) + '</span><div class="bxh se"></div>';
      f.appendChild(d);
      bindHandle(d, e);
    });
    renderList(); renderJSON(); renderValidation();
  }

  let lastHit = null, lastIdx = 0;
  function onFramePointerDown(ev) {
    if (ev.target.classList.contains("se")) return;
    const f = frame(), r = f.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    const hits = els.filter((e) => {
      if (!e.hasBbox) return false;
      const p = pxFromBbox(e.bbox);
      return px >= p.left && px <= p.left + p.width && py >= p.top && py <= p.top + p.height;
    }).sort((a, b) => area(a) - area(b));
    if (!hits.length) return;
    const key = hits.map((h) => h.id).join(",");
    if (key === lastHit) { lastIdx = (lastIdx + 1) % hits.length; } else { lastHit = key; lastIdx = 0; }
    const chosen = hits[lastIdx];
    selectEl(chosen.id);
    startDrag(chosen, ev, false);
  }
  function area(e) { const [y0, x0, y1, x1] = e.bbox; return (x1 - x0) * (y1 - y0); }
  function startDrag(e, ev, isHandle) {
    const f = frame(), node = f.querySelector('.bx[data-id="' + e.id + '"]');
    if (!node) return;
    const startX = ev.clientX, startY = ev.clientY, o = pxFromBbox(e.bbox);
    const move = (m) => {
      let dx = m.clientX - startX, dy = m.clientY - startY, left = o.left, top = o.top, w = o.width, h = o.height;
      if (isHandle) { w = Math.max(8, o.width + dx); h = Math.max(8, o.height + dy); }
      else { left = o.left + dx; top = o.top + dy; }
      left = Math.max(0, Math.min(f.clientWidth - w, left));
      top = Math.max(0, Math.min(f.clientHeight - h, top));
      node.style.left = left + "px"; node.style.top = top + "px";
      node.style.width = w + "px"; node.style.height = h + "px";
      e.bbox = bboxFromPx(left, top, w, h);
      updateBboxReadout(e);
    };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); renderJSON(); renderValidation(); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  function bindHandle(node, e) {
    const handle = node.querySelector(".se");
    if (handle) handle.addEventListener("pointerdown", (ev) => { if (e.id !== sel) return; ev.stopPropagation(); startDrag(e, ev, true); });
  }
  function selectEl(id) {
    sel = id;
    frame().querySelectorAll(".bx").forEach((n) => {
      const on = n.dataset.id == sel;
      n.classList.toggle("sel", on);
      const e = els.find((x) => x.id == n.dataset.id);
      n.style.zIndex = on ? 1000 : (e ? e.z : 1);
    });
    document.querySelectorAll("#view-bbox .bxcard").forEach((c) => c.classList.toggle("sel", c.dataset.id == sel));
  }
  function updateBboxReadout(e) {
    const c = document.querySelector('#view-bbox .bxcard[data-id="' + e.id + '"] .bxmini');
    if (c && c.childNodes[0]) c.childNodes[0].textContent = e.hasBbox ? ("bbox [" + e.bbox.join(", ") + "] ") : "bez bbox ";
  }
  function bumpZ(id, dir) {
    const sorted = [...els].sort((a, b) => a.z - b.z), i = sorted.findIndex((e) => e.id === id), j = i + (dir > 0 ? 1 : -1);
    if (j < 0 || j >= sorted.length) return;
    const t = sorted[i].z; sorted[i].z = sorted[j].z; sorted[j].z = t;
    sel = id; render();
  }
  function addEl(type) {
    uid++;
    els.push({ id: uid, type, hasBbox: true, bbox: defBbox(type), desc: "", text: "", z: uid });
    sel = uid; render();
  }

  /* ---- panel boczny ---- */
  function renderList() {
    const L = byId("bxList");
    if (!L) return;
    L.innerHTML = "";
    const head = document.createElement("div");
    head.className = "bxcard";
    head.innerHTML =
      '<div class="field"><label>aspect_ratio</label><input id="bxFAr" value="' + esc(ar) + '"></div>' +
      '<div class="field"><label>high_level_description <span class="bxctr" id="bxHldCtr"></span></label><textarea id="bxFHld" style="min-height:64px">' + esc(hld) + "</textarea></div>" +
      '<div class="field"><label>background (tylko powłoka sceny)</label><textarea id="bxFBg" style="min-height:80px">' + esc(bg) + "</textarea></div>";
    L.appendChild(head);
    if (!els.length) {
      const h = document.createElement("p");
      h.className = "info";
      h.textContent = "Dodaj element + obj lub + text. Jeden podmiot = jeden element (części w desc).";
      L.appendChild(h);
    }
    [...els].sort((a, b) => a.z - b.z).forEach((e) => {
      const c = document.createElement("div");
      c.className = "bxcard" + (e.id === sel ? " sel" : "");
      c.dataset.id = e.id;
      c.innerHTML =
        '<div class="top"><b>' + (e.type === "text" ? "text" : "obj") + " #" + e.id + "</b>" +
        '<span style="display:flex;gap:4px;align-items:center">' +
        '<button class="bxzb" data-up="' + e.id + '" title="na wierzch">&#9650;</button>' +
        '<button class="bxzb" data-down="' + e.id + '" title="pod spód">&#9660;</button>' +
        '<button class="bxx" data-x="' + e.id + '">&times;</button></span></div>' +
        '<div class="bxmini" style="margin-bottom:8px">' + (e.hasBbox ? ("bbox [" + e.bbox.join(", ") + "] ") : "bez bbox ") +
        '&middot; <label style="cursor:pointer"><input type="checkbox" data-bb="' + e.id + '" ' + (e.hasBbox ? "checked" : "") + ' style="width:auto;vertical-align:middle"> bbox</label></div>' +
        (e.type === "text" ? '<div class="field" style="margin-bottom:8px"><label>text (verbatim, \\n = nowa linia)</label><textarea data-f="text" data-id="' + e.id + '" style="min-height:40px">' + esc(e.text) + "</textarea></div>" : "") +
        '<div class="field"><label>desc <span class="bxctr" data-ctr="' + e.id + '"></span></label><textarea data-f="desc" data-id="' + e.id + '">' + esc(e.desc) + "</textarea></div>";
      c.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-x],[data-up],[data-down],[data-bb],textarea,input")) return;
        selectEl(e.id);
      });
      L.appendChild(c);
    });
    bindInput("bxFAr", (v) => { if (/^\d+:\d+$/.test(v.trim())) setAR(v.trim()); });
    bindInput("bxFHld", (v) => { hld = v; updateCounters(); renderJSON(); renderValidation(); });
    bindInput("bxFBg", (v) => { bg = v; renderJSON(); renderValidation(); });
    L.querySelectorAll("[data-x]").forEach((b) => b.onclick = () => { els = els.filter((x) => x.id != b.dataset.x); if (sel == b.dataset.x) sel = null; render(); });
    L.querySelectorAll("[data-up]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); bumpZ(+b.dataset.up, +1); });
    L.querySelectorAll("[data-down]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); bumpZ(+b.dataset.down, -1); });
    L.querySelectorAll("[data-bb]").forEach((cb) => cb.onchange = () => {
      const e = els.find((x) => x.id == cb.dataset.bb);
      if (e) { e.hasBbox = cb.checked; if (cb.checked && (!e.bbox || e.bbox.length !== 4)) e.bbox = defBbox(e.type); render(); }
    });
    L.querySelectorAll("[data-f]").forEach((inp) => {
      inp.oninput = () => {
        const e = els.find((x) => x.id == inp.dataset.id);
        if (!e) return;
        e[inp.dataset.f] = inp.value;
        if (inp.dataset.f === "text") {
          const t = frame().querySelector('.bx[data-id="' + e.id + '"] .tag');
          if (t) t.textContent = "text: " + (e.text || "…");
        }
        updateCounters(); renderJSON(); renderValidation();
      };
    });
    updateCounters();
  }
  function bindInput(id, fn) { const el = byId(id); if (el) el.oninput = () => fn(el.value); }
  const wordCount = (s) => ((s || "").trim() ? s.trim().split(/\s+/).length : 0);
  function updateCounters() {
    const hc = byId("bxHldCtr");
    if (hc) { const n = wordCount(hld); hc.textContent = n + "/50 słów"; hc.classList.toggle("over", n > 50); }
    document.querySelectorAll("#view-bbox [data-ctr]").forEach((s) => {
      const e = els.find((x) => x.id == s.dataset.ctr);
      if (!e) return;
      const n = wordCount(e.desc);
      s.textContent = n + "/60 słów";
      s.classList.toggle("over", n > 60);
    });
  }

  /* ---- wyjście ---- */
  function buildCaption() {
    return {
      aspect_ratio: ar,
      high_level_description: hld || "",
      compositional_deconstruction: {
        background: bg || "",
        elements: [...els].sort((a, b) => a.z - b.z).map((e) => {
          const o = { type: e.type };
          if (e.hasBbox) o.bbox = e.bbox;
          if (e.type === "text") o.text = e.text || "";
          o.desc = e.desc || "";
          return o;
        }),
      },
    };
  }
  function renderJSON() { const p = byId("bxJson"); if (p) p.textContent = JSON.stringify(buildCaption(), null, 2); }

  /* ---- linter v15 (lustrzany z backend/v15_lint.py) ---- */
  const WARM_RE = /\bwarm(\b|ly)/i;
  const RENDER_RE = /\b(bokeh|depth of field|shallow focus|f\/\d|mm lens|telephoto|chromatic aberration|lens flare|vignett|film grain|motion blur|iso \d|drop shadow|cast shadow|casts a shadow)\b/i;
  const PART_RE = /\b(thorax|abdomen|wingtip|left leg|right leg|left arm|right arm|windshield|wheels?|petals?|stem only|each limb|forearm only)\b/i;
  const FLOOR_RE = /\b(pavement|puddles?|wet ground|rain-slicked|asphalt|cobblestones?|sidewalk|the floor|the ground|turf|grass surface|snow on the ground|tile floor|hardwood floor|reflective ground)\b/i;
  const HEDGE_RE = /\b(things like|such as|e\.g\.|for example|or similar|various|could include|might be|implied|suggested|hinted|barely visible|perhaps|reads as)\b/i;
  const POSTFX_RE = /\b(film grain|kodak|portra|tri-x|iso noise|lens flare|chromatic aberration|vignett|bokeh|halftone|risograph|brushstrokes?|paper texture|canvas texture)\b/i;
  const ARRANGE_RE = /\b(rows of desks|grid of desks|chairs arranged|cars parked|customers seated|room is filled with people|seated at the (desks|tables)|desks reced)\b/i;
  const BUILTENV_RE = /\b(shop|stall|restaurant|store(front)?|sign|market|cafe|bar|workshop|poster|cover|banner|menu)\b/i;
  function renderValidation() {
    const box = byId("bxValBox");
    if (!box) return;
    const v = [];
    if (hadLegacyStyle) v.push(["warn", "Wczytano STARY format ze style_description — te pola NIE istnieją w v15 i zostały pominięte; przepisz styl prozą do HLD lub background."]);
    if (!ar || !/^\d+:\d+$/.test(ar)) v.push(["err", "aspect_ratio musi być w formacie W:H"]);
    if (!hld.trim()) v.push(["warn", "high_level_description jest puste"]);
    else {
      if (wordCount(hld) > 50) v.push(["warn", "HLD przekracza 50 słów (" + wordCount(hld) + ")"]);
      if (/\b(this image (shows|depicts)|depicts|captures)\b/i.test(hld)) v.push(["warn", "HLD nie powinno zaczynać się od shows/depicts/captures — zacznij od podmiotu"]);
    }
    if (WARM_RE.test(hld) || WARM_RE.test(bg)) v.push(["warn", "słowo \"warm\" jako gradacja jest odradzane w fotorealizmie — opisz źródło światła konkretnie"]);
    if (POSTFX_RE.test(bg)) v.push(["warn", "background zawiera efekt post-processingu — przenieś do high_level_description"]);
    if (ARRANGE_RE.test(bg)) v.push(["err", "background opisuje rozmieszczone meble/ludzi — to treść pierwszego planu, zrób z tego elementy"]);
    let textCount = 0;
    els.forEach((e) => {
      const tag = "(" + e.type + " #" + e.id + ") ";
      if (e.type === "text") { textCount++; if (!e.text.trim()) v.push(["warn", tag + "pusty text"]); }
      if (wordCount(e.desc) > 60) v.push(["warn", tag + "desc > 60 słów (" + wordCount(e.desc) + ")"]);
      if (RENDER_RE.test(e.desc)) v.push(["err", tag + "desc zawiera język kamery/cienia — przenieś do HLD/background"]);
      if (WARM_RE.test(e.desc)) v.push(["warn", tag + "\"warm\" w desc — odradzane"]);
      if (PART_RE.test(e.desc) && e.type === "obj") v.push(["warn", tag + "desc wygląda na pojedynczą część podmiotu — jeden podmiot = jeden element"]);
      if (FLOOR_RE.test(e.desc)) v.push(["err", tag + "opis nawierzchni/podłogi/kałuży jako element — przenieś do background"]);
      if (HEDGE_RE.test(e.desc)) v.push(["warn", tag + "hedging (such as/various/implied…) — commit do konkretnej wartości"]);
      if (e.hasBbox) { const [y0, x0, y1, x1] = e.bbox; if (!(y0 < y1 && x0 < x1)) v.push(["err", tag + "bbox: wymagane y1<y2 oraz x1<x2"]); }
    });
    if (textCount === 0 && BUILTENV_RE.test(hld + " " + bg))
      v.push(["warn", "scena wygląda na built environment, a nie ma elementów text — realne sceny niosą tekst niemal wszędzie"]);
    window.renderV15Findings(box, v.map(([level, msg]) => ({ level, msg })));
  }
  function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  /* ---- akcje ---- */
  function setStatus(msg, cls) {
    const el = byId("bxStatus");
    if (el) { el.textContent = msg || ""; el.className = "info" + (cls ? " " + cls : ""); }
  }
  async function saveToLibrary() {
    try {
      const res = await fetch("/api/prompts/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "ideogram",
          prompt: JSON.stringify(buildCaption()),
          input_text: "edytor bbox",
          action: "manual",
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const r = await res.json();
      setStatus("Zapisano w bibliotece (#" + r.id + ").", "ok");
      if (typeof window.loadPromptLib === "function") window.loadPromptLib();
    } catch (e) {
      setStatus("Błąd zapisu: " + e.message, "err");
    }
  }
  function flash(id, on, off) { const b = byId(id); if (!b) return; b.textContent = on; setTimeout(() => { b.textContent = off; }, 1200); }

  function bindUI() {
    byId("bxAr").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setAR(b.dataset.ar); });
    byId("bxArCustom").addEventListener("change", (ev) => { const v = ev.target.value.trim(); if (/^\d+:\d+$/.test(v)) setAR(v); });
    byId("bxAddObj").onclick = () => addEl("obj");
    byId("bxAddText").onclick = () => addEl("text");
    const impBar = byId("bxImpBar");
    byId("bxImp").onclick = () => { impBar.classList.toggle("hidden"); };
    byId("bxImpCancel").onclick = () => { impBar.classList.add("hidden"); byId("bxImpMsg").textContent = ""; };
    byId("bxImpLoad").onclick = () => {
      const msg = byId("bxImpMsg");
      try {
        loadCaption(byId("bxImpTxt").value);
        impBar.classList.add("hidden");
        msg.textContent = "";
        render(); fitFrame();
      } catch (e) { msg.textContent = "Błąd parsowania JSON (" + e.message + ")"; }
    };
    byId("bxCopy").onclick = () => { navigator.clipboard.writeText(JSON.stringify(buildCaption())); flash("bxCopy", "✓ Skopiowano", "📋 Kopiuj (minified)"); };
    byId("bxCopyPretty").onclick = () => { navigator.clipboard.writeText(JSON.stringify(buildCaption(), null, 2)); flash("bxCopyPretty", "✓ OK", "Pretty"); };
    byId("bxDl").onclick = () => {
      const blob = new Blob([JSON.stringify(buildCaption())], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "caption_v15.json";
      a.click();
      URL.revokeObjectURL(a.href);
    };
    byId("bxSave").onclick = saveToLibrary;
    frame().addEventListener("pointerdown", onFramePointerDown, true);
    window.addEventListener("resize", fitFrame);
  }

  /* ---- publiczne API ---- */
  window.BboxEditor = {
    // Wczytaj JSON (string) do edytora; wywołuj PO przełączeniu na widok bbox.
    open(raw) {
      try {
        loadCaption(raw);
        setStatus("Wczytano prompt do edycji.", "ok");
      } catch (e) {
        setStatus("Błąd parsowania JSON: " + e.message, "err");
        return;
      }
      fitFrame();
    },
    // Widok stał się widoczny — przelicz wymiary kanwy.
    onShow() { fitFrame(); },
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (!byId("bxFrame")) return;
    bindUI();
    if (!els.length) addEl("obj");
    fitFrame();
  });
})();

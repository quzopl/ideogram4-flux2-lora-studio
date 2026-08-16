"use strict";

// Crop plan: {fileName: [x, y, w, h]} in ORIGINAL pixels (after the EXIF fix).
// Lives in the browser only and travels with POST /api/process.
window.CropPlan = (function () {
  const $ = (id) => document.getElementById(id);
  let folder = null;
  let files = [];
  let plan = {};

  const storageKey = () => "cropPlan:" + (folder || "");

  function load() {
    plan = {};
    try {
      plan = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    } catch (e) {
      plan = {};
    }
  }

  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(plan));
    } catch (e) {
      console.warn("Crop plan not saved:", e);
    }
  }

  function info() {
    const n = Object.keys(plan).length;
    $("cropInfo").textContent = n ? `${n} of ${files.length} images have a crop.` : "";
  }

  function render() {
    const grid = $("srcGrid");
    grid.innerHTML = "";
    $("cropBar").classList.toggle("hidden", files.length === 0);
    for (const name of files) {
      const cell = document.createElement("div");
      cell.className = "cell" + (plan[name] ? " cropped" : "");
      cell.innerHTML =
        `<img loading="lazy" src="/api/src/thumb?folder=${encodeURIComponent(folder)}` +
        `&name=${encodeURIComponent(name)}" />` +
        (plan[name] ? `<span class="badge">✂</span>` : "") +
        `<div class="name">${name}</div>`;
      cell.addEventListener("click", () => window.CropEditor.open(folder, name));
      grid.appendChild(cell);
    }
    info();
  }

  return {
    setSource(f, list) {
      folder = f;
      files = list || [];
      load();
      render();
    },
    files: () => files.slice(),
    folder: () => folder,
    get: (name) => plan[name] || null,
    set(name, box) { plan[name] = box; save(); render(); },
    remove(name) { delete plan[name]; save(); render(); },
    merge(boxes) { Object.assign(plan, boxes); save(); render(); },
    clear() { plan = {}; save(); render(); },
    all: () => Object.assign({}, plan),
    settings: () => ({
      crop_mode: $("cropMode").value,
      fit: $("fitMode").value,
      pad_color: $("padColor").value,
      centering_x: $("centeringX").value,
      centering_y: $("centeringY").value,
    }),
  };
})();

// ---- Batch auto-crop -------------------------------------------------------
document.getElementById("autoCropBtn").addEventListener("click", async () => {
  const btn = document.getElementById("autoCropBtn");
  const info = document.getElementById("cropInfo");
  btn.disabled = true;
  info.textContent = "Auto-cropping…";
  try {
    const { job_id, total } = await api("/api/crop/auto", {
      folder: CropPlan.folder(),
      mode: document.getElementById("mode").value,
      resolution: parseInt(document.getElementById("resolution").value, 10),
      step: parseInt(document.getElementById("step").value, 10),
      square: document.getElementById("square").value === "true",
    });
    await pollAutoCrop(job_id, total);
    document.getElementById("cropMode").value = "manual";
  } catch (e) {
    info.textContent = "Auto-crop error: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

function pollAutoCrop(jobId, total) {
  const info = document.getElementById("cropInfo");
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const j = await api("/api/crop/auto/" + jobId);
        info.textContent = `Auto-crop: ${j.processed}/${total} — ${j.current || ""}`;
        if (j.state === "done") { CropPlan.merge(j.crops); resolve(); return; }
        if (j.state === "error") { reject(new Error(j.error)); return; }
        setTimeout(tick, 800);
      } catch (e) { reject(e); }
    };
    tick();
  });
}

document.getElementById("clearCropsBtn").addEventListener("click", () => {
  CropPlan.clear();
});

// ---- Crop editor modal -----------------------------------------------------
window.CropEditor = (function () {
  const $ = (id) => document.getElementById(id);
  let cur = { folder: null, name: null, srcW: 0, srcH: 0, viewW: 0, viewH: 0 };
  let box = { x: 0, y: 0, w: 0, h: 0 };   // in SOURCE pixels
  let drag = null;

  const scale = () => cur.viewW / cur.srcW;          // source px -> screen px
  const forcedRatio = () =>
    $("square").value === "true" ? 1 : ($("cropRatio").value === "free"
      ? null : parseFloat($("cropRatio").value));

  function clampBox() {
    box.w = Math.max(16, Math.min(box.w, cur.srcW));
    box.h = Math.max(16, Math.min(box.h, cur.srcH));
    box.x = Math.max(0, Math.min(box.x, cur.srcW - box.w));
    box.y = Math.max(0, Math.min(box.y, cur.srcH - box.h));
  }

  function applyRatio(anchorRight, anchorBottom) {
    const r = forcedRatio();
    if (!r) return;
    if (box.w / box.h > r) {
      const w = box.h * r;
      if (anchorRight) box.x += box.w - w;
      box.w = w;
    } else {
      const h = box.w / r;
      if (anchorBottom) box.y += box.h - h;
      box.h = h;
    }
  }

  function draw() {
    clampBox();
    const s = scale();
    const rect = $("cropRect");
    rect.style.left = box.x * s + "px";
    rect.style.top = box.y * s + "px";
    rect.style.width = box.w * s + "px";
    rect.style.height = box.h * s + "px";
    $("cropSize").textContent =
      `crop ${Math.round(box.w)} × ${Math.round(box.h)} px`;
  }

  function defaultBox() {
    const r = forcedRatio() || cur.srcW / cur.srcH;
    let w = cur.srcW, h = w / r;
    if (h > cur.srcH) { h = cur.srcH; w = h * r; }
    box = { x: (cur.srcW - w) / 2, y: (cur.srcH - h) / 2, w, h };
  }

  // Pointer handling: dragging the rect moves it, dragging a handle resizes it.
  function onDown(e) {
    const handle = e.target.dataset ? e.target.dataset.h : null;
    drag = { handle: handle || null, x: e.clientX, y: e.clientY, start: Object.assign({}, box) };
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onMove(e) {
    if (!drag) return;
    const s = scale();
    const dx = (e.clientX - drag.x) / s;
    const dy = (e.clientY - drag.y) / s;
    const b = drag.start;
    if (!drag.handle) {
      box = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
    } else {
      box = Object.assign({}, b);
      if (drag.handle.includes("w")) { box.x = b.x + dx; box.w = b.w - dx; }
      if (drag.handle.includes("e")) { box.w = b.w + dx; }
      if (drag.handle.includes("n")) { box.y = b.y + dy; box.h = b.h - dy; }
      if (drag.handle.includes("s")) { box.h = b.h + dy; }
      applyRatio(drag.handle.includes("w"), drag.handle.includes("n"));
    }
    draw();
  }

  function onUp() {
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  function onKey(e) {
    if ($("cropModal").classList.contains("hidden")) return;
    const stepPx = e.shiftKey ? 10 : 1;
    const map = { ArrowLeft: [-stepPx, 0], ArrowRight: [stepPx, 0], ArrowUp: [0, -stepPx], ArrowDown: [0, stepPx] };
    if (map[e.key]) {
      box.x += map[e.key][0];
      box.y += map[e.key][1];
      draw();
      e.preventDefault();
    }
    if (e.key === "Escape") close();
  }

  function close() { $("cropModal").classList.add("hidden"); }

  async function open(folder, name) {
    cur.folder = folder;
    cur.name = name;
    $("cropTitle").textContent = name;
    const url = `/api/src/image?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) { alert("Cannot load the image."); return; }
    cur.srcW = parseInt(res.headers.get("X-Src-Width"), 10);
    cur.srcH = parseInt(res.headers.get("X-Src-Height"), 10);
    const blob = await res.blob();
    const img = $("cropImg");
    await new Promise((resolve) => {
      img.onload = resolve;
      img.src = URL.createObjectURL(blob);
    });
    // The modal must be visible (not display:none) before measuring the
    // rendered image, otherwise clientWidth/clientHeight both read 0.
    $("cropModal").classList.remove("hidden");
    cur.viewW = img.clientWidth;
    cur.viewH = img.clientHeight;
    const saved = CropPlan.get(name);
    if (saved) { box = { x: saved[0], y: saved[1], w: saved[2], h: saved[3] }; }
    else { defaultBox(); }
    draw();
  }

  $("cropRect").addEventListener("pointerdown", onDown);
  window.addEventListener("keydown", onKey);
  $("cropRatio").addEventListener("change", () => { applyRatio(false, false); draw(); });
  $("cropResetBtn").addEventListener("click", () => { defaultBox(); draw(); });
  $("cropCancelBtn").addEventListener("click", close);

  $("cropSaveBtn").addEventListener("click", () => {
    CropPlan.set(cur.name, [Math.round(box.x), Math.round(box.y),
                            Math.round(box.w), Math.round(box.h)]);
    document.getElementById("cropMode").value = "manual";
    close();
  });

  $("cropApplyAllBtn").addEventListener("click", () => {
    // Same crop (as fractions) for every image with the same source aspect ratio.
    const fx = box.x / cur.srcW, fy = box.y / cur.srcH;
    const fw = box.w / cur.srcW, fh = box.h / cur.srcH;
    const ar = cur.srcW / cur.srcH;
    const jobs = CropPlan.files().map(async (name) => {
      const url = `/api/src/image?folder=${encodeURIComponent(CropPlan.folder())}&name=${encodeURIComponent(name)}`;
      const res = await fetch(url, { method: "HEAD" }).catch(() => null);
      const head = res && res.ok ? res : await fetch(url);
      const w = parseInt(head.headers.get("X-Src-Width"), 10);
      const h = parseInt(head.headers.get("X-Src-Height"), 10);
      if (!w || !h || Math.abs(w / h - ar) > 0.02) return;
      CropPlan.set(name, [Math.round(fx * w), Math.round(fy * h),
                          Math.round(fw * w), Math.round(fh * h)]);
    });
    Promise.all(jobs).then(() => { document.getElementById("cropMode").value = "manual"; close(); });
  });

  $("cropAutoBtn").addEventListener("click", async () => {
    const btn = $("cropAutoBtn");
    btn.disabled = true;
    try {
      const { job_id, total } = await api("/api/crop/auto", {
        folder: CropPlan.folder(),
        mode: document.getElementById("mode").value,
        resolution: parseInt(document.getElementById("resolution").value, 10),
        step: parseInt(document.getElementById("step").value, 10),
        square: document.getElementById("square").value === "true",
        names: [cur.name],
      });
      await pollAutoCrop(job_id, total);
      const b = CropPlan.get(cur.name);
      if (b) { box = { x: b[0], y: b[1], w: b[2], h: b[3] }; draw(); }
    } catch (e) {
      alert("Auto-crop error: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  return { open };
})();

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

"use strict";

// Standalone "🔍 Upscale" tab: pick images, pick a model, run, save.
window.UpscaleView = (function () {
  const $ = (id) => document.getElementById(id);
  let folder = null;
  let jobId = null;

  function info(msg, cls) {
    const el = $("uSrcInfo");
    el.textContent = msg;
    el.className = "info" + (cls ? " " + cls : "");
  }

  $("uScanBtn").addEventListener("click", async () => {
    const f = $("uFolder").value.trim();
    if (!f) return;
    try {
      const r = await api("/api/scan", { folder: f });
      folder = r.folder;
      info(`Found ${r.count} images.`, "ok");
      $("uRunBtn").disabled = r.count === 0;
    } catch (e) {
      info("Error: " + e.message, "err");
    }
  });

  $("uDropzone").addEventListener("click", () => $("uFileInput").click());
  $("uFileInput").addEventListener("change", (e) => upload(e.target.files));
  ["dragover", "dragenter"].forEach((ev) =>
    $("uDropzone").addEventListener(ev, (e) => { e.preventDefault(); $("uDropzone").classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    $("uDropzone").addEventListener(ev, (e) => { e.preventDefault(); $("uDropzone").classList.remove("drag"); }));
  $("uDropzone").addEventListener("drop", (e) => upload(e.dataTransfer.files));

  async function upload(list) {
    if (!list || !list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append("files", f);
    info("Uploading…");
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const r = await res.json();
      folder = r.folder;
      info(`Uploaded ${r.count} images.`, "ok");
      $("uRunBtn").disabled = r.count === 0;
    } catch (e) {
      info("Error: " + e.message, "err");
    }
  }

  $("uRunBtn").addEventListener("click", async () => {
    if (!folder) return;
    const mode = $("uMode").value;
    const longSide = parseInt($("uLongSide").value, 10);
    if (mode === "long_side" && !(longSide > 0)) {
      $("uProgressCard").classList.remove("hidden");
      $("uProgressText").textContent = "Error: enter a positive long side (px).";
      return;
    }
    $("uRunBtn").disabled = true;
    $("uProgressCard").classList.remove("hidden");
    $("uExportCard").classList.add("hidden");
    $("uResults").innerHTML = "";
    try {
      const { job_id, total } = await api("/api/upscale/run", {
        folder,
        model_id: $("uModel").value,
        mode,
        long_side: longSide,
        fmt: $("uFmt").value,
      });
      jobId = job_id;
      poll(job_id, total);
    } catch (e) {
      $("uProgressText").textContent = "Error: " + e.message;
      $("uRunBtn").disabled = false;
    }
  });

  async function poll(id, total) {
    try {
      const j = await api("/api/upscale/job/" + id);
      const pct = total ? Math.round((j.processed / total) * 100) : 0;
      $("uProgressBar").style.width = pct + "%";
      $("uProgressText").textContent =
        j.state === "loading_model" ? j.current : `${j.processed}/${total} — ${j.current || ""}`;
      render(j, id);
      if (j.state === "done") {
        $("uProgressText").textContent = `Done: ${j.processed} images.`;
        $("uExportCard").classList.remove("hidden");
        $("uRunBtn").disabled = false;
        refreshGpu();
        return;
      }
      if (j.state === "error") {
        $("uProgressText").textContent = "Error: " + j.error;
        $("uRunBtn").disabled = false;
        return;
      }
      setTimeout(() => poll(id, total), 1000);
    } catch (e) {
      $("uProgressText").textContent = "Error: " + e.message;
      $("uRunBtn").disabled = false;
    }
  }

  function render(job, id) {
    for (const r of job.results) {
      if (document.getElementById("ures-" + r.idx)) continue;
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.id = "ures-" + r.idx;
      cell.innerHTML = r.error
        ? `<div class="name err">${r.src_name}: ${r.error}</div>`
        : `<img loading="lazy" src="/api/upscale/thumb/${id}/${r.idx}" />` +
          `<div class="name">${r.out_name} — ${r.width}×${r.height}</div>`;
      $("uResults").appendChild(cell);
    }
  }

  $("uExportBtn").addEventListener("click", async () => {
    if (!jobId) return;
    try {
      const r = await api("/api/upscale/export", {
        job_id: jobId, output_folder: $("uOutFolder").value.trim(),
      });
      $("uExportInfo").textContent = `Saved ${r.written} files to ${r.folder}.`;
      $("uExportInfo").className = "info ok";
    } catch (e) {
      $("uExportInfo").textContent = "Error: " + e.message;
      $("uExportInfo").className = "info err";
    }
  });

  $("uZipBtn").addEventListener("click", async () => {
    if (!jobId) return;
    $("uExportInfo").textContent = "Packaging into .zip…";
    $("uExportInfo").className = "info";
    try {
      const res = await fetch("/api/upscale/zip/" + jobId);
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const fname = m ? m[1] : "upscaled.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      $("uExportInfo").textContent = `Downloaded: ${fname}`;
      $("uExportInfo").className = "info ok";
    } catch (e) {
      $("uExportInfo").textContent = "Packaging error: " + e.message;
      $("uExportInfo").className = "info err";
    }
  });

  return {
    onShow() { if (window.loadUpscaleModels) window.loadUpscaleModels(); },
  };
})();

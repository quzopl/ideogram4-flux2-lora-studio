/* =========================================================================== //
// Ideogram 4 render — standalone module. Takes the v15 JSON from the bbox
// editor, posts it to /api/ideogram/render (the built-in ComfyUI workflow on
// the backend) and tracks the job via the shared /api/comfy/job/* endpoints.
// =========================================================================== */
"use strict";

(function () {
  const byId = (id) => document.getElementById(id);
  let jobId = null;
  let pollTimer = null;

  function setStatus(msg, cls) {
    const el = byId("irStatus");
    if (el) { el.textContent = msg || ""; el.className = "info" + (cls ? " " + cls : ""); }
  }

  function params() {
    return {
      preset: byId("irPreset").value,
      megapixels: parseFloat(byId("irMp").value),
      seed: parseInt(byId("irSeed").value, 10) || 0,
      variant: byId("irVariant").value,
      batch_size: parseInt(byId("irBatch").value, 10) || 1,
      lora_enabled: byId("irLoraOn").checked,
      lora_name: byId("irLora").value.trim(),
      lora_strength: parseFloat(byId("irLoraStr").value),
      diff_model: byId("irDiff").value.trim(),
      uncond_model: byId("irUncond").value.trim(),
      vae_name: byId("irVae").value.trim(),
      clip_name: byId("irClip").value.trim(),
    };
  }

  function applyConfig(p) {
    byId("irPreset").value = p.preset;
    byId("irMp").value = p.megapixels;
    byId("irSeed").value = p.seed;
    byId("irVariant").value = p.variant;
    byId("irBatch").value = p.batch_size;
    byId("irLoraOn").checked = !!p.lora_enabled;
    byId("irLora").value = p.lora_name || "";
    byId("irLoraStr").value = p.lora_strength;
    byId("irDiff").value = p.diff_model;
    byId("irUncond").value = p.uncond_model;
    byId("irVae").value = p.vae_name;
    byId("irClip").value = p.clip_name;
  }

  async function loadConfig() {
    try {
      const r = await fetch("/api/ideogram/render/config");
      if (r.ok) applyConfig((await r.json()).params);
    } catch (_) { /* keep the HTML defaults */ }
  }

  async function loadLoras() {
    try {
      const r = await fetch("/api/comfy/loras");
      if (!r.ok) return;
      const list = byId("irLoraList");
      list.replaceChildren();
      for (const name of (await r.json()).loras || []) {
        const o = document.createElement("option");
        o.value = name;
        list.appendChild(o);
      }
    } catch (_) { /* ComfyUI offline — the field stays manual */ }
  }

  function setBusy(busy) {
    byId("irRenderBtn").disabled = busy;
    byId("irCancelBtn").classList.toggle("hidden", !busy);
  }

  function showResults(images) {
    const host = byId("irResults");
    for (const meta of images || []) {
      const a = document.createElement("a");
      a.href = meta.url;
      a.target = "_blank";
      const img = document.createElement("img");
      img.src = meta.url;
      img.alt = meta.filename || "render";
      a.appendChild(img);
      host.prepend(a);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    jobId = null;
    setBusy(false);
    byId("irPreview").classList.add("hidden");
    const bar = byId("irBar");
    if (bar) bar.style.width = "0%";
  }

  async function poll() {
    if (!jobId) return;
    let job;
    try {
      const r = await fetch(`/api/comfy/job/${jobId}`);
      if (!r.ok) throw new Error(await r.text());
      job = await r.json();
    } catch (e) {
      setStatus("Polling error: " + e.message, "err");
      stopPolling();
      return;
    }
    const pr = job.progress || {};
    if (pr.max) byId("irBar").style.width = Math.round(100 * pr.value / pr.max) + "%";
    setStatus(job.current || job.state, "");
    if (job.has_preview) {
      const img = byId("irPreview");
      img.src = `/api/comfy/job/${jobId}/preview?t=${job.preview_ts}`;
      img.classList.remove("hidden");
    }
    if (job.state === "done") {
      showResults(job.images);
      setStatus("Done — image saved to the ComfyUI gallery.", "ok");
      stopPolling();
    } else if (job.state === "error") {
      setStatus("Render error: " + (job.error || "?"), "err");
      stopPolling();
    } else if (job.state === "cancelled") {
      setStatus("Cancelled.", "");
      stopPolling();
    }
  }

  async function render() {
    if (!window.BboxEditor) return;
    if (byId("irRandom").checked) {
      byId("irSeed").value = Math.floor(Math.random() * 1e15);
    }
    setBusy(true);
    setStatus("Queueing the render…", "");
    try {
      const r = await fetch("/api/ideogram/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: window.BboxEditor.getJson(), params: params() }),
      });
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      const out = await r.json();
      jobId = out.job_id;
      if (out.warnings && out.warnings.length && window.renderV15Findings) {
        window.renderV15Findings(byId("bxValBox"), out.warnings);
      }
      pollTimer = setInterval(poll, 700);
    } catch (e) {
      setStatus("Error: " + e.message, "err");
      setBusy(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    try { await fetch(`/api/comfy/job/${jobId}/cancel`, { method: "POST" }); } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!byId("irRenderBtn")) return;
    byId("irRenderBtn").addEventListener("click", render);
    byId("irCancelBtn").addEventListener("click", cancel);
    loadConfig();
    loadLoras();
  });
})();

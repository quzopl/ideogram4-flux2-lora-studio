# Dataset view inventory (legacy UI -> React port)

Sources: `frontend/index.html` (IDX), `frontend/app.js` (APP), `frontend/crop_editor.js` (CE), `backend/server.py` (SRV). All paths relative to repo root. Line numbers are start lines, approximate by +-3 where marked `~`.
v2 state: `/dataset` route is `ClassicPlaceholder` (web/src/app/routes.tsx:13); v2 already has `lib/api.ts` (`api<T>(path,{json})`, throws `ApiError{status,detail}`), `FolderPicker`, `DropZone`, `JobProgress`, `ModelSelect`, `PresetBar`, `useAutosave`.

Legacy `api()` helper (APP:4): body truthy -> POST + JSON, else GET; non-OK throws `Error(rawResponseText)` (so errors show raw `{"detail": ...}` JSON text; only some call sites JSON.parse it). `api(path, {})` is how body-less POSTs are made.

## 1. Controls (IDX, `<div id="view-dataset">` lines 30-282)

No control in the Dataset view is conditionally shown/hidden by another control. All "conditional" bits are listed in 1.6.

### 1.1 Step 1 Source (IDX:32-60)
| id | label / text | type | notes |
|---|---|---|---|
| (tabs) `.tab[data-tab=folder|upload]` | "Folder on disk" (active) / "Upload files" | buttons | toggle `#pane-folder` / `#pane-upload` `.hidden` (APP:~323). Switching tab does NOT clear the current source. |
| `folderPath` | "Path to the folder with original photos" | text | placeholder `/home/user/photos/my-person`; trimmed; empty -> Scan does nothing |
| `scanBtn` | "Scan" | button | POST /api/scan |
| `dropzone` | "Drop images…" (label "Drag files here or click to choose") | div | click -> `#fileInput.click()`; dragover/dragenter add class `drag`; drop -> upload |
| `fileInput` | hidden | file, multiple | `accept="image/*,.heic,.heif,image/heic,image/heif"` |
| `srcInfo` | status line | p.info | classes `ok` / `err` |
| `cropBar` | row, **hidden until source has >=1 file** (CE:53) | div | contains the three below |
| `autoCropBtn` | "✂ Auto-crop all" | button | CE:95 |
| `clearCropsBtn` | "Clear crops" | button | CE:140; no confirm; does not reset `cropMode` |
| `cropInfo` | "N of M images have a crop." / progress text | span | |
| `srcGrid` | thumbnail grid | div | cells built by CropPlan.render (CE:50) |

### 1.2 Step 2 Settings (IDX:62-254) — value shown = option `value`
| id | label | type | options (value: text) | default | sent as |
|---|---|---|---|---|---|
| `mode` | Caption mode | select | `person`: Person (variable traits only); `person_detail`: Person — details (scars, moles, hair, facial hair…); `style`: Style (for a style LoRA — content only); `architecture`: Architecture; `landscape`: Landscape; `generic`: Generic | person (first) | `mode` (also used as output file prefix and zip name, and by auto-crop) |
| `style` | Caption style | select | `concise`: Concise (factual, ~3-5 sentences) [selected]; `detailed`: Detailed (long paragraph) | concise | `style` |
| `captionFormat` | Target format | select | `flux`: FLUX.2 (natural language) [sel]; `ideogram`: Ideogram 4 (JSON); `aitoolkit`: ai-toolkit (JSON in .txt) | flux | `caption_format` |
| `resolution` | Target resolution | select | 768, 1024 [sel], 1280, 1536 | 1024 | `resolution` int |
| `step` | Bucket step (px) | select | 16, 32, 64 [sel] | 64 | `step` int |
| `square` | Cropping | select | `false`: Buckets (keep aspect ratio) [sel]; `true`: Square (crop to 1:1) | false | `square` bool (`=== "true"`) |
| `cropMode` | Crop source | select | `center`: Centre (whole frame) [sel]; `auto`: Auto (Florence-2 subject); `manual`: Manual (per-image crops) | center | `crop_mode` via CropPlan.settings(); also written programmatically (see 4) |
| `fitMode` | Fit | select | `cover`: Cover (crop to fill) [sel]; `contain`: Contain (pad with colour) | cover | `fit` |
| `padColor` | Pad colour | input color | — | `#000000` | `pad_color` (always enabled, only meaningful for contain) |
| `centeringX` | Centering (horizontal / vertical) | select | left, center [sel], right | center | `centering_x` |
| `centeringY` | (same field) | select | top, center [sel], bottom | center | `centering_y` |
| `fmt` | Format | select | `png`: PNG (lossless) [sel]; `jpg`: JPG | png | `fmt` |
| `jpgQuality` | JPG quality | number | min 50 max 100 | 95 | `jpg_quality` int; never disabled when fmt=png; min/max not enforced in JS |
| `model` | VLM model | select (filled by JS) | from GET /api/models: `{id: label}`; ids = HF repo id, absolute custom path, or `lmstudio:<id>` | server `default` (`Qwen/Qwen2.5-VL-7B-Instruct`) | `model` |
| `addModelBtn` | "📁 Add model from folder" | button | zenity picker -> POST /api/models/custom | | |
| `removeModelBtn` | "🗑 Remove custom" | button | only custom (value starts with `/`) else alert; confirm() | | |
| `lmstudioUrl` | LM Studio URL | text | placeholder `http://localhost:1234/v1` | filled from GET /api/lmstudio | NOT sent with process; persisted server-side only when "Refresh models" is clicked |
| `refreshModelsBtn` | "🔄 Refresh models" | button | POST /api/lmstudio then GET /api/models, alert("Model list refreshed.") | | |
| `quant` | Quantization | select | `4bit`: 4-bit (saves VRAM) [sel]; `none`: None (fp16) | 4bit | `quant` (ignored for lmstudio: models and when do_caption=false) |
| `upscaleModel` | Upscale model (used when the crop is smaller than the target) | select (JS) | first option value `""` "Off (plain LANCZOS)"; then each model `m.id` labelled `"✓ "|"⬇ " + m.label` (cached or not) | "" (off) | `upscale_model` |
| `upDownloadBtn` | "⬇ Download weights" | button | POST /api/upscale/download (blocks until done); `upModelInfo` shows state | | |
| `upFolder` | Local upscale model folder | text | placeholder `/home/user/ComfyUI/models/upscale_models`; prefilled from server `folder` only if empty | | |
| `upScanBtn` | Scan | button | POST /api/upscale/models/scan | | |
| `upCustomRepo` / `upCustomFile` / `upCustomAddBtn` | HF repo id / file.pth / Add | text,text,button | POST /api/upscale/models/custom; clears inputs after | | |
| `hfToken` / `hfSaveBtn` / `hfClearBtn` / `hfInfo` | Hugging Face token (for gated repos) | password + 2 buttons | placeholder `hf_…`; info "Token set (…tail)" / "No token." | | |
| `modelsDir` / `modelsDirSave` / `modelsDirMsg` | Models folder (models are downloaded here) | text + button | PATCH /api/settings | | |
| `maxTokens` | Max caption length (tokens) | number | min 64 max 8192 step 32; title: reasoning models need 2048+ | 512 | `max_tokens` int |
| `trigger` | Trigger word | text | placeholder "e.g. ohwx person" | "" | export only (`trigger`) |
| `doCaption` | Generate captions (VLM) | checkbox | | checked | `do_caption` |
| `prependTrigger` | Prepend trigger to captions | checkbox | | checked | export only (`prepend_trigger`) |
| `processBtn` | "Process images" | button.primary | **disabled initially**; enabled after a scan/upload with count>0; disabled during a run | | |

Not in the UI but in ProcessRequest: `upscale_min_ratio` (default 1.05, never sent).

### 1.3 Steps 3-5 (IDX:256-281)
- `progressCard` (hidden until Process): `progressBar` (div width %), `progressText` (info/ok/err).
- `resultsCard` (hidden until first result): title "Review and edit captions"; `upscaleWarn` (p.info.err, hidden unless any result has `upscale_error`); `results` grid. Per-result card (APP:474): `button.del` "✕" (title "Remove this photo from the dataset"), `<img src=/api/thumb/{job}/{idx}>`, meta spans (`out_name || src_name`, `W×H` + `✨` if upscaled), `.trigprefix` div ("trigger: {t},"), `textarea[data-idx]` placeholder "(opis)" (Polish leftover).
- `exportCard` (hidden until job `done`): `exportCount`, `outputFolder` (text, placeholder `/home/user/dataset/my-person`; label "Save to a folder on disk (created if it doesn't exist)"), `exportBtn` "Save to folder", `.orline` "or", `zipBtn` "⬇ Download .zip", `exportInfo`.

### 1.4 Crop modal (IDX:741-768; global, not inside view-dataset)
`cropModal` (.hidden toggle), `cropTitle` (file name), `cropRatio` select (`free`[sel], `1` 1:1, `0.75` 3:4, `1.3333` 4:3, `1.7778` 16:9), `cropSize` ("crop W × H px"), buttons `cropAutoBtn` "Auto (Florence)", `cropResetBtn` "Reset", `cropApplyAllBtn` "Apply to same ratio", `cropSaveBtn` "Save" (primary), `cropCancelBtn` "Cancel"; stage `cropStage` > `cropImg` + `cropRect` with 8 handles `i[data-h=nw|n|ne|w|e|sw|s|se]`.

### 1.5 Shared top bar controls the Dataset flow touches
`gpuStatus`, `unloadBtn` ("⏏ Release GPU"), `gpuSelect` (hidden when <2 GPUs; APP:238). v2 already has GpuBar/GpuSelect; legacy calls `refreshGpu()` after job done (APP:~452).

### 1.6 Conditional visibility / enabling (complete list)
- `#pane-folder` vs `#pane-upload` by active tab.
- `#cropBar` shown iff files.length>0 (CE:53).
- `processBtn.disabled`: true at load; `count===0` after scan/upload; true on scan error; true while a job runs; re-enabled on done/error.
- `.trigprefix` hidden unless `prependTrigger` checked AND trigger non-empty; updates live on `input`/`change` (APP:529). Always renders "trigger: X," even for JSON formats (misleading).
- `progressCard` shown at Process start; `resultsCard`+`exportCard` hidden at Process start; `resultsCard` shown on first result (also while processing); `exportCard` shown only on `done`.
- `upscaleWarn` shown when any result has `upscale_error` (shows count + FIRST error only).
- Cell gets class `cropped` + badge "✂" when `plan[name]` exists.
- Crop editor: ratio forced to 1:1 when `#square==="true"` regardless of `#cropRatio` (CE:159).
- Ignored-but-enabled: `jpgQuality` with png; `padColor` with cover; centering with contain; quant with LM Studio models.

## 2. API calls (frontend -> backend)

All JSON errors are `{"detail": "..."}` (FastAPI). Job registry `JOBS` is in-memory (SRV:~150); server restart = all job ids 404 "Unknown job." (disk files under `WORK/<job_id>/` remain).

### 2.1 Page-load init (APP:44)
- `GET /api/models` -> `{models: {id: label}, default: str}` (SRV:657). `_all_models` = `captioner.AVAILABLE_MODELS` ({"Qwen/Qwen2.5-VL-3B-Instruct": "Qwen2.5-VL 3B (fp16, fast, ~7 GB VRAM)", "Qwen/Qwen2.5-VL-7B-Instruct": "Qwen2.5-VL 7B (4-bit, best captions, ~9 GB VRAM)"}) + custom (`{abs_path: "<dirname> (custom)"}`, file CUSTOM_MODELS_PATH) + live LM Studio models `lmstudio:<id>` -> "LM Studio: <id>" (3 s timeout, [] when unreachable). `populateModels` keeps previous selection if still present else default; **also fills `#pModel` (Prompt studio)**.
- `GET /api/lmstudio` -> `{url}` (SRV:749). `POST /api/lmstudio {url:str=""}` -> `{url}` (empty -> `http://localhost:1234/v1`).
- `GET /api/upscale/models` -> `{models:[{id,label,repo_id,filename,scale,note,cached,source:"builtin"|"custom"|"local",path?}], folder}` (SRV:1123; `cached` store-aware).
- `GET /api/hf/token` -> `{set:bool, tail:str(last 4)}`; `POST /api/hf/token {token}` -> same; `DELETE /api/hf/token` -> `{set:false,tail:""}` (SRV:759-775).
- `GET /api/settings` -> full settings doc (has `models_dir`, `gpu`, `forms`, `presets`); `PATCH /api/settings {models_dir:str}` -> settings doc; 400 `detail` on unwritable dir (api_settings.py:25-36). v2 also has `PUT /api/settings/forms/{view}` `{values:{}}` and presets endpoints for autosaving a form (legacy does not use them for Dataset).
- `GET /api/gpu` (SRV:1028) -> captioner status + `upscale_*`, `loaded`, `gpu_label`, `vram_used_gb/vram_total_gb`, `cards`. `GET /api/gpus` -> `{gpus:[cards], selected, roles}`. `POST /api/gpu/select {uuid}` / `POST /api/unload {}` -> 409 "Processing in progress" when `_busy()` (any job pending/loading_model/processing).

### 2.2 Model/upscale management buttons
- `POST /api/fs/pick` (no body; SRV:720): runs `zenity --file-selection --directory` (blocks <=300 s). -> `{path}` | `{cancelled:true}`; 500 if zenity missing. Linux desktop/WSLg only. Alternative in v2: `GET /api/fs/list?path=&files=weights` -> `{path,parent,dirs[],is_model,free_bytes,writable[,files]}` and `POST /api/fs/mkdir {path}`.
- `POST /api/models/custom {path}` (SRV:703) -> `{models, default, added:path}`; 400 `detail` if not a dir / no config.json / not Qwen2.5-VL ("Only Qwen2.5-VL models are supported."). Legacy then `alert("Dodano model: …")`.
- `DELETE /api/models/custom` with JSON body `{path}` -> `{models, default}` (no error if unknown).
- `POST /api/upscale/models/scan {folder}` (persists folder) -> `{models, folder}` (note: `cached` NOT store-aware here); legacy re-GETs list afterwards.
- `POST /api/upscale/models/custom {repo_id, filename, scale:int=0}` -> `{models}`; 400 if repo_id/filename empty (legacy never sends scale).
- `POST /api/upscale/download {model_id}` -> `{ok, path, models}`; 404 unknown; 400 models-folder-not-set/unusable; 502 failed download. Synchronous long call.

### 2.3 Scan / upload / source thumbs
- `POST /api/scan` body `ScanRequest{folder:str}` (SRV:158,778). Non-recursive; extensions `SUPPORTED_EXT` = .jpg .jpeg .png .webp .bmp .tif .tiff .gif .heic .heif; sorted by `sorted(Path.iterdir())` (case-sensitive). 400 `Folder does not exist: {folder}`. -> `{folder: str(expanduser(folder)) [NOT resolved], count, files:[names]}`. APP stores `state.folder=r.folder`, `state.count`, calls `CropPlan.setSource(r.folder, r.files)`; info "Found N images in: F".
- `POST /api/upload` multipart field `files` (repeated) (SRV:817). Creates `WORK/uploads/<uuid>`; skips non-supported extensions silently; filename = `Path(name).name`, same names overwrite; **no content checks**. -> `{folder, count, files:sorted names}`. Legacy: `fetch` without `res.ok` check (see 6).
- `GET /api/src/thumb?folder=&name=` (SRV:788) -> `image/jpeg` <=480 px side, cached in `WORK/srcthumbs/<sha1(resolved folder)[:16]>/<name>.jpg`, regenerated when source mtime newer. 400 invalid name (must equal basename), 404 missing/escapes folder.
- `GET /api/src/image?folder=&name=` (SRV:801) -> JPEG q88 <=1600 px side + headers `X-Src-Width`, `X-Src-Height` = TRUE size after EXIF transpose. Used by crop editor + "apply to same ratio".

### 2.4 Auto-crop
- `POST /api/crop/auto` body `CropAutoRequest{folder:str; mode:str="person"; resolution:int=1024; step:int=64; square:bool=False; names:list[str]=[]}` (SRV:190,887). Empty `names` = whole folder. 400 if no images (also if `names` match none). -> `{job_id,total}`. Worker `_run_crop_auto` (SRV:861): state `pending` -> `processing` -> `done` | `error`; for modes not in `crop_auto.NO_AUTO_MODES={landscape,architecture}` first ensures Florence-2 model (download progress shows in `current`); per file `crop_auto.suggest_crop` (face/person grounding for `person`,`person_detail` with headroom 0.12/margin 1.2; `<OD>` largest box otherwise; margin 0.5; ratio 1:1 if square else image ratio; returns ints `[x,y,w,h]` or None = keep centring). One bad file -> appended to `skipped`, job continues.
- `GET /api/crop/auto/{job_id}` -> `{state,total,processed,current,error,crops:{name:[x,y,w,h]},skipped:["name: err"]}`; 404 "Unknown job." when id missing or other kind. Legacy polls 800 ms with `setTimeout`, no timeout/cancel, **ignores `skipped`**. On `done` -> `CropPlan.merge(j.crops)`.
- Request values come from: `folder`=CropPlan.folder(), `mode`=#mode, `resolution`=#resolution (int), `step`=#step (int), `square`=#square==="true", `names`=[current file] (modal button only).

### 2.5 Process
- `POST /api/process` body `ProcessRequest` (SRV:162-188; plain pydantic, **no Field constraints**):
  `folder:str` (req); `mode="person"`; `style="concise"`; `resolution:int=1024`; `step:int=64`; `square:bool=False`; `fmt="png"` (png|jpg); `jpg_quality:int=95`; `model=captioner.DEFAULT_MODEL`; `quant="4bit"` (anything not 4bit/none -> 4bit); `max_tokens:int=512`; `do_caption:bool=True`; `caption_format="flux"` (flux|ideogram|aitoolkit — comment in code says only two but `prompts.py` treats ideogram+aitoolkit alike); `crop_mode="center"`; `fit="cover"`; `pad_color="#000000"`; `centering_x="center"`; `centering_y="center"`; `crops:dict[str,list[int]]={}`; `upscale_model=""`; `upscale_min_ratio:float=1.05`.
  Legacy builds it at APP:396: the explicit fields + `...CropPlan.settings()` (crop_mode, fit, pad_color, centering_x, centering_y) + `crops: CropPlan.all()` (ALWAYS sent; ignored server-side unless crop_mode in auto|manual). `parseInt("")` -> NaN -> `null` in JSON -> 422.
  400 if folder missing / no images. -> `{job_id, total}`. Starts a daemon thread (no queue; concurrent jobs allowed server-side).
- `GET /api/job/{job_id}` (SRV:856) -> `_job_public`: `{id, state, total, processed, current, error, config:<ProcessRequest dump>, results:[{idx, src_name, out_name, width, height, caption, upscaled:bool, upscale_error:str}]}`. 404 for non-"dataset" jobs. Returns ALL results every poll.
  States: `pending` (created) -> `loading_model` (VLM ensure/download + load, or upscaler load; `current` = "Downloading <label>… NN%" / "Loading the VLM model…" / "Loading the upscale model…") -> `processing` (`current` = src filename) -> `done` | `error` (job-level failure: `error` = `"{e}\n{full traceback}"`, so show only first line). VLM load skipped when `do_caption=false` or model is `lmstudio:*`.
  Per file (SRV:442-495): `image_utils.process_image` (EXIF transpose -> RGB; apply crop (clamped) -> bucket from CROP's aspect: `round(sqrt(res²·ar)/step)*step`, or res×res if square -> optional upscale hook (before final resize; skipped if `plan_passes<=0`, i.e. needed ratio <= 1.05; cover uses max axis ratio, contain min) -> `contain`: LANCZOS fit + pad_color canvas centred; `cover`: `ImageOps.fit` with centering (x,y)). Saved as `WORK/<job>/processed/{mode}_{i:04d}.{png|jpg}` (prefix is CAPTION MODE, i = index in sorted file list), thumb `WORK/<job>/thumbs/{i:04d}.jpg` (640 px, q80). Caption via local Qwen or LM Studio, `prompts.postprocess_caption(raw, fmt)` (flux: clean_caption; ideogram/aitoolkit: normalize_ideogram_v15). Result stores hidden `format` (not in public dict).
  Per-file failure: result `{out_name:"", width:0, height:0, caption:"[ERROR: msg]"}` (no `upscaled`/`upscale_error` keys; public dict defaults them); job continues, still reaches `done`.
  Upscale failures never fail a file: it falls back to LANCZOS and sets `upscale_error`; a failed model ensure is remembered for the rest of the job.
- `GET /api/thumb/{job_id}/{idx}` (SRV:917) -> JPEG file; 404 "No thumbnail." (e.g. failed files). No kind check.

### 2.6 Export
- Body `ExportRequest{job_id:str; output_folder:str=""; trigger:str=""; prepend_trigger:bool=True; captions:dict[str,str]={} (idx as STRING -> text); exclude_idx:list[int]=[]}` (SRV:199). Legacy builds it in `exportPayload()` (APP:560): ALL textarea values keyed `ta.dataset.idx`, `trigger` trimmed, `exclude_idx=[...state.deleted]`.
- `POST /api/export` (SRV:925) = payload + `output_folder` (trimmed; client rejects empty with "Enter a destination folder."). 404 unknown job; 400 "The job is not finished." unless `state==="done"`; 400 empty folder. `mkdir(parents=True, exist_ok=True)`; for each result not excluded and with `out_name`: `copy2` image, write caption files (overwrites silently). -> `{output_folder, written}`. Legacy text: "Saved N pairs (image + .txt) to: F".
- `POST /api/zip` (SRV:2384) same body (output_folder ignored) -> `application/zip` blob, `Content-Disposition: attachment; filename="dataset_{config.mode}_{job_id[:8]}.zip"`; 400 "No images to package." if 0 written. Built fully in memory. Legacy reads filename from header via regex, triggers `<a download>` with object URL.
- Caption resolution `_final_caption` (SRV:292): `captions.get(str(idx), original).strip()`; then if `prepend_trigger and trigger`: formats ideogram/aitoolkit -> `prompts.inject_trigger_ideogram` (prepends `"{trigger}, "` to JSON `high_level_description`; returns text UNCHANGED if not valid JSON dict); flux -> `"{trigger}, {caption}"` (or just trigger if caption empty).
- Files written (`_caption_output_files`): `{stem}.txt` = caption + "\n" always; format `ideogram` additionally `{stem}.json` (pretty-printed JSON, only if parseable); `aitoolkit` = txt only. Stem = out_name stem, e.g. `person_0003`.

## 3. User flows

### 3.1 Choosing a source
1. Folder: type path in `folderPath` -> Scan -> `setSrcInfo("Skanowanie…")` (Polish leftover) -> on success `state.{folder,count}`, `CropPlan.setSource(folder, files)` (loads localStorage plan, renders grid), info "Found N images in: F", enables Process if N>0; on error "Error: <raw text>" and Process disabled. There is NO folder picker for the source in legacy (v2 should use FolderPicker).
2. Upload: click dropzone -> hidden file input (multiple; accept image/*,.heic,.heif), or drag&drop. All files in ONE multipart POST; info "Uploading N files…" then "Uploaded N images." Each upload creates a NEW server folder (`WORK/uploads/<uuid>`), replacing the source and (because localStorage is keyed by folder) starting with an empty crop plan.
3. HEIC/HEIF: accepted by input `accept` and by server (`pillow_heif` optional dep, registered at import in image_utils.py:9; if the package is missing, HEIC files are listed but fail at thumb/process). Browsers cannot render HEIC, so grid thumbnails and crop editor ALWAYS come from the backend (`/api/src/thumb`, `/api/src/image`); no client-side preview of uploaded files exists.

### 3.2 Thumbnail grid (CE:50)
Cell per file: `<img loading="lazy" src=/api/src/thumb?folder&name>`, badge "✂" if cropped, name label (inserted as raw HTML, unescaped). Click -> `CropEditor.open(folder, name)`. Whole grid is re-rendered on every `set/remove/merge/clear/setSource`.

### 3.3 Crop modes
- `center` (default): plan ignored; whole frame, then `fit`/centering apply. `manual`/`auto`: per-file boxes from the plan; files without a box fall back to centre behaviour silently. **Selecting "Auto" in the dropdown does not compute anything**; it only means "use the plan". Boxes come from the "Auto-crop all" button or the modal's "Auto (Florence)".
- Manual editor (CE:151-358): open -> `fetch /api/src/image` (reads `X-Src-*` headers, blob -> `URL.createObjectURL`, revoked on close) -> modal unhidden, THEN `img.clientWidth/Height` measured (must be visible first) -> box = saved plan box or `defaultBox()` (largest box of forced ratio or image ratio, centred). Drag rect = move; drag handles = resize (ratio re-applied with anchors); arrow keys move 1 px (Shift = 10 px) via window keydown; Esc closes without saving; min box side 16 px source; clamped inside image. Ratio forced: `#square==="true"` -> 1; else `#cropRatio` (`free` = null). Changing `#cropRatio` re-applies (shrinking). Reset = default box. **Save** -> `CropPlan.set(name, [round x, y, w, h])` + `CropPlan.setMode("manual")` + close. **Apply to same ratio** -> fractional box applied to every file whose aspect ratio is within 0.02 of this image's (fetches every file's `/api/src/image` just for headers), `CropPlan.set` each (N re-renders), mode -> manual, close (does not save a different box for the current image beyond that same rule). **Auto (Florence)** -> `/api/crop/auto` with `names:[cur.name]`, poll, merge, redraw box (does not close and does not set mode manual).
- Batch "✂ Auto-crop all": if plan non-empty `confirm("Auto-crop all will recompute crops for every photo and replace N existing crop(s). Continue?")` (singular "1 existing crop"); disable button; `cropInfo` = "Auto-cropping…" then "Auto-crop: P/T — current"; on done `CropPlan.merge` + `CropPlan.setMode("manual")`; on error `cropInfo` = "Auto-crop error: …". (merge, not replace, despite the confirm text: files with no detected box keep their old crop.) For landscape/architecture modes the job returns no boxes at all but the mode is still flipped to manual.

### 3.4 Fit / background / centering / upscale
`fit=cover` crops to fill (centering x/y choose anchor; "top" fixes head cut-off); `fit=contain` letterboxes with `pad_color`. Upscale: choose model in `upscaleModel` ("Off" = plain LANCZOS); applied per image only when crop < bucket by more than 5 %; models auto-downloaded inside the job if not cached (job in `loading_model`, `current` shows progress; needs Models folder set, else per-job upscale_error / error). Results show "✨" on upscaled images; first failure is surfaced in `#upscaleWarn`.

### 3.5 Processing + progress
Click Process -> disable btn, show progressCard, hide results/export, clear `#results` DOM, reset `state.deleted`, progress 0 "Start…"; POST -> `state.jobId`, `pollJob(job_id,total)` every 1000 ms (APP:435): `loading_model` -> 2 % + `job.current`; `processing`/`pending` -> `round(processed/total*100)` + "Przetworzono P/T — current" (Polish leftover) + `renderResults`; `done` -> 100 %, "Done: N images.", renderResults, show exportCard, enable btn, `refreshGpu()`; `error` -> "Processing error: <job.error>" (includes traceback), enable btn. **Any thrown fetch error stops polling for good** (no retry).

### 3.6 Caption review & editing
Cards are created once per `idx` as results arrive (during processing); `textarea.value` is set only on creation, so later polls never clobber edits. Edits live ONLY in the DOM textareas (no per-edit server call, no autosave, lost on reload). They are sent in bulk at export as `captions{idx: text}` for every present card (unedited ones too, so the server always uses the textarea text; an emptied textarea exports an empty/trigger-only caption). The "✕" button removes the card from DOM and adds idx to `state.deleted` (client Set; sent as `exclude_idx`); `exportCount` = "To export: N images (M removed)." where N counts cards in DOM — failed files (out_name "") are counted though the server skips them. No undo for removal.

### 3.7 Export
Folder: needs `job_id` + non-empty output folder; "Eksportowanie…" then "Saved N pairs (image + .txt) to: F" / "Export error: …". Zip: "Pakowanie do .zip…" -> blob download -> "Downloaded: <fname>" / "Packaging error: …". No confirmation on overwrite; buttons are not disabled while running.

## 4. crop_editor.js public interface

Two globals, plain script (not a module), loaded after app.js (index.html:~796) and it depends on app.js's global `api` and on DOM ids.

`window.CropPlan` (IIFE, CE:5), internal `folder`, `files[]`, `plan{}`, `mode`:
- `setSource(folder, filesArray)` — set source, `load()` from localStorage, `render()`.
- `files()` copy, `folder()`, `get(name)` -> `[x,y,w,h]|null`, `set(name, box)`, `remove(name)` (unused by UI), `merge(boxesObj)`, `clear()`, `all()` shallow copy, `setMode(m)` (sets `#cropMode.value` AND saves), `settings()` -> `{crop_mode, fit, pad_color, centering_x, centering_y}` read from DOM.
- Each mutator does `save()` + full `render()`.
`window.CropEditor.open(folder, name)` — the only export; called by grid cell click. Everything else is wired through DOM listeners at load.
Crop plan format: `{ "<source file name>": [x, y, w, h] }`, ints, ORIGINAL pixels after EXIF orientation fix, keyed by bare file name (no path). Backend schema `dict[str, list[int]]` (floats would 422; modal rounds). `image_utils.clamp_box` clamps to image bounds at process time.
localStorage: key `"cropPlan:" + folder` where folder is exactly the string returned by scan/upload (e.g. `/home/u/photos`, or `…/.work/uploads/<uuid>`); value `JSON.stringify({plan, mode})`, mode in `center|auto|manual`. Load rules (CE:17-34): record with `.plan` -> use plan+mode; bare object (older format) -> treated as plan; if mode empty but plan non-empty -> `"manual"`; if mode set -> `#cropMode.value = mode` (overrides user's dropdown on every `setSource`). Save is a no-op when folder is null; failures only `console.warn`. `#cropMode` change listener persists the mode (CE:146). Plan is sent as `crops` in POST /api/process (and not to /api/crop/auto, which returns boxes that are merged client-side).
No other localStorage/sessionStorage in the Dataset view (grep of frontend/*.js: only crop_editor.js).

## 5. State a port must preserve
- `state = {folder, count, jobId, deleted:Set<idx>}` (APP:17).
- Crop plan + crop mode per folder in localStorage (above); plan lost for uploads (new folder id each time).
- Caption textareas (the only copy of edits), trigger text, prependTrigger, output folder: pure DOM, nothing persisted. Settings form is NOT persisted in legacy (v2 could use `PUT /api/settings/forms/dataset` + `useAutosave`).
- Server-persisted: LM Studio URL (only when Refresh clicked), HF token, models_dir, upscale folder + custom list, custom VLM list, selected GPU.
- Model dropdown shared with Prompt studio (`#model` and `#pModel` filled together); upscale dropdown shared with Upscale view (`#uModel`).
- Job ids are not remembered across reload: results/export are lost (server files remain until manually cleaned).

## 6. Surprising / fragile points
1. "Auto" crop source without running auto-crop = silent centre crop (plan empty). Auto and manual are the SAME server path (`_crop_for` reads the plan for both); the only difference is who drew the box (SRV:256).
2. `crops` always sent; crop plan entries for deleted/renamed files are never pruned; files unknown to the folder are just unused.
3. Upload handler never checks `res.ok`: a 4xx/5xx JSON `{detail}` gives `r.folder===undefined`; UI says "Uploaded undefined images." and `processBtn.disabled=(undefined===0)` -> enabled, but click no-ops because `state.folder` falsy. Port should check status. Upload with only unsupported files returns count 0 with no error.
4. Scan `folder` returned is `expanduser` only (not resolved) and is used verbatim as the localStorage key and in `/api/src/*` query (server resolves). A trailing slash or `~` variant makes a different plan key. Server also uses different hash for thumbnails (resolved path), fine.
5. Output filenames use `{caption_mode}_{i:04d}`; `i` is position in the sorted list, so removed/failed files leave gaps and mode "style" yields `style_0000.png`. Failed items have `out_name:""` and render a card with broken thumb, `0×0`, and the `[ERROR: …]` text as editable caption (never exported; still counted in "To export").
6. `lmstudioUrl` edits are only saved on "Refresh models"; process uses the server-stored URL. `lmstudio:*` model => `quant` ignored, no download, captions via HTTP to LM Studio (reasoning models need >=2048 tokens; empty answer error text from `lmstudio.py`).
7. Ideogram/ai-toolkit captions are JSON strings; user edits are raw text. If the edited JSON is invalid the trigger is NOT injected and no `.json` is written (silently). The trigger preview text under each card is misleading for those formats.
8. `captions` payload includes every textarea, so server never falls back to the model's caption for visible cards; deleting a card also removes it from `captions`, so `exclude_idx` is partly redundant but still required for correctness if a client sends only edits.
9. `ProcessRequest` has no validation: `step=0` -> every file fails in `compute_bucket` (ZeroDivision) but job still ends `done`; NaN ints -> 422 with `detail` as list of `{msg}` (v2 `api.ts` already flattens this).
10. `GET /api/job/{id}` returns all results each poll (O(n²) over a run). Poll never backs off; the legacy loop dies on the first network error (recent commit 2d4c4a8 says v2 "polls through transient errors" — mirror that). `job.error` embeds a full traceback.
11. `/api/crop/auto` `skipped` is never shown; `job.error` also traceback-laden; no cancel for either job type. Auto-crop on landscape/architecture is a no-op "success".
12. Modal measures `img.clientWidth/Height` once at open; window resize or a different layout breaks overlay scale (`scale = viewW/srcW`). Arrow-key handler is on `window` and also fires while typing in other inputs if modal open. Handles use pointer events attached to `window` during drag. Port should use ResizeObserver.
13. "Apply to same ratio" fires one `/api/src/image` request per file (each decodes the full image server-side) and rewrites all matching crops including existing ones.
14. Confirm text for Auto-crop all says "replace" but implementation merges.
15. `/api/src/image` is downscaled to 1600 px; the crop box math uses true source size headers, so keep using `X-Src-Width/Height` (not `naturalWidth`).
16. `/api/export` overwrites existing files without warning and returns `written` which can be 0 (no 400, unlike zip).
17. `/api/zip` is built fully in memory and error bodies are JSON; success is a binary blob, so a port must branch on `res.ok` before `.json()`.
18. Strings mixed Polish/English in legacy ("Skanowanie…", "Przetworzono", "Eksportowanie…", "Pakowanie do .zip…", "(opis)", alerts in `pickModelFolder`); use English in the port.
19. `zenity` folder picker only works on Linux/WSLg; `/api/fs/pick` blocks the request up to 300 s. v2 `FolderPicker` + `/api/fs/list` is the portable replacement.
20. Auto-crop and process both need the Models folder set when Florence/VLM/upscaler weights are missing; failure surfaces as job `error` (process) or `error` (crop) — not at POST time. Dataset POSTs themselves only 400 on folder problems.
21. Per-file image `<img>` and name labels in legacy are string-concatenated HTML (filenames unescaped); React escaping fixes this, but `encodeURIComponent` for `folder`/`name` query values is required.
22. Origin guard middleware (origin_guard.py) rejects cross-origin dev requests unless `FLUX_PREP_DEV_ORIGINS`/extra hosts set; v2 dev server needs that env.

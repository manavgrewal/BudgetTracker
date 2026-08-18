# Receipt OCR engine swap and scanner capture: Design Spec (v1.5.0)

**Date:** 2026-08-18
**Status:** approved design. Ships as **v1.5.0**.
**Base specs:** `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (the master spec; bare section references are to it), `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (*warranty §n*, which owns the current OCR design in its §7), and `docs/superpowers/specs/2026-08-17-update-loans-design.md` (*update §n*).
**Research input:** `.superpowers/research/2026-08-18-ocr-stack.md`, dated 2026-08-18. Every version number, download URL, SHA256 and file size in §3 comes from that document and must not be "corrected" from model memory.

Requirement labels (**MUST-n.m**) are binding and are written so that each one is testable.

This release replaces one thing and adds one thing:

1. **The OCR engine.** tesseract.js goes from being the engine to being the fallback. A self-implemented PP-OCRv5 pipeline on onnxruntime-node becomes the engine on hardware that can run it.
2. **Scanner-style capture.** After the phone's camera hands back a still image, the browser finds the paper, straightens it and crops it before the upload leaves the device.

Warranty §7's queue, its crash sweep, its idle teardown, its timeout, its three-value `ocr_status`, its truncation cap and everything downstream of "text out" are **unchanged**. One warranty-spec statement is narrowed rather than withdrawn: warranty MUST-7.2's "recognition runs in the library's Node worker (its own process)" describes tesseract.js and now applies only when tesseract.js is the active engine. §4.10 states what replaces it for the ONNX path and why the reasoning behind MUST-7.2 is still honoured.

---

## 1. Overview

### 1.1 The problem, stated as the owner reported it

The owner photographed real receipts, uploaded them, and got text back that was useless. Not slightly worse than hoped; useless. Suggested vendor, date and price were wrong or absent, and the FTS5 index filled with garbage tokens. tesseract.js reading a hand-held, angled, creased, low-contrast thermal receipt is the known-weak case for a classical LSTM line recogniser trained on document scans.

Two independent causes, so two changes:

- The **recogniser** is wrong for this input. PP-OCRv5's detection-plus-recognition pipeline was trained on exactly this class of photographed, in-the-wild text.
- The **input** is wrong for any recogniser. A receipt photographed at an angle on a kitchen counter, with the counter in frame, gives every engine a hard problem before it starts. Finding the paper and flattening it in the browser removes that problem at the source.

### 1.2 What an owner sees

Uploading a receipt photo from a phone still opens the phone's own camera app, exactly as it does today. After the photo is taken, the uploader shows the photo and, beside it, the same photo with the receipt found, straightened and cropped, with the detected outline drawn on the original. After four seconds the straightened version uploads on its own. A **Use the original** button uploads the untouched photo instead. Nothing about the form changes; Save is enabled the whole time, as warranty MUST-10.2 requires.

The read that comes back is materially better on the owner's own receipts. That is the entire point of the release and it is the last item on the acceptance checklist.

### 1.3 What does not change

| Concern | Status |
|---|---|
| Database schema | **No migration.** No table, no column (§12) |
| `OcrEngine` interface (`recognize(filePath, mime) => { text }`) | Unchanged. It stays the only way a caller reaches recognition (warranty MUST-7.17) |
| The FIFO queue, concurrency 1, claimed-id set, crash sweep | Unchanged (`src/lib/warranty/ocr/queue.ts`, §6) |
| `OCR_TIMEOUT_MS = 120_000`, `OCR_IDLE_TERMINATE_MS = 60_000`, `MAX_OCR_TEXT_CHARS = 100_000` | Unchanged values |
| `suggestFromOcrText` and everything in `src/lib/warranty/suggest.ts` | Unchanged. §4.9 exists to keep its line-oriented assumptions valid |
| `src/lib/warranty/search.ts` and the FTS5 triggers | Unchanged. Better text goes into the same index through the same trigger |
| The PDF path | Unchanged (§7) |
| Runtime egress | Still zero (§11) |
| `capture="environment"` on the file input | Unchanged. There is no viewfinder and no `getUserMedia` (§8.1) |

### 1.4 Non-goals for v1.5.0

No multi-language recognition. The recognition model is `en_PP-OCRv5_rec_mobile.onnx` and the charset is English plus digits plus the punctuation and currency symbols that ship in its dictionary. No live camera viewfinder. No paste-a-block-of-text input; the owner rejected it explicitly and it is recorded in §18 so nobody re-proposes it. No table or layout analysis, no line-item extraction, no column reconstruction. No GPU or NPU execution provider. No automatic mass re-OCR of the existing corpus. Full list in §18.

---

## 2. Architecture delta

| Concern | Decision |
|---|---|
| New library dir | `src/lib/warranty/ocr/onnx/` (**new**, layout in §2.1) |
| New library dir | `src/lib/scanner/` (**new**, the browser-side loader, §8.2) |
| New scripts | `scripts/fetch-ocr-models.mjs`, `scripts/ocr-probe.mjs`, `scripts/vendor-scanner-assets.mjs` |
| New vendored assets | `vendor/ocr-models/` (4 files plus a NOTICE), `public/scanner/` (3 files) |
| New runtime deps | `onnxruntime-node@1.27.0`, `sharp@^0.35.3`, `jscanify@1.4.3`, `@techstark/opencv-js@4.7.0-release.1` |
| Retained dep | `tesseract.js@^6.0.1` and `tesseract.js-core` stay, as the §5 fallback. `vendor/tessdata/eng.traineddata.gz` stays |
| Migration | **None** (§12). The probe result rides the existing `settings` key/value table |
| New page | **None.** Settings, About gains one Notice; the uploader gains a preview pane |
| New route handler | **None.** The staging route and the re-OCR server action are reused unchanged |
| Docker | Platform-dir strip, four new COPY lines, an amended asset guard (§10) |
| CSP | `script-src` gains `'wasm-unsafe-eval'` (§8.6). This is required and is the only security-header change |
| Scheduler | Unchanged. No new tick |

### 2.1 `src/lib/warranty/ocr/onnx/` layout (all files new)

```
src/lib/warranty/ocr/onnx/
  constants.ts    every pinned numeric constant in §4.11 (PURE, no imports)
  models.ts       vendored-asset paths, SHA256 pins, assertOnnxAssets()   (§3.3)
  dict.ts         dictionary load + the index table + the class-count check (§4.8)
  preprocess.ts   sharp stage: orient, flatten, grey, normalise, upscale, deskew (§4.2)
  detect.ts       det tensor in, DBNet postprocess, boxes out              (§4.3, §4.4)
  contours.ts     PURE: binarize, dilate, connected components, min-area rect, unclip (§4.4)
  crop.ts         per-box crop and rotate via sharp                        (§4.5)
  classify.ts     angle classifier, 180-degree flip                        (§4.6)
  recognize.ts    rec tensor in, batching, CTC greedy decode               (§4.7, §4.8)
  assemble.ts     PURE: boxes plus strings to the final text               (§4.9)
  session.ts      the three InferenceSessions, creation, disposal          (§4.10)
  engine.ts       the OcrEngine implementation that wires the stages       (§4.1)
  probe.ts        the child-process compatibility probe and its cache      (§5)
```

**MUST-2.1** `constants.ts`, `contours.ts` and `assemble.ts` are **pure**: no `@/db` import, no `@/lib/env` import, no `node:` builtin, no `onnxruntime-node` import, no `sharp` import. They take arrays and numbers and return arrays and numbers. This is what makes §13.2's unit tests possible without a model file, and `constants.ts` in particular is imported by the client scanner for two shared limits, so update MUST-2.1's client-bundle rule applies to it.

**MUST-2.2** Nothing under `src/lib/warranty/ocr/onnx/` is imported, directly or transitively, from any `'use client'` file, except `constants.ts` and then only via `import type` or a named numeric import. A test asserts this with the existing banned-module regex used for `@/lib/update/*`.

**MUST-2.3** `onnxruntime-node` is imported in exactly **two** places in the whole tree: `src/lib/warranty/ocr/onnx/session.ts` and `scripts/ocr-probe.mjs`. Both imports are dynamic (`await import(...)`), so a boot on hardware where the native binding cannot even load does not take the process down at module-evaluation time. A grep test pins both sites and fails on a third.

### 2.2 Files modified (exhaustive for source, ops and docs)

| File | Change |
|---|---|
| `src/lib/warranty/ocr/engine.ts` | Becomes the selector: picks the ONNX or tesseract implementation per §5.4; `terminateOcrWorker` is renamed `releaseOcrEngine` and now disposes whichever engine is live (§4.10) |
| `src/lib/warranty/ocr/assets.ts` | Keeps the tesseract asset resolution verbatim; gains nothing. The ONNX assets live in `onnx/models.ts` |
| `src/lib/warranty/ocr/queue.ts` | Two lines: the import and the call site both follow the `terminateOcrWorker` to `releaseOcrEngine` rename. No behaviour change |
| `src/lib/warranty/ocr/pdf.ts` | **Unchanged** (§7) |
| `src/components/warranty/ReceiptUploader.tsx` | The scan-preview state machine (§8.3) between file pick and `upload()` |
| `src/components/warranty/ReceiptScanPreview.tsx` | **New**: the before/after pane, the countdown, the two buttons (§8.3) |
| `src/lib/scanner/load.ts` | **New**: the single, cached, lazy OpenCV plus jscanify loader (§8.2) |
| `src/lib/scanner/scan.ts` | **New**: quad detection, validation, warp, JPEG encode (§8.3) |
| `src/lib/auth/security-headers.ts` | `script-src` gains `'wasm-unsafe-eval'` (§8.6) |
| `src/app/(app)/settings/about-panel.tsx` | One `Notice` when the probe fell back (§5.5) |
| `src/app/(app)/settings/page.tsx` | Reads `readOcrEngineState()` and passes it to the About panel |
| `next.config.ts` | `serverExternalPackages` gains `onnxruntime-node` and `sharp` (§10.3) |
| `Dockerfile` | The platform strip, four COPY lines, the amended guard (§10.1) |
| `scripts/check-ocr-assets.mjs` | Six new required paths plus SHA256 verification of the four model assets (§10.2) |
| `scripts/fetch-ocr-models.mjs` | **New** (§3.2) |
| `scripts/ocr-probe.mjs` | **New** (§5.2) |
| `scripts/vendor-scanner-assets.mjs` | **New** (§8.2) |
| `package.json` | Four dependencies added, `version` to `1.5.0`, three scripts added |
| `.github/workflows/release-image.yml` | The guard step comment is corrected; a step runs `scripts/vendor-scanner-assets.mjs` before the asset check (§10.4) |
| `CHANGELOG.md`, `README.md`, `INSTALL.md` | §14 |

`src/lib/warranty/suggest.ts`, `src/lib/warranty/search.ts`, `src/lib/warranty/items.ts`, `src/lib/scheduler.ts`, `src/db/schema.ts` and every migration are **not** modified. `src/app/(app)/warranties/actions.ts` is **not** modified: `reRunOcrAction` already does the right thing (§9).

### 2.3 Dependencies, pinned

**MUST-2.4** These four are added to `dependencies`, at these exact specifiers, and the reason each is pinned rather than caret-ranged is recorded in a comment above the block in `package.json`:

| Package | Specifier | License | Why this pin |
|---|---|---|---|
| `onnxruntime-node` | `1.27.0` (exact) | MIT | Exact, because the ARM instruction-set risk in §5 is a property of a specific ORT build. A silent minor bump changes the MLAS kernels this release was probed against |
| `sharp` | `^0.35.3` | Apache-2.0 | Caret is fine; per-platform optional deps, mature. Note that 0.34.5 is currently present only as a transitive of Next; this promotes it to a direct dependency |
| `jscanify` | `1.4.3` (exact) | MIT | Exact, because it is pinned against one OpenCV.js API generation |
| `@techstark/opencv-js` | `4.7.0-release.1` (exact) | Apache-2.0 | Exact, and it must be this one. The 5.0.x builds from the same publisher change enough API surface that pairing them with jscanify 1.4.3 is untested |

**MUST-2.5** No package under an AGPL, GPL, LGPL, SSPL or source-available licence enters the tree. The four above are MIT or Apache-2.0, confirmed in the research doc §1, §2, §4 and §5.

---

## 3. Vendored models and the recognition dictionary

### 3.1 The exact files

**MUST-3.1** Four files live in `vendor/ocr-models/`, committed to the repository as plain binary blobs. No Git LFS, no submodule, no post-install download. This is the same pattern `vendor/tessdata/eng.traineddata.gz` (1,962,155 bytes, committed) has used since v1.2.0, and it exists so that an offline LAN install has no dependency on ModelScope staying up, on npm resolution, or on the build host having a route to the internet.

| File | Role | Size | SHA256 |
|---|---|---|---|
| `ch_PP-OCRv5_det_mobile.onnx` | DBNet text detection | 4.60 MB | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `en_PP-OCRv5_rec_mobile.onnx` | CTC text recognition, English | 7.51 MB | `c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8` |
| `ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx` | Textline orientation, 2 classes | under 1 MB | `54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7` |
| `en_dict.txt` | The recognition dictionary (§3.5) | a few KB | computed by the fetch script (§3.2) |

**MUST-3.2** The three `.onnx` files are downloaded from, and only from:

```
https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx
https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile.onnx
https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx
```

The tag `v3.9.2` is part of the path and is never replaced with `main` or `master`. A moving reference is how a model silently changes underneath a SHA256 that was correct last month. The three hashes above are the values RapidOCR publishes in `python/rapidocr/default_models.yaml` at that same tag.

**MUST-3.3** We use **PP-OCRv5**, not PP-OCRv6. The research doc records that RapidOCR v3.9.0 made PP-OCRv6 the default and claims better numbers, and it also records that v5 is the mature, field-tested generation with clean English mobile models. This release is fixing a reliability complaint, not chasing a benchmark. PP-OCRv6 is a follow-up evaluation, listed in §18.

**MUST-3.4** We use `en_PP-OCRv5_rec_mobile.onnx`, not `latin_PP-OCRv5_rec_mobile.onnx`. Same size class (7.51 MB against 7.54 MB), narrower charset, and the receipts in question are US and Canadian English. Swapping to the Latin model later is a two-line change to `models.ts` plus a new dictionary file, and §18 records it as the escape hatch if accented vendor names ever matter.

### 3.2 `scripts/fetch-ocr-models.mjs`, the contract

**MUST-3.5** The script is run **by a maintainer with internet access**, never by `docker build`, never by a test, never by the app, and never by a `postinstall` hook. Its header comment says so in those words, copied in shape from `scripts/fetch-tessdata.mjs`. `npm run fetch-ocr-models` invokes it.

**MUST-3.6** For each of the three `.onnx` URLs, in order, the script:

1. `fetch`es the URL with no headers beyond the default and no authentication. ModelScope serves these unauthenticated; the research doc confirmed this with an unauthenticated `curl`.
2. Refuses a non-2xx response with a nonzero exit and the status line.
3. Refuses a body smaller than 400,000 bytes, on the same "a captive portal returned an HTML error page" reasoning that makes `fetch-tessdata.mjs` refuse anything under 1,000,000 bytes.
4. Computes the SHA256 of the received bytes and compares it against the pinned value from MUST-3.1. **A mismatch is a hard failure**: the file is not written, nothing already on disk is overwritten, and the script exits nonzero naming both hashes. This is the verification step, and it happens before any byte lands in `vendor/`.
5. Writes the file to `vendor/ocr-models/<upstream filename>`, keeping the upstream filename verbatim so provenance is readable from a directory listing.

**MUST-3.7** For `en_dict.txt` the script cannot verify against a published hash, because RapidOCR does not publish one for the dictionary resources (research doc §2). Instead it:

1. Downloads the dictionary from ModelScope's `paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt` resource at tag `v3.9.2`, the exact `dict_url` RapidOCR pairs with `en_PP-OCRv5_rec_mobile` in `python/rapidocr/default_models.yaml`. **Corrected 2026-08-18**: the RapidOCR GitHub source tree carries no dictionary files at this tag (`python/rapidocr/models/` holds only a `.gitkeep`); the four GitHub-raw candidate paths considered during implementation all 404.
2. Refuses a body that does not decode as UTF-8, that contains a CRLF, that contains a blank line other than a single trailing newline, or that has fewer than 400 or more than 500 lines. **Corrected 2026-08-18**: the real `en_PP-OCRv5_rec_mobile` dictionary has 436 entries, not the 90 to 200 a short ASCII-only PaddleOCR dictionary would need; it carries Latin-extended and punctuation characters beyond plain ASCII. The corrected bounds still catch an HTML error page, a redirect stub, the unrelated 95-line ASCII-only `ppocr/utils/en_dict.txt`, and the wrong dictionary (the Chinese `ppocr_keys_v1.txt` has thousands of lines).
3. Writes it, then **prints its SHA256** and the instruction to paste that value into `OCR_DICT_SHA256` in `src/lib/warranty/ocr/onnx/models.ts`. This is exactly the `TESSDATA_SHA256` workflow already in the repository, and it is used here because the upstream hash does not exist to pin against.

**MUST-3.8** The script prints, for every file it wrote, the path, the byte count and the SHA256, and finishes with a single line stating the total bytes written. A maintainer running it must be able to paste that output into a release note.

**MUST-3.9** The script writes a `vendor/ocr-models/NOTICE` file, generated rather than hand-maintained, containing: the RapidOCR repository URL and the exact tag `v3.9.2`; the three model URLs; the three pinned SHA256 values; the statement that the models are Apache-2.0, that the conversion scripts are copyright RapidOCR Authors 2021, and that the underlying weights are copyright Baidu under PaddlePaddle/PaddleOCR's Apache-2.0 licence; the full Apache-2.0 licence text; and the date the file was generated. §13.4 asserts the file exists and names all three hashes.

### 3.3 `models.ts` and verification at run time

**MUST-3.10** `src/lib/warranty/ocr/onnx/models.ts` is the **single** place the four vendored paths are computed, resolving against `process.cwd()` (which is `/app` in the container and the repo root in dev and test), and every value it returns is an absolute filesystem path. This mirrors warranty MUST-7.4's rule for the tesseract assets, for the same reason.

**MUST-3.11** It exports the four pinned SHA256 constants and:

```ts
export interface OnnxOcrAssets {
  detPath: string;
  recPath: string;
  clsPath: string;
  dictPath: string;
}
export function resolveOnnxOcrAssets(): OnnxOcrAssets;
/** Existence only. Cheap enough to call at boot. */
export function assertOnnxOcrAssets(): { ok: boolean; missing: string[] };
/** Existence plus SHA256 of all four. Called ONCE, lazily, before the first session is created. */
export function verifyOnnxOcrAssets(): { ok: boolean; problems: string[] };
```

**MUST-3.12** `verifyOnnxOcrAssets()` runs **once per process**, memoised, immediately before the first `InferenceSession` is created, and never on the request path afterwards. Hashing 12.7 MB costs roughly 60 ms once. A failure throws `OcrUnavailableError` with the existing `OCR_UNAVAILABLE_MESSAGE`; it does not crash the app. Warranty MUST-7.6's rule holds unchanged: a warranty tracker without OCR is still a warranty tracker, a container that refuses to boot is not.

**MUST-3.13** A corrupt or swapped model must never be silently tolerated. `verifyOnnxOcrAssets()` failing puts the install on the §5 tesseract path for the life of the process, logs one line naming which file failed and its actual hash, and surfaces the §5.5 warning. It does **not** rewrite the cached `ocr.engine` setting, because a bad file is not a hardware verdict.

### 3.4 Where the license provenance is recorded

**MUST-3.14** Three places, and a test checks each: the generated `vendor/ocr-models/NOTICE` (MUST-3.9); a header comment in `models.ts` naming the licence, the upstream project and the tag; and one paragraph in `README.md` naming PP-OCRv5, RapidOCR, PaddleOCR, Baidu and Apache-2.0. Nothing in the UI renders any of this; it is a repository fact, not a product feature.

### 3.5 The dictionary

**MUST-3.15** `dict.ts` loads `en_dict.txt` once per process and builds the CTC index table by exactly this procedure, in this order, and no other:

1. Read the file as UTF-8 and split on `\n`.
2. Drop a single trailing empty element if the file ends with a newline. **Do not trim any other whitespace and do not drop any other empty line**; a space character on its own line is a legitimate dictionary entry in some PaddleOCR dictionaries and trimming it silently shifts every index after it.
3. If `REC_USE_SPACE_CHAR` is true (§4.11), append a single `' '` element.
4. Prepend one element for the CTC blank. The blank occupies index `REC_BLANK_INDEX = 0`.

The resulting array's length is the expected class count.

**MUST-3.16 (the mismatch guard, and it is load-bearing).** At recognition-session creation, the class count from step 4 is compared against the last dimension of the recognition model's declared output shape. **If they differ, recognition never runs**: `dict.ts` throws, the engine reports `OcrUnavailableError`, and one log line names both numbers. The research doc is explicit that the exact dictionary file matching `en_PP-OCRv5_rec_mobile.onnx` had to be identified during implementation and that RapidOCR reorganised that directory across releases. A wrong dictionary does not fail loudly on its own; it decodes every receipt into plausible-looking nonsense, which is indistinguishable from the bug this release exists to fix. This guard is the difference between shipping a fix and shipping the same complaint with a new engine name.

---

## 4. The PP-OCRv5 pipeline

### 4.1 The engine seam and the stage order

**MUST-4.1** `src/lib/warranty/ocr/onnx/engine.ts` exports one object satisfying the existing `OcrEngine` interface. It adds no method, changes no signature, and returns `{ text: string }`. Everything in this section happens inside its `recognize()`.

**MUST-4.2** For `mime === 'application/pdf'` it delegates to the unchanged `extractPdfText` (§7) and performs no inference. For the three image mimes the stages run in exactly this order, each one the sole responsibility of its module:

1. `preprocess.ts`: orient, flatten, greyscale, contrast-normalise, upscale-if-small, deskew (§4.2).
2. `detect.ts`: build the detection tensor, run the det session (§4.3).
3. `contours.ts` via `detect.ts`: binarize, dilate, label components, min-area rectangles, unclip, filter, sort (§4.4).
4. `crop.ts`: extract and rotate one image per surviving box (§4.5).
5. `classify.ts`: batch the crops through the orientation model, flip the ones it says are upside down (§4.6).
6. `recognize.ts`: batch the crops through the recognition model (§4.7) and CTC-decode each row (§4.8).
7. `assemble.ts`: group boxes into lines, order them, join into one string (§4.9).

**MUST-4.3** No stage swallows an error. Any throw propagates out of `recognize()` and is recorded by the queue as a failed job with its message, exactly as a tesseract failure is today. The one exception is stage 5: an orientation-classifier failure logs one line and continues with the unflipped crops, because a wrong-way-up guess is worse than no guess but a crashed classifier should not cost the whole receipt.

### 4.4 is where the fiddliest arithmetic lives; every number cited in §4.2 through §4.9 is defined once in §4.11 and imported, never written inline.

### 4.2 Stage 1: sharp preprocessing

**MUST-4.4** `preprocess.ts` takes a filesystem path and returns `{ data: Buffer; width: number; height: number }` holding raw RGB, 3 channels, 8 bits per channel, no alpha. The sharp pipeline is exactly:

1. `sharp(path, { limitInputPixels: PREPROCESS_MAX_INPUT_PIXELS, failOn: 'error' })`.
2. `.rotate()` with **no argument**, which applies the EXIF orientation tag and then strips it. A phone photo taken in portrait is stored landscape with an orientation tag; skipping this reads every such receipt sideways. This is the single highest-value line in the module.
3. `.flatten({ background: '#ffffff' })`, so a PNG with transparency does not become black text on black.
4. `.greyscale()`.
5. `.normalise({ lower: NORMALISE_LOWER_PERCENTILE, upper: NORMALISE_UPPER_PERCENTILE })`. Percentile-bounded rather than absolute min and max, so one specular highlight from a kitchen light does not anchor the stretch and flatten the rest of the receipt.
6. If the long side is below `PREPROCESS_MIN_LONG_SIDE_PX`, resize up by `min(PREPROCESS_MIN_LONG_SIDE_PX / longSide, PREPROCESS_MAX_UPSCALE)` with `kernel: 'lanczos3'`. If the long side exceeds `PREPROCESS_MAX_LONG_SIDE_PX`, resize down to it. Both are `fit: 'inside'`, aspect preserved.
7. Deskew per MUST-4.5.
8. `.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })`, giving 3 identical channels. The models take 3 channels; feeding them a greyscale-derived 3-channel image is deliberate, because a colour cast on a thermal receipt carries no signal and costs contrast.

**MUST-4.5 (deskew, defined precisely enough to test).** Skew is estimated by a horizontal projection profile search, not by Hough transform and not by a second detection pass:

1. Downsample a copy to `DESKEW_PROFILE_LONG_SIDE_PX` on the long side.
2. Binarize it at the Otsu threshold of that copy.
3. For each angle from `-DESKEW_SEARCH_MAX_DEG` to `+DESKEW_SEARCH_MAX_DEG` inclusive in steps of `DESKEW_SEARCH_STEP_DEG`, rotate the binary copy by that angle about its centre with nearest-neighbour sampling, sum the dark pixels per row, and score the angle as the **variance** of that row-sum vector. Horizontal text lines produce sharp peaks and troughs; the variance is maximal when the lines are level.
4. Take the highest-scoring angle. If its absolute value is below `DESKEW_MIN_APPLY_DEG`, do nothing. Otherwise apply `.rotate(-angle, { background: DESKEW_BACKGROUND })` to the full-resolution image.

That is 41 candidate angles over an 800 pixel long side, which is a few million integer operations. It runs once per receipt.

**MUST-4.6** The deskew search runs on a downsampled copy and never on the full image, and the rotation it applies is a single `sharp` call on the full image. A test asserts that a synthetically rotated fixture (a black bar grid tilted 4.0 degrees) is measured within 0.5 degrees.

### 4.3 Stage 2: the detection tensor

**MUST-4.7 (Task 2 correction: `limit_type` is `'min'`, not `'max'`; see MUST-4.42).** The preprocessed image is resized for detection by this rule, which is RapidOCR's and PaddleOCR's `DetResizeForTest` with `limit_type = DET_LIMIT_TYPE = 'min'`:

1. When `min(width, height) < DET_LIMIT_SIDE_LEN`, `ratio = DET_LIMIT_SIDE_LEN / min(width, height)`. Otherwise `ratio = 1.0`. With `'min'` type the detector scales a small image up to the floor and leaves a large one alone; it can still upscale here even though MUST-4.4 step 6 already upscaled the long side, because that step's floor is on the long side and this one is on the short side of a possibly non-square crop.
2. `resizeW = max(round(width * ratio / DET_SIZE_MULTIPLE) * DET_SIZE_MULTIPLE, DET_SIZE_MULTIPLE)`, and the same for height. **Round to nearest**, not ceiling: PaddleOCR rounds, and using ceiling here shifts every box by up to 31 pixels relative to the reference implementation.
3. Record `scaleX = width / resizeW` and `scaleY = height / resizeH`. Every box coordinate produced in §4.4 is multiplied back by these before it is used to crop.

**MUST-4.8 (Task 2 correction: the mean and std are RapidOCR's uniform triple, not ImageNet's; see MUST-4.42).** The tensor is `float32`, NCHW, shape `[1, 3, resizeH, resizeW]`, channel order **RGB**, built as `value = (pixel / 255 - DET_MEAN[c]) / DET_STD[c]` per channel. The mean and std triples are both `[0.5, 0.5, 0.5]`, RapidOCR v3.9.2's actual shipped default for this exact vendored `.onnx` file, and are pinned in §4.11. PaddleOCR's own `PP-OCRv5_mobile_det.yml` trains and evaluates the model with ImageNet's triple instead, but RapidOCR is the pipeline this release replicates. Getting the channel order or the mean and std wrong produces boxes that are subtly wrong rather than absent, which is the hardest class of bug to notice, so §13.2 pins the first sixteen tensor values for a fixed 4 by 4 fixture.

**MUST-4.9** The det session's single output is a probability map of shape `[1, 1, resizeH, resizeW]` with values in 0 to 1. The code reads the shape from the returned tensor rather than assuming it, and throws if the spatial dimensions do not match the input.

### 4.4 Stage 3: DBNet post-processing

All of this lives in `contours.ts` and is pure, operating on a `Float32Array` and two integers.

**MUST-4.10** Binarize: `bitmap[i] = probMap[i] > DET_BINARY_THRESH`.

**MUST-4.11** Dilate the bitmap once with a `DET_DILATION_KERNEL` by `DET_DILATION_KERNEL` square of ones when `DET_USE_DILATION` is true. RapidOCR uses a 2 by 2 kernel and enables it by default; it closes the one-pixel gaps that split a single word into two components on faint thermal print.

**MUST-4.12** Label 8-connected components with a two-pass union-find. Process components in label order and stop after `DET_MAX_CANDIDATES` of them.

**MUST-4.13** For each component, compute the convex hull of its boundary pixels (monotone chain), then the minimum-area enclosing rectangle by rotating calipers over that hull. The result is a centre, a width, a height and an angle.

**MUST-4.14** Discard the rectangle when `min(width, height) < DET_MIN_BOX_SIDE_PX`.

**MUST-4.15 (score).** With `DET_SCORE_MODE = 'fast'`, the score is the arithmetic mean of `probMap` over the axis-aligned bounding box of the rectangle's four corners, clipped to the map bounds. Discard the rectangle when the score is below `DET_BOX_THRESH`.

**MUST-4.16 (unclip, and the simplification is stated rather than hidden).** DBNet shrinks its training targets, so every surviving rectangle must be grown back. The reference implementations run a Vatti polygon offset through pyclipper. This implementation does **not** take a polygon-clipping dependency. Instead, for the rectangle with area `A` and perimeter `P`:

```
distance = A * DET_UNCLIP_RATIO / P
```

and the rectangle is expanded about its own centre, along its own two axes, so that width becomes `width + 2 * distance` and height becomes `height + 2 * distance`.

For a rectangle this is **exactly** what a Vatti offset by `distance` produces except at the four corners, where Vatti with `JT_ROUND` rounds and this squares them off. Since every candidate here is already a minimum-area rectangle rather than a free-form polygon, the corner treatment is the only difference, and a squared corner on a text box is strictly more generous than a rounded one. The simplification is recorded here, in a comment at the function, and in §15 so that a future reader who diffs against RapidOCR's Python finds the answer rather than a discrepancy.

**MUST-4.17** Scale the expanded rectangle's four corners back to preprocessed-image coordinates with `scaleX` and `scaleY` from MUST-4.7, clamp each corner into the image bounds, and emit the box.

**MUST-4.18** Cap the emitted boxes at `DET_MAX_BOXES`, keeping the highest-scoring ones. A receipt is 30 to 80 lines. A cap of 200 leaves ample headroom and bounds the worst case where a noisy photo of a patterned countertop produces a thousand tiny components, each of which would otherwise cost a recognition pass and a chunk of main-thread time.

### 4.5 Stage 4: crop and rotate

**MUST-4.19** For each box, `crop.ts` produces an upright RGB crop:

1. Take the box's angle, normalised into the range -45 to +45 degrees by swapping width and height when the rectangle is taller than it is wide (a text line is wider than it is tall; a min-area rectangle can report the same shape either way).
2. `sharp(preprocessedBuffer, { raw: {...} }).rotate(-angleDeg, { background: '#ffffff' })` then `.extract()` the axis-aligned region the box occupies after that rotation.
3. Emit raw RGB plus its width and height.

**MUST-4.20** When `|angleDeg| < CROP_MIN_ROTATE_DEG` the rotation is skipped entirely and the crop is a plain `.extract()`. Most receipt boxes after §4.2's deskew are within a fraction of a degree of level, and skipping a no-op resample on 60 crops is the single cheapest performance decision in the pipeline.

**MUST-4.21** A crop whose width or height comes out as zero after clamping is dropped, not passed on. A zero-width tensor is an ORT crash, not an exception.

### 4.6 Stage 5: the orientation classifier

**MUST-4.22** The classifier input shape is read from the ONNX model's own declared input dimensions at session creation. When a spatial dimension is static, that value is used. When it is dynamic (symbolic), the pinned fallback `CLS_INPUT_HEIGHT` by `CLS_INPUT_WIDTH` is used. The research doc did not capture this model's input geometry, and PP-OCRv5's textline-orientation model does not share the legacy classifier's 48 by 192 shape, so reading it from the graph is the only way to be right without a second research pass. §17 flags this.

**MUST-4.23** Each crop is resized to that shape with aspect preserved and right-padded with `CLS_PAD_VALUE`, then normalised as `value = (pixel / 255 - CLS_MEAN) / CLS_STD`, RGB, NCHW. Crops are batched `CLS_BATCH_SIZE` at a time.

**MUST-4.24** The output must have exactly 2 classes; anything else throws at session creation, on the same reasoning as MUST-3.16. Class index 1 means 180 degrees. A crop is rotated 180 degrees when its class-1 probability is at or above `CLS_THRESH`, and left alone otherwise.

**MUST-4.25** The classifier is not optional and is not deferred. The research doc's recommendation to skip it assumed the browser scanner would normalise orientation; the scanner finds the paper's outline, which does not tell it which end is the top. A receipt photographed upside down is a real household case and costs 0.5 MB to handle.

### 4.7 Stage 6: the recognition tensor

**MUST-4.26** Crops are sorted by aspect ratio (`width / height`) ascending, then batched `REC_BATCH_SIZE` at a time. Sorting first means each batch's crops need similar padding, which is where the batching win comes from. The original index of each crop is carried alongside so results can be put back in detection order.

**MUST-4.27** For a batch, `maxRatio = max(REC_BASE_WIDTH / REC_INPUT_HEIGHT, max aspect ratio in the batch)` and the batch's tensor width is `min(ceil(REC_INPUT_HEIGHT * maxRatio), REC_MAX_WIDTH)`, rounded up to a multiple of 8.

**MUST-4.28** Each crop is resized to height `REC_INPUT_HEIGHT` with its aspect preserved, giving width `min(ceil(REC_INPUT_HEIGHT * ratio), batchWidth)`, and then right-padded to `batchWidth` with `REC_PAD_VALUE` **applied in normalised space, not pixel space**. `REC_PAD_VALUE = 0` after a normalisation of `(pixel / 255 - 0.5) / 0.5` corresponds to mid-grey, which is what PaddleOCR pads with. Padding with normalised -1 (black) puts a black bar after every short line and the CTC head reads characters into it.

**MUST-4.29** The tensor is `float32`, NCHW, shape `[batchSize, 3, REC_INPUT_HEIGHT, batchWidth]`, RGB, `value = (pixel / 255 - REC_MEAN) / REC_STD` with both equal to 0.5.

### 4.8 Stage 7: CTC greedy decode

**MUST-4.30** The recognition output is `[batchSize, T, C]` where `C` equals the dictionary length from MUST-3.15. PP-OCR recognition heads emit post-softmax probabilities, so no softmax is applied here. The code reads `C` from the tensor and throws if it disagrees with the dictionary (MUST-3.16 again, at run time this time).

**MUST-4.31** Per row, greedy decode is exactly:

1. For each timestep `t` in `0..T-1`, `k[t] = argmax_c out[t][c]` and `p[t] = out[t][k[t]]`.
2. Walk `t` ascending. Skip `t` when `k[t] === REC_BLANK_INDEX`. Skip `t` when `k[t] === k[t-1]` (collapse repeats; the blank between two genuine repeated characters is what separates them, which is why step 2 comes after step 1 and not before).
3. For each surviving `t`, append `dictionary[k[t]]` to the string and `p[t]` to the score list.
4. The line score is the arithmetic mean of the score list, or 0 when the list is empty.

**MUST-4.32** A line whose score is below `REC_DROP_SCORE`, or whose decoded string is empty after trimming, is dropped and never reaches §4.9. This is the guard that keeps the FTS5 index clean: the failure mode of the previous engine was not silence, it was confident nonsense, and a confidence floor is the only mechanical defence against it.

### 4.9 Stage 8: assembling the text, and why suggest.ts constrains it

**MUST-4.33** `assemble.ts` is pure and takes `Array<{ box: Quad; text: string; score: number }>`, returning one string.

1. Each box's vertical extent is `[minY, maxY]` and its height is `maxY - minY`.
2. Two boxes are on the same line when their vertical overlap is at least `LINE_OVERLAP_RATIO` of the **shorter** of the two heights. Grouping is transitive within a single pass over boxes sorted by `minY` ascending.
3. Within a line, boxes are ordered by `minX` ascending and their texts joined with `LINE_JOIN` (one space).
4. Lines are ordered by the mean `minY` of their boxes ascending and joined with `BLOCK_JOIN` (one `\n`).

**MUST-4.34 (this is a compatibility requirement, not a formatting preference).** The output must be newline-separated lines in top-to-bottom reading order, because `src/lib/warranty/suggest.ts` depends on exactly that and is not being modified:

- `suggestVendor` splits on `/\r?\n/`, takes the **first five non-empty lines**, and returns the first one with three or more letters that does not look like a phone number or a URL. If the assembler emits one long line, the vendor suggestion becomes the whole receipt truncated to 60 characters.
- `suggestPriceCents` splits on `/\r?\n/` and looks for a line matching `/\b(total|amount due|grand total|balance due)\b/i` that is not a subtotal, then takes the last currency number **on that line**. Without line structure, the total-line pass never fires and every receipt falls through to "the largest currency-formatted number anywhere", which on a receipt with a card number or a loyalty balance is wrong.
- `suggestPurchaseDate` uses the earliest **occurrence index** in the text, which is only meaningful if the text is in reading order.

§13.2 asserts this directly: a fixture box set that reproduces a receipt's geometry must assemble into a string from which `suggestFromOcrText` extracts the expected vendor, date and price.

**MUST-4.35** The assembled string passes through the existing `truncateOcrText` in the queue, unchanged. The engine itself applies no cap.

### 4.10 Sessions, threads, disposal, and the event loop

**MUST-4.36** `session.ts` holds at most three `InferenceSession` instances (det, cls, rec) in module scope, created lazily on first use and created together. Session options, pinned:

```ts
{
  executionProviders: ['cpu'],
  intraOpNumThreads: ORT_INTRA_OP_THREADS,
  interOpNumThreads: ORT_INTER_OP_THREADS,
  graphOptimizationLevel: ORT_GRAPH_OPT,
  logSeverityLevel: ORT_LOG_SEVERITY,
  enableCpuMemArena: ORT_CPU_MEM_ARENA,
}
```

`enableCpuMemArena` is **false** on purpose. The arena is a throughput optimisation that retains allocated blocks for reuse; with a household workload of a few receipts a day and an idle teardown 60 seconds later, retention is the opposite of what is wanted.

**MUST-4.37** `engine.ts` exports `releaseOcrEngine(): Promise<void>`, replacing the current `terminateOcrWorker()`. It clears the idle timer, then disposes whatever is live: the three ONNX sessions (`await session.release()` on each, each in its own try/catch) and the tesseract worker if one exists. `queue.ts`'s import and its one call site in `recognizeWithTimeout`'s `finally` are updated to the new name and nothing else in that file changes. The rename is deliberate: `terminateOcrWorker` describes a process that the ONNX path does not have, and an accurate name is cheaper than a comment explaining an inaccurate one.

**MUST-4.38** The idle-teardown timer keeps its exact current behaviour and its exact current value (`OCR_IDLE_TERMINATE_MS = 60_000`): disarmed synchronously at the top of `recognize()` before any `await`, re-armed in the `finally`, `unref`'d. The comment explaining why the disarm must precede the first `await` (job N's own call being terminated by job N-1's timer) stays, because the hazard is identical.

**MUST-4.39 (what replaces warranty MUST-7.2's out-of-process guarantee, honestly).** tesseract.js ran recognition in its own Node worker, so a multi-second recognise never blocked the event loop. The ONNX engine runs in-process. `session.run()` itself is fine: onnxruntime-node dispatches it to a libuv threadpool thread and returns a promise, so the model execution does not block. What **does** run on the main thread is this pipeline's own JavaScript: the connected-component labelling, the calipers, the per-crop tensor packing and the CTC decode. Three bounds keep that acceptable, and they are requirements rather than hopes:

1. `DET_MAX_BOXES = 200` bounds every per-box loop.
2. Recognition yields to the event loop between batches (`await new Promise((r) => setImmediate(r))`), so a 200-box receipt is 34 batches with 34 yield points rather than one uninterruptible stretch.
3. `contours.ts` operates on a bitmap whose long side is at most `PREPROCESS_MAX_LONG_SIDE_PX` (4000), the sharp stage cap from MUST-4.4 step 6 (Task 2 correction: `DET_LIMIT_TYPE = 'min'` only ever raises the *short* side to `DET_LIMIT_SIDE_LEN` and supplies no upper bound of its own, unlike the `'max'` type this bound originally assumed; see MUST-4.42). A 4000 by 4000 worst case is over sixteen times the bitmap area this bound originally assumed, which is part of what §14 acceptance step A9 now needs to confirm is still fast enough on real hardware.

The queue's concurrency of 1 means at most one such pipeline is ever in flight.

**MUST-4.40** `OCR_TIMEOUT_MS = 120_000` is unchanged and still applies via the queue's `Promise.race`. On timeout the queue calls `releaseOcrEngine()`, which now disposes the sessions, so the next job builds fresh ones. The reasoning in `queue.ts`'s existing comment (a race abandons the caller's await but does not cancel the call, so a wedged engine must be explicitly discarded or every future job queues behind it) transfers unchanged.

### 4.11 The pinned constant table

**MUST-4.41** Every number below lives in `src/lib/warranty/ocr/onnx/constants.ts` as an exported `const`, appears nowhere else as a literal, and carries a one-line comment naming its provenance. A grep test asserts that none of these numeric literals appears in any other file under `onnx/`.

**Preprocessing**

| Constant | Value | Provenance |
|---|---|---|
| `PREPROCESS_MAX_INPUT_PIXELS` | `50_000_000` | Ours. Bounds decode memory; a 50 MP photo is well past any phone |
| `PREPROCESS_MIN_LONG_SIDE_PX` | `1280` | Ours. Below this, receipt print is under the detector's resolution |
| `PREPROCESS_MAX_UPSCALE` | `3.0` | Ours. Beyond 3x there is no information left to recover |
| `PREPROCESS_MAX_LONG_SIDE_PX` | `4000` | Ours. Bounds the deskew rotate and the crop buffer |
| `NORMALISE_LOWER_PERCENTILE` | `1` | Ours (sharp `normalise` option) |
| `NORMALISE_UPPER_PERCENTILE` | `99` | Ours |
| `DESKEW_SEARCH_MAX_DEG` | `10` | Ours. A hand-held phone shot past 10 degrees is a scanner-crop case, not a deskew case |
| `DESKEW_SEARCH_STEP_DEG` | `0.5` | Ours. 41 candidates |
| `DESKEW_MIN_APPLY_DEG` | `0.3` | Ours. Below this, the resample costs more than it gains |
| `DESKEW_PROFILE_LONG_SIDE_PX` | `800` | Ours |
| `DESKEW_BACKGROUND` | `'#ffffff'` | Ours. White, because the image is already flattened onto white |

**Detection**

| Constant | Value | Provenance |
|---|---|---|
| `DET_LIMIT_SIDE_LEN` | `736` | RapidOCR v3.9.2's actual default (Task 2 correction, was `960`). See MUST-4.42 |
| `DET_LIMIT_TYPE` | `'min'` | RapidOCR v3.9.2's actual default (Task 2 correction, was `'max'`). See MUST-4.42 |
| `DET_SIZE_MULTIPLE` | `32` | DBNet's stride |
| `DET_MEAN` | `[0.5, 0.5, 0.5]` | RapidOCR v3.9.2's actual default (Task 2 correction, was PaddleOCR det `NormalizeImage`'s ImageNet triple). See MUST-4.42 |
| `DET_STD` | `[0.5, 0.5, 0.5]` | Same (Task 2 correction, was ImageNet's) |
| `DET_SCALE` | `1 / 255` | RapidOCR v3.9.2 and PaddleOCR, identical |
| `DET_BINARY_THRESH` | `0.3` | PaddleOCR `det_db_thresh` and RapidOCR `thresh`, identical |
| `DET_BOX_THRESH` | `0.5` | RapidOCR `box_thresh`. PaddleOCR uses 0.6; the more permissive value is chosen because thermal receipt print is faint and a missed line is worse here than a spurious one, which MUST-4.32 filters anyway |
| `DET_UNCLIP_RATIO` | `1.6` | RapidOCR `unclip_ratio`. PaddleOCR uses 1.5; the wider value keeps descenders and thin digits inside the crop |
| `DET_MAX_CANDIDATES` | `1000` | RapidOCR `max_candidates` |
| `DET_MIN_BOX_SIDE_PX` | `3` | PaddleOCR `min_size` |
| `DET_USE_DILATION` | `true` | RapidOCR default |
| `DET_DILATION_KERNEL` | `2` | RapidOCR's 2 by 2 kernel of ones |
| `DET_SCORE_MODE` | `'fast'` | RapidOCR `score_mode` |
| `DET_MAX_BOXES` | `200` | Ours (MUST-4.18) |
| `CROP_MIN_ROTATE_DEG` | `0.5` | Ours (MUST-4.20) |

**Orientation classifier**

| Constant | Value | Provenance |
|---|---|---|
| `CLS_INPUT_HEIGHT` | `80` | Fallback only; the graph wins (MUST-4.22). Flagged in §17 |
| `CLS_INPUT_WIDTH` | `160` | Same |
| `CLS_MEAN` | `0.5` | PaddleOCR cls preprocessing |
| `CLS_STD` | `0.5` | Same |
| `CLS_PAD_VALUE` | `0` | Normalised space, mid-grey |
| `CLS_THRESH` | `0.9` | PaddleOCR `cls_thresh` |
| `CLS_BATCH_SIZE` | `6` | PaddleOCR `cls_batch_num` |

**Recognition**

| Constant | Value | Provenance |
|---|---|---|
| `REC_INPUT_HEIGHT` | `48` | PaddleOCR `rec_image_shape` height for v4 and v5 mobile |
| `REC_BASE_WIDTH` | `320` | PaddleOCR `rec_image_shape` width |
| `REC_MAX_WIDTH` | `1200` | Ours. Bounds one absurdly wide crop's tensor at 25:1 |
| `REC_MEAN` | `0.5` | PaddleOCR rec preprocessing |
| `REC_STD` | `0.5` | Same |
| `REC_PAD_VALUE` | `0` | Normalised space (MUST-4.28) |
| `REC_BATCH_SIZE` | `6` | PaddleOCR `rec_batch_num` |
| `REC_BLANK_INDEX` | `0` | PaddleOCR `CTCLabelDecode.add_special_char` prepends `'blank'` |
| `REC_USE_SPACE_CHAR` | `true` | PaddleOCR `use_space_char` default for English |
| `REC_DROP_SCORE` | `0.5` | PaddleOCR `drop_score` default |

**Assembly and sessions**

| Constant | Value | Provenance |
|---|---|---|
| `LINE_OVERLAP_RATIO` | `0.5` | Ours (MUST-4.33) |
| `LINE_JOIN` | `' '` | Ours |
| `BLOCK_JOIN` | `'\n'` | Ours, and required by MUST-4.34 |
| `ORT_INTRA_OP_THREADS` | `2` | Ours. A budget NAS has 2 or 4 cores and the queue is concurrency 1 |
| `ORT_INTER_OP_THREADS` | `1` | Ours |
| `ORT_GRAPH_OPT` | `'all'` | ORT default for a static graph |
| `ORT_LOG_SEVERITY` | `3` | Errors only |
| `ORT_CPU_MEM_ARENA` | `false` | Ours (MUST-4.36) |

**MUST-4.42 (Task 2 correction).** `DET_LIMIT_SIDE_LEN` and `DET_LIMIT_TYPE` were originally pinned to PaddleOCR's inference CLI defaults, `960` and `'max'`, which cap the detector input's longest side. Task 2's one file review (§17.1) checked them against RapidOCR v3.9.2's actual shipped config instead and found `736` and `'min'`: the `DetResizeForTest` operator's own fallback, used by the model's published Eval config, not the convenience default of a command line tool. `'min'` raises the shortest side to a floor and otherwise leaves the image alone, which inverts the original worry. Previously the risk was a tall receipt's long side being crushed down to 960, discarding small print. Now the risk is compute cost: a large preprocessed photo, up to `PREPROCESS_MAX_LONG_SIDE_PX` (4000) on its long side, reaches the detector undownsampled instead of being capped in either dimension. §14 acceptance step A9 is still where this is decided on real data. If the acceptance run finds the detection stage too slow on real hardware, the fix is to reintroduce an upper bound, either by adding an explicit downscale ahead of MUST-4.7 or by returning to `'max'` with a larger limit such as `1536`, rather than reverting to values that no longer match the reference implementation.

---

## 5. The ARM compatibility probe

### 5.1 Why this cannot be a try/catch

**MUST-5.1** ONNX Runtime's ARM64 kernels (MLAS) have historically assumed ARMv8.2 features (FP16, dot product, i8mm) that plain ARMv8.0-A cores do not have. The research doc records a confirmed, unresolved case of the official ORT wheel dying with "Illegal instruction" on a stock Raspberry Pi 4 (Cortex-A72, ARMv8.0) on Debian Bookworm 64-bit, produced by the same release pipeline that builds `onnxruntime-node`'s native binary. It also records that Synology's arm64 line spans Cortex-A53 (older than the A72, definitely no FP16) through Cortex-A55 (ARMv8.2, has FP16), so the risk is real and hardware-dependent across the fleet rather than uniform.

An illegal-instruction fault raises SIGILL. SIGILL terminates the process. It is not a JavaScript exception: `try`/`catch` does not see it, `process.on('uncaughtException')` does not see it, a promise rejection handler does not see it. **There is no in-process way to survive it.** Any design that says "we will catch the failure and fall back" is wrong on this specific failure, and this section exists because that is the trap.

**MUST-5.2** Therefore the first attempt to use the ONNX engine on a given image version happens in a **spawned child process** whose death is observable to the parent. The parent survives regardless of what the child does, and the answer is cached.

### 5.2 `scripts/ocr-probe.mjs`

**MUST-5.3** The probe script is a standalone ESM script, resolvable at `path.join(process.cwd(), 'scripts', 'ocr-probe.mjs')` in the runtime image (it gets a Dockerfile COPY line via the existing `scripts/` copy, and a `check-ocr-assets.mjs` entry). It does exactly this and nothing else:

1. `await import('onnxruntime-node')`. Loading the native binding is itself one of the two places SIGILL is expected.
2. Create all three `InferenceSession`s from the real vendored model files at the paths from §3.3, with the §4.36 session options. Loading the real graphs is where kernel selection happens.
3. Run **one** inference on each session against a synthetic zero-filled tensor of the minimum valid shape: det `[1, 3, 32, 32]`, cls `[1, 3, CLS_INPUT_HEIGHT, CLS_INPUT_WIDTH]`, rec `[1, 3, 48, 320]`. Executing a real kernel is the second place SIGILL is expected, and it is why the probe must not stop at session creation.
4. Release all three sessions.
5. `console.log(OCR_PROBE_OK_LINE)` where that string is `'ocr-probe-ok'`, then `process.exit(0)`.

**MUST-5.4** The probe touches **no database**, opens **no socket**, reads **no environment variable** other than the ones Node needs to start, and writes nothing to disk. It is a pure question about this CPU and these three files. A test asserts the script's source contains no `better-sqlite3`, no `@/db`, no `fetch(` and no `writeFile`.

**MUST-5.5** Any failure path exits nonzero after printing one line to stderr: a missing model file, a hash mismatch, a session-creation throw, an inference throw. The parent never has to distinguish these; it only distinguishes "clean zero exit with the ok line" from everything else.

### 5.3 The probe protocol, exactly

**MUST-5.6** `probe.ts` exports `resolveOcrEngineKind(): Promise<'onnx' | 'tesseract'>`, called from `engine.ts` as the first statement of the ONNX path, before any model is touched. Its logic, in order:

1. If a probe is already in flight in this process, await that same promise. A module-level in-flight promise, because the boot sweep can enqueue several jobs at once.
2. Read `ocr.engine` and `ocr.engine_probed_version` from `settings`. If `ocr.engine` is `'onnx'` or `'tesseract'` **and** `ocr.engine_probed_version` equals `APP_VERSION`, return the cached value without spawning anything.
3. Otherwise spawn the probe.

**MUST-5.7** The spawn is asynchronous, never `spawnSync`, because a synchronous 60-second worst case would freeze the HTTP server:

```ts
spawn(process.execPath, [probeScriptPath], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
```

with a `setTimeout` of `OCR_PROBE_TIMEOUT_MS = 60_000` that sends `SIGKILL` and resolves the outcome as a failure.

**MUST-5.8 (the verdict table, and it is exhaustive).**

| Child outcome | Verdict | `ocr.engine_probe_detail` |
|---|---|---|
| exit code 0 **and** stdout's last non-empty line is exactly `ocr-probe-ok` | `'onnx'` | deleted |
| exit code 0 but the ok line is absent | `'tesseract'` | `probe exited cleanly without confirming` |
| terminated by a signal (`SIGILL`, `SIGSEGV`, `SIGABRT`, `SIGBUS`, anything) | `'tesseract'` | `probe process was killed by <signal>` |
| nonzero exit code | `'tesseract'` | first 200 characters of stderr, newlines collapsed to spaces |
| spawn error (`ENOENT`, `EACCES`) | `'tesseract'` | `probe could not start: <code>` |
| timeout at 60 s | `'tesseract'` | `probe timed out after 60 seconds` |

The signal row is the whole reason this section exists. It is written as its own row rather than folded into "nonzero exit" because `child.on('exit', (code, signal))` reports `code === null` when a signal killed the process, and code that only checks `code !== 0` mishandles exactly the case it was built for.

**MUST-5.9** The verdict is written to `settings` **before** `resolveOcrEngineKind()` returns, as three keys in one pass: `ocr.engine`, `ocr.engine_probed_version` (set to `APP_VERSION`), `ocr.engine_probe_at` (ISO datetime). `ocr.engine_probe_detail` is written on failure and deleted on success. A crash between the probe and the first receipt therefore does not re-probe.

**MUST-5.10** The probe runs at most once per image version, ever. It is keyed on `APP_VERSION`, which comes from the build-time `package.json` import that update §4.1 already established, so upgrading the container re-probes exactly once and downgrading re-probes exactly once. There is no scheduled re-probe, no manual re-probe button and no environment override. The hardware does not change under a running container, and a setting a household can toggle to "the engine that crashes" is a support burden with no upside.

**MUST-5.11** The probe never runs at boot, never runs on a page render, and never runs from a server action. It runs inside a queue job, which is already off the request path and already bounded by `OCR_TIMEOUT_MS`. A first receipt upload on new hardware therefore takes up to 60 seconds longer than usual, once, and the uploader's existing "Reading receipt" state covers it with no new copy.

### 5.4 The engine selector

**MUST-5.12** `src/lib/warranty/ocr/engine.ts` keeps `OcrEngine`, `getOcrEngine()`, `setOcrEngineForTests()`, `MAX_OCR_TEXT_CHARS`, `OCR_TIMEOUT_MS`, `OCR_IDLE_TERMINATE_MS`, `OcrUnavailableError`, `truncateOcrText` and all four message constants exactly as they are. The default engine's `recognize()` becomes:

1. PDF mime goes to `extractPdfText`, before anything else. No probe, no session, no engine question. This preserves the current behaviour that a PDF never touches an OCR engine.
2. `const kind = await resolveOcrEngineKind()`.
3. `'onnx'` runs §4's pipeline. `'tesseract'` runs today's tesseract worker code, moved verbatim into `src/lib/warranty/ocr/tesseract.ts` with no logic change, so the fallback is the exact code that shipped in v1.4.0 rather than a re-derivation of it.
4. A **run-time** ONNX failure that is a normal JavaScript throw (a corrupt model caught by MUST-3.13, a dictionary mismatch, an unexpected tensor shape) does **not** switch the cached engine and does **not** silently retry on tesseract. It fails the job with its message, exactly as any engine failure does today. Only the probe decides which engine an install uses. Two failure classes with two different meanings must not share one recovery path, or a transient bad receipt starts rewriting install-level configuration.

**MUST-5.13** `setOcrWorkerForTests` keeps its name and its contract for the tesseract path, and a parallel `setOnnxSessionsForTests` seam is added for the ONNX path, so §13's tests exercise the real selector without loading a 12.7 MB model.

**MUST-5.14** `tesseract.js`, `tesseract.js-core` and `vendor/tessdata/eng.traineddata.gz` remain in `package.json`, in the image, and in `check-ocr-assets.mjs`. Removing them is a later release's decision and only after the fleet has reported in. §18 records it.

### 5.5 The warning surface

**MUST-5.15** `probe.ts` exports `readOcrEngineState(): { engine: 'onnx' | 'tesseract' | null; probedVersion: string | null; probedAt: string | null; detail: string | null }`, a single reader over the four settings keys, so no caller assembles it from loose `getSetting` calls.

**MUST-5.16** Settings, About renders one `Notice` with tone `warning`, above the changelog and below the Updates card, **only** when `engine === 'tesseract'` **and** `detail` is non-null. The copy ships verbatim, as plain text nodes, with no link and no `dangerouslySetInnerHTML`:

> **This machine cannot run the new receipt reader.**
>
> Budget Tracker checked once, when version 1.5.0 first read a receipt here, and the check did not survive. It has gone back to the older reader that shipped before 1.5.0. Receipts still upload and are still read, just less accurately.
>
> There is nothing to fix. This is a limitation of the processor in this machine, not a setting, and the check will run again by itself the next time you update.
>
> Recorded reason: `<detail>`, checked on `<probedAt, rendered as iso.slice(0, 16) with T replaced by a space>`.

**MUST-5.17** The warning appears on Settings, About only. Not on the warranties list, not in the uploader, not on the dashboard. The reasoning: it is an install-level fact an admin can do nothing about, it is permanent for the life of the hardware, and a banner every household member sees on every receipt upload would be a permanent apology for something nobody can act on. The per-receipt OCR error and the existing "Could not read" tile are unchanged and still carry per-receipt failures.

**MUST-5.18** No copy anywhere says "PP-OCR", "ONNX", "tesseract", "model" or a version number of a library. "The new receipt reader" and "the older reader" are the vocabulary. A household does not have the context to act on a library name.

---

## 6. Queue integration

**MUST-6.1** `src/lib/warranty/ocr/queue.ts` changes by exactly two lines: the import of `terminateOcrWorker` becomes `releaseOcrEngine`, and the call in `recognizeWithTimeout`'s `finally` follows. Its FIFO ordering, its concurrency of 1, its `claimed` set, its `pump` single-flight invariant (and the long comment proving no job can be stranded), its `Promise.race` timeout, its `sweepPendingReceipts()` crash sweep, its `drainOcrQueue()` test seam and its `resetOcrQueueForTests()` all stay byte-identical.

**MUST-6.2** Both job kinds keep working unchanged. A staged job writes its sidecar with `status`, `text` and `suggestions` from `suggestFromOcrText`; a receipt job writes `ocr_status`, `ocr_text` and `ocr_error` on the row, and the existing `warranty_search_receipt_au` trigger reindexes. Application code still never writes `warranty_search` (base MUST-3.12).

**MUST-6.3** The scheduler's ten-minute sweep is unchanged. A crash mid-probe leaves rows in `'pending'` and the sweep re-enqueues them; the second attempt reads the cached probe result if MUST-5.9 got it written and re-probes if it did not. Both are correct and neither loops.

**MUST-6.4** No new concurrency. The queue does not gain a second lane for "cheap" jobs, does not batch across receipts, and does not run detection for receipt N+1 while recognising receipt N. Household scale is a burst of three receipts, as warranty MUST-7.10 says, and it is still true.

---

## 7. The PDF path

**MUST-7.1** `src/lib/warranty/ocr/pdf.ts` is **not modified**. PDFs continue to be read through pdfjs-dist's legacy Node build with `useWorkerFetch: false`, `isEvalSupported: false`, `disableFontFace: true`, `useSystemFonts: false` and `verbosity: 0`, taking text from the document's own text layer. A PDF whose non-whitespace text is under `MIN_PDF_TEXT_CHARS = 20` still raises `ScannedPdfError` with its existing message telling the owner to photograph the receipt instead.

**MUST-7.2** No PDF is rasterised in v1.5.0. **This differs from the ruling as written**, and the difference is stated here rather than papered over: the ruling says "PDFs keep the existing pdfjs render-to-image path, feeding the new engine", but there is no render-to-image path in the codebase to keep. `pdf.ts` extracts text and never rasterises; its own header comment says "PDFs are NOT rasterised and NOT run through Tesseract", and warranty MUST-7.14 pins that. Adding rasterisation would mean a canvas backend in Node (`@napi-rs/canvas` or `node-canvas`), which is a new native dependency with its own multi-arch prebuild question, evaluated nowhere in the research doc. It is listed in §17 as a decision for the controller and in §18 as deferred. The scanned-PDF case is served today by the existing message that tells the owner to photograph the receipt, which now goes through a materially better engine.

**MUST-7.3** `pdfjs-dist` stays in `serverExternalPackages`, stays in the Dockerfile's COPY lines and stays in `check-ocr-assets.mjs`.

---

## 8. Browser-side scanner capture

### 8.1 There is no viewfinder, and that is settled

**MUST-8.1** The app never calls `getUserMedia` and never touches `navigator.mediaDevices`. The research doc is unambiguous: `getUserMedia` is gated on a secure context, and on a page served over plain `http://<lan-ip>:3000` `navigator.mediaDevices` is simply `undefined` in both Safari and Chrome. This install is LAN-only over plain HTTP by design. A live viewfinder would require the household to first stand up TLS with a cert their phones trust, which is a deployment project, not a feature.

**MUST-8.2** The capture control therefore stays exactly what it is today: one `<input type="file" accept="image/*,application/pdf" capture="environment" multiple>`. `capture="environment"` hands off to the phone's own camera app, needs no permission grant from the page, needs no secure context, and is ignored by desktop browsers, which get an ordinary file picker. Warranty MUST-6.1 is unchanged.

**MUST-8.3** `Permissions-Policy: camera=()` in `src/lib/auth/security-headers.ts` **stays**. It costs nothing (the file input's capture handoff is not governed by it) and it mechanically prevents a future contributor from adding a viewfinder without noticing this decision. A grep test asserts `getUserMedia` and `mediaDevices` appear nowhere under `src/`.

### 8.2 Vendoring OpenCV.js and jscanify

**MUST-8.4** `scripts/vendor-scanner-assets.mjs` copies from `node_modules` into `public/scanner/` and is run by `npm run vendor-scanner-assets`, by the Dockerfile's builder stage before `npm run build`, and by the release workflow's guard job. It performs **no network access**; it only copies files npm already installed.

**MUST-8.5** It copies:

| Source | Destination |
|---|---|
| `node_modules/@techstark/opencv-js/dist/opencv.js` | `public/scanner/opencv.js` |
| the sibling `.wasm` file in that same `dist/` directory | `public/scanner/` under its original filename |
| `node_modules/jscanify/dist/jscanify.min.js` | `public/scanner/jscanify.min.js` |

**MUST-8.6 (the script fails loudly on a layout change).** The research doc did not enumerate `@techstark/opencv-js@4.7.0-release.1`'s exact `dist/` contents, and packages that ship WASM sometimes inline it as base64 into the glue instead of shipping a sibling `.wasm`. The script therefore: lists `dist/`, requires `opencv.js` to exist, and requires **either** exactly one `.wasm` file beside it **or**, if there is none, that `opencv.js` is at least 8,000,000 bytes (which is what a base64-inlined build looks like). Anything else is a nonzero exit that prints the full directory listing it found and the two shapes it accepts. This is a build-time failure with an actionable message, which is the right outcome for an assumption that could not be verified in research. §17 flags it.

**MUST-8.7** `public/scanner/` is generated, is listed in `.gitignore`, and is **not** committed. This differs deliberately from the models in §3, which are committed. The reason is that these files come from npm, which the build already depends on, whereas the models come from ModelScope, which it must not.

**MUST-8.8** `src/lib/scanner/load.ts` exports one function returning one module-level cached promise:

```ts
export function loadScanner(): Promise<{ cv: unknown; scanner: JscanifyLike }>;
```

It: sets `window.Module = { locateFile: (file: string) => '/scanner/' + file }` **before** injecting the script (the glue resolves its `.wasm` relative to that hook, and without it the fetch goes to the page's own path and 404s); injects `<script src="/scanner/opencv.js">`; awaits `cv.onRuntimeInitialized`; injects `<script src="/scanner/jscanify.min.js">`; constructs the jscanify instance. It rejects after `SCANNER_LOAD_TIMEOUT_MS = 15_000`. It is called **only** from the uploader's first image pick, never at module scope, never on page load, so a household member who never uploads a photo never downloads 9 MB.

**MUST-8.9 (CSP, and this is required, not optional).** `script-src` in `src/lib/auth/security-headers.ts` gains `'wasm-unsafe-eval'`. Chromium enforces CSP on WebAssembly compilation: without `'wasm-unsafe-eval'` or the far broader `'unsafe-eval'`, `WebAssembly.instantiate` throws and OpenCV.js never initialises. Android Chrome is the primary target device for this feature, so this is a blocker rather than a hardening nicety. `'wasm-unsafe-eval'` permits WebAssembly compilation and **nothing else**; it does not re-enable `eval` or `new Function`, which is why it exists as a separate token. The comment above `buildCsp` records that. Everything else in the policy is untouched: `default-src 'self'`, `connect-src 'self'` (the `.wasm` is same-origin), `object-src 'none'`, `frame-ancestors 'none'`.

**MUST-8.10** The two injected scripts are same-origin paths under `/scanner/`, which satisfies the existing `'self'` source expression. They carry no nonce and need none; the nonce governs inline scripts, and a same-origin `src` load is allowed by `'self'` independently.

### 8.3 The client flow, as a state machine

**MUST-8.11** Per selected file, the uploader moves through exactly these states, and the whole machine lives between the input's `onChange` and the existing `upload()` call. Nothing about staging, polling, suggestions or the Save button changes.

| State | Entered when | Shows | Leaves to |
|---|---|---|---|
| `picked` | `onChange` fires | nothing yet | `scanning` for an image; `uploading` for a PDF or a non-image |
| `scanning` | image picked | "Finding the receipt" and a spinner | `preview` on a valid quad; `uploading` on any failure (MUST-8.15) |
| `preview` | a valid quad was found | before and after side by side, the quad drawn on the before, a visible countdown, two buttons | `uploading` |
| `uploading` | the countdown expired, a button was pressed, or a fallback fired | the existing busy state | `staged` |
| `staged` | the stage POST returned | the existing tile and its OCR polling | terminal |

**MUST-8.12 (the scan itself, in `src/lib/scanner/scan.ts`).**

1. Decode the `File` into an `ImageBitmap`, then draw it to an `OffscreenCanvas` (falling back to a detached `<canvas>`) scaled so the long side is at most `SCANNER_WORK_MAX_PX = 1600`. Contour work on a 12 MP bitmap on a mid-range phone takes seconds; at 1600 it takes tens of milliseconds and the quad it finds is just as good, since it is scaled back up in step 4.
2. `jscanify.findPaperContour` then `getCornerPoints` on that working canvas.
3. Validate the quad per MUST-8.13. An invalid quad is a fallback, not an error.
4. Scale the four corners back to the **original** image resolution. Compute the output size as the mean of each pair of opposite side lengths, capped so the long side is at most `SCANNER_OUTPUT_MAX_PX = 2400`.
5. `jscanify.extractPaper` at that size, from a canvas holding the original-resolution image.
6. `canvas.toBlob('image/jpeg', SCANNER_JPEG_QUALITY = 0.92)`. Always JPEG, always named `<original stem>.jpg`. `image/jpeg` is already in `RECEIPT_MIMES`, so the server's existing `sniffReceiptType` accepts it with no change.
7. If the resulting blob is larger than `MAX_RECEIPT_BYTES` (10 MB, from `src/lib/warranty/receipts.ts`), fall back to the original file. A crop that fails the size limit is not a crop, it is a rejected upload.

**MUST-8.13 (quad validation).** A quad is used only when **all** hold: exactly 4 corners; the polygon is convex; its area is at least `SCANNER_MIN_QUAD_AREA_RATIO = 0.25` of the working canvas area; every side is at least `SCANNER_MIN_SIDE_RATIO = 0.05` of the working canvas's long side; and no corner is `NaN`. A quad hugging the full frame is what a detector returns when it found the photo's border rather than the paper, and cropping to it is a no-op that costs a JPEG re-encode; a sliver quad is a countertop edge. Neither is worth showing the owner.

**MUST-8.14 (the preview, and why it auto-accepts).** The preview pane shows the original with the detected quad stroked over it, and the corrected image beside it, each at most 160 pixels tall to match the existing tile size. Below them: a countdown reading "Using the straightened photo in N seconds", a primary **Use this** button that accepts immediately, and a secondary **Use the original** button that discards the crop and uploads the untouched file. After `SCANNER_AUTO_ACCEPT_MS = 4000` the corrected image is uploaded.

Auto-accept, rather than a confirm step, is the ruling and it is right: the correct answer is the crop in the overwhelming majority of cases, and a mandatory tap on every receipt is a tax on the common path. **Use the original** is framed as an undo of something already decided, not as a step in a manual pipeline. The countdown is visible for the whole four seconds so nothing happens without the owner having had the chance to see it.

**MUST-8.15 (fallbacks, and the rule above all of them).** **An upload is never blocked by the scanner.** Every one of these paths uploads the original file, unchanged, with no error shown and one `console.debug` line:

- `loadScanner()` rejects, or times out at 15 seconds.
- `WebAssembly` is undefined, or the CSP blocks it anyway on some browser.
- `findPaperContour` or `getCornerPoints` throws, or returns nothing.
- The quad fails MUST-8.13.
- `extractPaper` throws.
- `toBlob` returns null.
- The JPEG exceeds `MAX_RECEIPT_BYTES`.
- The file is a PDF, or any non-image mime.
- Anything else throws anywhere inside `scan.ts`. The whole call is wrapped in one try/catch whose catch returns the original file.

The failure of an assistive crop is not a failure the owner needs to hear about. Server-side sharp preprocessing (§4.2) then does what it can with the original, which is exactly what it would have done in a world without a scanner.

**MUST-8.16** Multi-file selection keeps working. Files are scanned **sequentially**, not in parallel: three simultaneous OpenCV warps on a phone is how a mid-range Android tab crashes. The preview shows one file at a time, in pick order.

**MUST-8.17** Every `ImageBitmap` is `close()`d and every object URL created for a preview is revoked, in a `finally` and again on unmount. The uploader's existing `filesRef` unmount-cleanup effect is extended to cover the preview URLs, for the same stale-closure reason its comment already gives.

---

## 9. Re-running OCR on an existing receipt

**MUST-9.1** No automatic mass re-OCR. Existing rows keep their stored `ocr_text`, their `ocr_status` and their FTS index entry. A background pass over the whole corpus on the first boot after an update is a self-inflicted load spike on a NAS, and the old text is not wrong enough to be worth deleting without being asked.

**MUST-9.2** The per-receipt re-run already exists and is **not modified**. `reRunOcrAction` in `src/app/(app)/warranties/actions.ts` checks same-origin, requires a user, validates the id, and calls `resetReceiptForReOcr(id)` in `src/lib/warranty/items.ts`, which sets `ocr_status = 'pending'`, nulls `ocr_text` and `ocr_error`, and calls `enqueueOcrJob({ kind: 'receipt', receiptId })`. Because §5.12 puts the engine choice inside `recognize()`, a re-queued job automatically runs on whichever engine this install resolved to. Warranty MUST-7.16's idempotence (a second click on a claimed row is a no-op inside `enqueueOcrJob`) is unchanged.

**MUST-9.3** The button's copy is unchanged. It says the same thing it said in v1.4.0 and the action still returns "Reading that receipt again, the status will update shortly." Nothing in the UI promises a better result, because on tesseract-fallback hardware there would not be one.

**MUST-9.4** The re-run replaces the text and, through the existing `warranty_search_receipt_au` trigger, replaces the index entry. There is no "keep the better of the two" comparison and no diff view. §18 records it as out of scope.

---

## 10. Docker, the build chain and image size

### 10.1 Dockerfile changes

**MUST-10.1 (the platform strip).** In the **deps** stage, immediately after `npm ci`:

```dockerfile
RUN npm ci \
    && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
              node_modules/onnxruntime-node/bin/napi-v6/win32
```

`onnxruntime-node` does not use per-platform optional dependencies the way `sharp` does; the single tarball carries native binaries for all five supported platforms, and `npm ci` unpacks all of them regardless of target. The research doc measured them: darwin/arm64 75 MB, win32/arm64 67 MB, win32/x64 62 MB, totalling **204 MB** of binaries this container can never execute. Stripping in the deps stage means the builder and the runner both inherit the pruned tree.

**MUST-10.2** The strip removes `darwin` and `win32` only. `linux/x64` (37 MB) and `linux/arm64` (20 MB) both stay in both architectures' images. Removing the non-target linux directory would save another 20 MB on amd64 and 37 MB on arm64 and would need `TARGETARCH` plumbing from buildx; it is deferred to §18 as a measured-benefit-versus-a-new-failure-mode trade that this release does not need to take.

**MUST-10.3** The **builder** stage runs `node scripts/vendor-scanner-assets.mjs` **before** `npm run build`, so `public/scanner/` exists when Next collects `public/`.

**MUST-10.4** The **runner** stage gains these COPY lines, in the OCR asset block, each with a comment on the same reasoning the block already carries (Next's output tracing cannot know that a `.node` binary, a `.wasm` blob or a file under `vendor/` is a runtime input):

```dockerfile
COPY --from=builder --chown=node:node /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=builder --chown=node:node /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=builder --chown=node:node /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder --chown=node:node /app/node_modules/@img ./node_modules/@img
```

`vendor/` is already copied wholesale, so `vendor/ocr-models/` arrives with no new line. `public/` is already copied, so `public/scanner/` does too. `scripts/` is already copied, so `scripts/ocr-probe.mjs` does too. Those three facts are asserted in §13.4 rather than assumed, because "it is already covered" is exactly the belief that produces a missing asset in production.

**MUST-10.5** `RUN node scripts/check-ocr-assets.mjs` stays where it is, after every COPY line it checks. The existing test asserting that ordering is extended to the new paths.

**MUST-10.6** No change to the base image, the stage count, `USER node`, `VOLUME ["/data"]`, the healthcheck, the read-only rootfs guidance, or the compiler toolchain's exclusion from the runner. The existing `tests/ops/docker.test.ts` assertions all still pass unmodified.

### 10.2 `scripts/check-ocr-assets.mjs`

**MUST-10.7** Its `REQUIRED` list keeps its four existing entries and gains six:

```
vendor/ocr-models/ch_PP-OCRv5_det_mobile.onnx
vendor/ocr-models/en_PP-OCRv5_rec_mobile.onnx
vendor/ocr-models/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx
vendor/ocr-models/en_dict.txt
node_modules/onnxruntime-node/bin/napi-v6
scripts/ocr-probe.mjs
```

**MUST-10.8** It gains a second phase: SHA256-verify the four `vendor/ocr-models/` files against hashes duplicated as literals in the script. The duplication from `models.ts` is deliberate and follows Ruling P10a's existing precedent for the tesseract paths: the script must stay self-contained with no `@/...` alias because it runs inside the runtime image, whose working directory holds Next's standalone output and not `src/`, and `tests/scripts/check-ocr-assets.test.ts` imports the real constants and pins the literals against them, so drift fails the test suite rather than only failing a docker build weeks later.

**MUST-10.9** It gains a third phase: assert that `node_modules/onnxruntime-node/bin/napi-v6/darwin` and `.../win32` do **not** exist. A silently un-stripped image is 204 MB heavier and nothing else tells anyone. The failure message names MUST-10.1.

**MUST-10.10** It gains a fourth phase: assert `public/scanner/opencv.js` and `public/scanner/jscanify.min.js` exist, and that the `.wasm`-or-inlined condition of MUST-8.6 holds. It prints one `ok` line per checked path, keeping the existing output shape.

**MUST-10.11** Every failure exits nonzero with a message naming the Dockerfile block to look at, exactly as today. The point is unchanged and worth restating: a tracing miss must break `docker build`, not production.

### 10.3 `next.config.ts`

**MUST-10.12** `serverExternalPackages` gains `'onnxruntime-node'` and `'sharp'`. Both load native `.node` binaries by path at run time; bundling either one breaks that resolution. The existing comment block is extended to name them and the reason.

**MUST-10.13** No webpack or turbopack configuration is added. `public/scanner/*` are static files served by Next's own public-directory handler and are never imported by the bundler, which is precisely why they are loaded by an injected script tag rather than an `import`.

### 10.4 `.github/workflows/release-image.yml`

**MUST-10.14** The guard job gains one step, `node scripts/vendor-scanner-assets.mjs`, between `npm ci` and the OCR asset check, so the check has something to check.

**MUST-10.15** The guard job's `Check OCR assets are present` step is unchanged in name and command; it now covers the ten paths and the three extra phases.

**MUST-10.16** The build job's comment claiming "the tesseract.js OCR WASM/language data copied into the runtime stage is architecture-neutral, no Dockerfile changes needed for arm64" is **corrected**. It is no longer true: `onnxruntime-node` ships an architecture-specific native binary and it is the reason §5 exists. The replacement comment states that both architectures now carry both linux ORT binaries, that the darwin and win32 payloads are stripped in the deps stage, and that arm64 hardware compatibility is decided at run time by the §5 probe and cannot be decided here.

**MUST-10.17** The platform list stays `linux/amd64,linux/arm64`. No new job, no QEMU-based smoke test of the models. A QEMU `cortex-a53` run is the right way to pre-empt §5's risk and it is listed in §18 as a follow-up, but a probe that already handles the failure gracefully is the shipping requirement and an emulated CPU test is not.

### 10.5 Image size accounting

**MUST-10.18** The release notes carry a measured before-and-after `docker image ls` figure for both architectures. The numbers below are the design's arithmetic and are what the measurement is checked against, not a substitute for it.

Added, per architecture:

| Item | Size | Source of the figure |
|---|---|---|
| `onnxruntime-node` after the strip | about 57 MB | 37 MB linux/x64 plus 20 MB linux/arm64, both retained; research doc §1 |
| The four vendored model assets | 12.7 MB | 4.60 plus 7.51 plus under 1, research doc §2 |
| `sharp` plus `@img/*` for one platform | about 12 MB, to be measured | Not in the research doc. Flagged in §17 |
| `public/scanner/` | about 9 MB | 8 MB `.wasm` plus about 1 MB glue plus under 50 KB jscanify; research doc §5 |
| `scripts/ocr-probe.mjs` | under 4 KB | |
| **Total added** | **about 91 MB** | |

Removed: **nothing**. The image carries both engines. Retained for the fallback: `node_modules/tesseract.js-core` at 30 MB on disk, `node_modules/tesseract.js` at 2 MB, `vendor/tessdata/eng.traineddata.gz` at 1,962,155 bytes, for about 34 MB of fallback that most installs will never execute.

**MUST-10.19** Without MUST-10.1's strip the added figure would be about 295 MB instead of about 91 MB. That single `rm -rf` is worth 204 MB, which is why MUST-10.9 asserts it happened rather than trusting that it did.

---

## 11. Egress: unchanged, and provably so

**MUST-11.1** This release adds **zero** runtime network destinations. Update §8.1's list of three (the household's own SimpleFIN bridge, `api.telegram.org` plus the admin's SMTP host, and `api.github.com`) is unchanged in content and in count.

**MUST-11.2** `scripts/fetch-ocr-models.mjs` is the only new file in the repository containing a `fetch(` call or a `://` literal pointing at ModelScope or GitHub raw content. It is a maintainer script, is never invoked by the app, by a test, by `docker build` or by any lifecycle hook (MUST-3.5), and lives under `scripts/`, which `tests/ops/install.test.ts`'s app-wide allowlist does not scan.

**MUST-11.3** `tests/ops/install.test.ts`'s "the app makes no network call unless SimpleFIN is configured" allowlist gains **no entries**. Nothing under `src/` gains a `fetch(` call. If an implementer finds themselves needing to add one, they have misread this spec.

**MUST-11.4** `tests/ops/notify-egress.test.ts`'s two-tree, table-driven invariant is unchanged and still passes with no amendment.

**MUST-11.5** The browser-side scanner makes **no** request off-origin. `opencv.js`, its `.wasm` and `jscanify.min.js` are served from this container under `/scanner/`. jscanify's own README example loads OpenCV.js from `docs.opencv.org` over a CDN; that example is not followed, and a test asserts that no file under `src/` or `public/scanner/` that we author contains `docs.opencv.org`, `cdn.jsdelivr.net` or `unpkg.com`. The vendored third-party bundles are exempt from that grep by path, because we do not author them; `connect-src 'self'` is the enforcement that actually binds them at run time.

**MUST-11.6** A new `tests/ops/ocr-egress.test.ts` asserts, over `src/lib/warranty/ocr/` and `src/lib/scanner/`: no `fetch(` call site at all; no `://` literal at all; no import of `axios`, `node-fetch`, `got` or `undici`; `onnxruntime-node` imported in exactly the two places MUST-2.3 names; and no reference to a model URL, a CDN host or `ModelScope`.

---

## 12. Settings state, and the no-migration claim

**MUST-12.1** This release adds **no table, no column and no migration**. The four keys below are rows in the existing `settings` key/value table, read and written through the existing `getSetting` / `setSetting` / `deleteSetting` helpers in `src/lib/settings.ts`. A test asserts that `drizzle/` gains no new file and that `drizzle/meta/_journal.json` is unchanged.

**MUST-12.2** `src/lib/warranty/ocr/onnx/probe.ts` owns every one of these strings and no other module writes a `settings` key beginning `ocr.`:

| Key | Values | Written by |
|---|---|---|
| `ocr.engine` | `'onnx'` or `'tesseract'`; **absent means not yet probed** | the probe |
| `ocr.engine_probed_version` | `APP_VERSION` at probe time, e.g. `1.5.0` | the probe |
| `ocr.engine_probe_at` | ISO datetime | the probe |
| `ocr.engine_probe_detail` | a scrubbed one-line reason; **deleted on success** | the probe |

**MUST-12.3** Absence is "not yet asked", not "off". There is no seeded row, no default and no migration that could pre-answer a hardware question on somebody's behalf. This is the same structural stance update MUST-3.1 takes, for the same reason.

**MUST-12.4** A restored backup carries whichever probe result the backup's install recorded. On restore to different hardware, the recorded `ocr.engine_probed_version` is compared against the running `APP_VERSION` as usual; when they match, the stale verdict is used. This is the one case where the cache can be wrong, and it is acceptable in both directions: a stale `'tesseract'` costs accuracy on hardware that could have done better, and a stale `'onnx'` fails the probe-equivalent on the first receipt by crashing the OCR queue's child-free path. To close the second, worse direction, **MUST-12.5**.

**MUST-12.5** `ocr.engine_probed_version` alone is not sufficient. The probe cache is also keyed on `process.arch`, stored as part of the probed-version value in the form `<APP_VERSION>/<process.arch>` (for example `1.5.0/arm64`). A backup restored from an amd64 machine onto an arm64 NAS therefore re-probes, because the key does not match. This costs one extra settings-value concatenation and closes the only way a cached "this CPU is fine" verdict can be carried onto a CPU that is not.

---

## 13. Testing

Vitest, colocated under `tests/` mirroring the source layout. Every requirement above is written to be testable; the list below is the minimum, not the ceiling.

**MUST-13.1 (the no-network rule).** No test performs real network I/O and no test downloads a model. Tests that need model bytes either use the committed `vendor/ocr-models/` files (they are in the repository, so CI has them) or a fake session.

### 13.1 Fixtures

**MUST-13.2** Three new fixture kinds, all tiny and all committed:

1. `tests/fixtures/ocr/tensor-4x4.png`, a 4 by 4 RGB PNG with known pixel values, used to pin the exact first sixteen floats of the det tensor and the rec tensor.
2. `tests/fixtures/ocr/skew-4deg.png`, a 600 by 400 white image with eight black horizontal bars rotated exactly 4.0 degrees, generated by `scripts/make-fixtures.mjs` (the existing generator) so it is reproducible rather than a mystery binary.
3. `tests/fixtures/ocr/receipt-boxes.json`, a hand-written array of about 40 boxes and strings reproducing a real receipt's geometry, with the vendor on the first line, a date line, several item lines and a `TOTAL 42.17` line.
4. `tests/fixtures/ocr/probmap-*.json`, three small probability maps (a clean two-box map, a map with a one-pixel gap that dilation must close, and a noise map with 1,200 components) as plain number arrays.

None of these needs a model file, which is what keeps §13.2 fast.

### 13.2 Unit, `tests/lib/warranty/ocr/onnx/`

- **`contours.test.ts`** (the largest suite, and the one that catches real bugs): binarize at 0.3 keeps and drops the right cells; dilation with the 2 by 2 kernel closes the one-pixel gap fixture into a single component and leaves the clean fixture at two; the union-find labels an 8-connected diagonal as one component and a 4-connected-only pattern as one too; the noise fixture stops at exactly `DET_MAX_CANDIDATES`; the min-area rectangle of a 45-degree-rotated square is the square, with an angle within 0.5 degrees; a component 2 pixels tall is dropped by `DET_MIN_BOX_SIDE_PX`; the fast score of a box over a known map equals the hand-computed mean; a box scoring 0.49 is dropped and 0.51 is kept; the unclip of a 100 by 20 rectangle expands it by exactly `2 * (2000 * 1.6 / 240)` in each dimension, checked against the arithmetic written out longhand in the test.
- **`assemble.test.ts`**: the `receipt-boxes.json` fixture assembles into a string whose first line is the vendor and whose `TOTAL` line is intact; **`suggestFromOcrText` over that string returns the expected vendor, date and price cents** (this is MUST-4.34's executable form and it is the single most important assertion in the suite); two boxes overlapping by 60 percent of the shorter height merge into one line and by 40 percent do not; boxes given in scrambled order come out in reading order; a single box yields a single line with no trailing newline.
- **`dict.test.ts`**: a dictionary whose last line is a space keeps that entry; a file with a trailing newline does not gain an empty entry; `REC_USE_SPACE_CHAR` appends exactly one space entry; index 0 is the blank; the real `vendor/ocr-models/en_dict.txt` produces a class count and the test asserts it against the real `en_PP-OCRv5_rec_mobile.onnx`'s declared output width, **loading only the model's metadata**, which is MUST-3.16 proved rather than asserted; a deliberately truncated dictionary throws with both numbers in the message.
- **`recognize.test.ts`** (CTC, against fake logit arrays, no session): `[blank, A, A, blank, A]` decodes to `AA` and not `A` and not `AAA`; an all-blank row decodes to the empty string and is dropped; the line score is the mean of the kept timesteps only; a row scoring 0.49 is dropped and 0.51 is kept; batching sorts by aspect ratio and restores the original order; a batch's padded width is a multiple of 8 and is capped at `REC_MAX_WIDTH`.
- **`preprocess.test.ts`**: the EXIF-orientation-6 fixture comes out upright (the highest-value single assertion in this file); a transparent PNG comes out on white, not black; a 400 pixel image is upscaled to 1280 and a 200 pixel one is capped at 3x rather than reaching 1280; a 6000 pixel image is capped at 4000; `skew-4deg.png` is measured within 0.5 degrees of 4.0; a level image measures under `DESKEW_MIN_APPLY_DEG` and is not rotated at all (asserted by buffer identity, so the no-op path is proved to be a no-op).
- **`detect.test.ts`**: the resize rule rounds to the nearest multiple of 32 and never up-scales under `limit_type: 'max'`; `scaleX` and `scaleY` round-trip a corner back to within 1 pixel; the first sixteen floats of the tensor for `tensor-4x4.png` match hand-computed values; a returned tensor with mismatched spatial dims throws.
- **`session.test.ts`**: the three sessions are created once and reused; `releaseOcrEngine()` releases all three and a subsequent job creates new ones; a release that throws on one session still releases the other two; the pinned session options are passed verbatim (asserted against a fake `InferenceSession.create`).
- **`models.test.ts`**: `resolveOnnxOcrAssets()` returns four absolute paths under `process.cwd()`; `assertOnnxOcrAssets()` is true in the repository; `verifyOnnxOcrAssets()` passes against the committed files and its four hashes equal the four constants; a temp directory with a one-byte-flipped model fails with that file named; verification is memoised (asserted with a hash-call counter).

### 13.3 The probe, `tests/lib/warranty/ocr/probe.test.ts`

- A cached `('onnx', '1.5.0/x64')` matching `APP_VERSION` and `process.arch` returns without spawning (asserted with a spawn counter at zero).
- A cached entry whose version differs re-probes. A cached entry whose arch differs re-probes (MUST-12.5).
- Each of MUST-5.8's six rows, driven by a **fake probe script** written to a temp directory: one that prints the ok line and exits 0; one that exits 0 silently; one that `process.kill(process.pid, 'SIGILL')`s itself; one that exits 3 with stderr; one at a nonexistent path; one that sleeps past the timeout.
- The signal row specifically asserts the verdict is `'tesseract'` and the detail names the signal, and that the code did not take the "exit code is 0" branch when `code === null`.
- Two concurrent `resolveOcrEngineKind()` calls spawn exactly one child.
- The settings keys are written before the promise resolves (asserted by reading them in the `then`).
- A failed probe deletes nothing else and writes `ocr.engine_probe_detail`; a passing probe deletes it.

**MUST-13.3** `tests/scripts/ocr-probe.test.ts` runs the **real** `scripts/ocr-probe.mjs` as a child process against the **real** committed models on the CI runner and asserts exit 0 with the ok line. On x64 GitHub runners this passes. It is the only test that loads a real model and runs a real inference, it takes a few seconds, and it is the only automated evidence that the pipeline's models and the ORT build actually work together.

### 13.4 Ops, `tests/ops/`

- **`ocr-egress.test.ts`** (new): MUST-11.6's five assertions.
- **`docker.test.ts`** (amended): the deps stage contains the `rm -rf` naming both `darwin` and `win32`; the runner stage contains the four new COPY lines; `RUN node scripts/check-ocr-assets.mjs` still comes after all of them; the tesseract COPY lines are **still present** (MUST-5.14); the builder stage runs `vendor-scanner-assets.mjs` before `npm run build`; every existing assertion in the file still passes unchanged.
- **`check-ocr-assets.test.ts`** (amended): the script's ten `REQUIRED` literals are pinned against the real constants from `models.ts` and `assets.ts`; its four duplicated SHA256 literals equal the four in `models.ts`; the darwin and win32 negative assertions are present.
- **`scanner-assets.test.ts`** (new): `vendor-scanner-assets.mjs` contains no `fetch(`; `public/scanner` is in `.gitignore`; the script's accepted-shape logic rejects a `dist/` with two `.wasm` files and a small `opencv.js`.
- **`release-image.test.ts`** (amended): the guard job runs `vendor-scanner-assets.mjs` before the asset check; the corrected architecture comment (MUST-10.16) is present and the old "architecture-neutral" sentence is gone.
- **`notice.test.ts`** (new): `vendor/ocr-models/NOTICE` exists, names all three model SHA256 values, names `v3.9.2`, contains the string `Apache License`, and names both RapidOCR and PaddleOCR.
- **`no-viewfinder.test.ts`** (new): `getUserMedia` and `mediaDevices` appear nowhere under `src/`; `Permissions-Policy` still contains `camera=()`; `capture="environment"` is still on the file input.
- **`csp.test.ts`** (new or amended): `script-src` contains `'wasm-unsafe-eval'`; it does **not** contain `'unsafe-eval'`; `connect-src` is still `'self'`; `object-src` is still `'none'`; the nonce branch still works.
- **`constants.test.ts`** (new): every numeric literal in §4.11's table appears in `constants.ts` and, apart from `0`, `1`, `2` and `3`, appears in no other file under `onnx/` (MUST-4.41).

### 13.5 Client, `tests/app/`

- **`receipt-scanner.test.tsx`** (new, jsdom, with `loadScanner` stubbed): a PDF pick skips the scanner entirely and calls `upload()` with the original; an image pick with a valid quad renders both panes and the countdown; the countdown reaching zero uploads the corrected blob; **Use the original** uploads the original `File` object by identity; **Use this** uploads immediately and cancels the timer; a `loadScanner` rejection uploads the original with **no error rendered** (asserted on the absence of any `role="alert"`); a quad failing each of MUST-8.13's five conditions falls back; a corrected blob over 10 MB falls back; three picked images are scanned one after another and never concurrently (asserted with a concurrency counter); unmounting mid-preview revokes every object URL and clears every timer.
- **`about-panel.test.tsx`** (amended): the warning renders when engine is `'tesseract'` **and** detail is set; it does **not** render when engine is `'tesseract'` and detail is null; it does not render for `'onnx'`; it does not render when the keys are absent; the copy contains none of `PP-OCR`, `ONNX`, `tesseract`, `model` (MUST-5.18); the detail is rendered as a text node and an injected `<b>x</b>` appears literally.

### 13.6 Integration, `tests/integration/ocr-engine.test.ts` (new)

**MUST-13.4** Against a temp SQLite file and a **fake** ONNX session set (via `setOnnxSessionsForTests`), so the whole engine path runs with no model load: create a warranty item with a receipt row in `'pending'` → the queue drains → the row reaches `'done'` with the assembled text → `warranty_search` contains a token from it → `reRunOcrAction` resets it to `'pending'` and re-queues → it reaches `'done'` again → a fake session that throws leaves the row `'failed'` with the message and leaves `warranty_search` consistent → a fake session that never settles leaves the row `'failed'` with `OCR_TIMEOUT_MESSAGE` after the raced timeout and `releaseOcrEngine` was called exactly once.

### 13.7 What cannot be tested here, stated plainly

**MUST-13.5** Four things have no automated coverage in this repository, and pretending otherwise would be worse than saying so:

1. **The ARM illegal-instruction path.** The failure needs an ARMv8.0 core without FP16. GitHub's arm64 runners and QEMU's default `-cpu max` both have FP16, so a CI run cannot reproduce it. §13.3 proves the probe succeeds on capable hardware and §13.3's fake-script tests prove every verdict branch is handled, but "does this specific NAS survive" is answered only by acceptance step A7.
2. **Recognition accuracy.** There is no accuracy test, no character error rate gate, no golden-text fixture from a real receipt. Building one would mean committing photographs of the owner's real receipts to a git repository, which is not happening. Accuracy is answered by acceptance step A9 and by nothing else.
3. **Real OpenCV.js behaviour in a browser.** jsdom has no WebAssembly, no canvas rasteriser and no `OffscreenCanvas`. Every client test stubs `loadScanner`, so the tests prove the state machine and every fallback path, and prove nothing about whether jscanify finds a receipt on a countertop. Acceptance step A8.
4. **Real end-to-end timing on NAS hardware.** Acceptance step A10.

Each of the four maps to a numbered acceptance step, which is the point of writing them down.

---

## 14. Acceptance criteria

### 14.1 Automated (must all pass before release)

- **AC1** `npm test` green, including every test in §13.
- **AC2** `npm run typecheck` clean under `strict`.
- **AC3** `tests/ops/ocr-egress.test.ts` passes: zero `fetch(` sites and zero `://` literals under `src/lib/warranty/ocr/` and `src/lib/scanner/`, and `onnxruntime-node` imported in exactly two places.
- **AC4** `tests/ops/install.test.ts` passes **with no amendment**. The allowlist is unchanged, which is the mechanical proof that MUST-11.1 holds.
- **AC5** `tests/ops/notify-egress.test.ts` passes with no amendment.
- **AC6** `node scripts/check-ocr-assets.mjs` passes in the repository and inside the built image, covering all ten paths, the four SHA256 values, the two absent platform directories and the scanner assets.
- **AC7** `docker build` succeeds for `linux/amd64` and `linux/arm64`, and `docker image ls` for each is within 10 MB of the §10.5 arithmetic. Both figures are recorded in the release notes.
- **AC8** `tests/scripts/ocr-probe.test.ts` passes on the CI runner: the real probe script loads the three real models and runs three real inferences, exiting 0.
- **AC9** `drizzle/` gained no file and `drizzle/meta/_journal.json` is byte-identical to v1.4.0's (MUST-12.1).
- **AC10** The dictionary class count equals the recognition model's declared output width (§13.2's `dict.test.ts`). If this fails, nothing else in the release matters.
- **AC11** `tests/ops/no-viewfinder.test.ts` and `tests/ops/csp.test.ts` pass: no `getUserMedia` anywhere, `camera=()` retained, `'wasm-unsafe-eval'` present, `'unsafe-eval'` absent.

### 14.2 Manual, run once per release on the owner's actual NAS

- **A1** Fresh install of the new image. Open the warranties page, upload one receipt photo from a desktop browser (no scanner path, no camera). It reads. Settings, About shows no warning.
- **A2** `docker logs` during A1 shows exactly one probe: one spawn, one verdict line, and no repeat on the second, third or tenth receipt.
- **A3** Restart the container and upload another receipt. **No second probe.** This is MUST-5.10 and a re-probe on every boot would be a 60-second stall on every restart.
- **A4** A network capture on the host during A1 through A3 shows **zero** packets to `modelscope.cn`, `github.com`, `docs.opencv.org`, `jsdelivr` or `unpkg`. Zero egress is the claim; a capture is the evidence.
- **A5** From an Android phone on the LAN over plain `http://<nas-ip>:3000`, open a warranty item, tap the receipt field, take a photo with the phone's camera. The scanner pane appears, shows the outline on the original and the straightened crop beside it, counts down and uploads on its own. Total time from shutter to "Reading receipt" is under 15 seconds on the first use (which includes the 9 MB download) and under 5 seconds on the second.
- **A6** Repeat A5 from an iPhone. Same behaviour. If OpenCV.js fails to initialise on iOS Safari, the original uploads with no error visible, which is MUST-8.15 working as designed and is an acceptable A6 outcome as long as the upload completes.
- **A7** **The probe under adverse hardware.** Either on a Cortex-A53-class Synology unit if the household has one, or under `docker run --platform linux/arm64` with QEMU pinned to `-cpu cortex-a53`: upload a receipt. Whatever happens to the child process, **the app stays up**, the receipt still gets text (from the fallback engine if the probe failed), and Settings, About shows the §5.5 warning with a reason naming the signal. A crashed container here is a release blocker.
- **A8** Deliberately break the scanner: rename `public/scanner/opencv.js` inside a running container and upload a photo from the phone. The upload completes with the original image, no error is shown to the user, and the receipt is still read.
- **A9** **The measurement that decides `DET_LIMIT_SIDE_LEN`.** Take five receipts of the kind that failed before, upload each twice (once with the scanner crop, once with **Use the original**), and compare the suggested vendor, date and price against the truth. If the small-print lines are systematically missing, rebuild with `DET_LIMIT_SIDE_LEN = 1536` per MUST-4.42 and repeat once. Record which value shipped.
- **A10** Time one receipt end to end on the NAS, from stage POST to `ocr_status = 'done'`. Record it. Anything over 30 seconds for a single receipt is a finding to raise before release, not after.
- **A11** Upload a text-layer PDF: it still reads from the text layer. Upload a scanned PDF: it still fails with the existing "photograph the receipt instead" message. Neither path spawned a probe or loaded a model.
- **A12** Press **Re-run OCR** on a receipt from before the upgrade. It re-reads with the new engine, the stored text is replaced, and a search for a word only in the new text finds the item.
- **A13** Restore a v1.4.0 backup onto the new image. The app boots, no migration runs, existing receipts keep their old text, and the first new receipt triggers exactly one probe.
- **A14** **The owner re-scans the receipts that failed under tesseract.** Every receipt that produced useless text before this release is photographed again through the scanner flow. The suggested vendor, date and price are checked against the paper. This is the acceptance criterion the release exists for, and if it does not pass, the release does not ship regardless of AC1 through AC11.

---

## 15. Decisions taken on the owner's behalf

Each is a single constant or a one-paragraph change if the owner wants it different.

1. **PP-OCRv5, not v6** (MUST-3.3). Maturity over benchmark, on a release fixing a reliability complaint.
2. **The English rec model, not Latin** (MUST-3.4). Same size, narrower charset, correct for the receipts in hand.
3. **The angle classifier ships** (MUST-4.25), against the research doc's suggestion to defer it. It costs under 1 MB and an upside-down receipt is a real household case that the paper-outline crop does not solve.
4. **Models are committed to the repository**, not downloaded during `docker build` (MUST-3.1). This is the tessdata pattern verbatim and it means a build on a firewalled NAS, and a build on a day ModelScope is down, both still work.
5. **The unclip is a rectangle expansion, not a Vatti offset** (MUST-4.16), which avoids a polygon-clipping dependency and is exact for rectangles except at the corners, where it is more generous.
6. **Deskew is a projection-profile search, not a Hough transform** (MUST-4.5). 41 candidate angles on an 800 pixel copy, self-contained and deterministic.
7. **`DET_BOX_THRESH` is RapidOCR's 0.5, not PaddleOCR's 0.6**, and `DET_UNCLIP_RATIO` is RapidOCR's 1.6, not PaddleOCR's 1.5. Faint thermal print and thin digits both argue for the more generous pair, and `REC_DROP_SCORE` filters what comes through.
8. **`REC_DROP_SCORE` stays at the reference default of 0.5.** Confident nonsense was the old engine's failure mode and a confidence floor is the only mechanical defence; it is a one-constant change if real receipts prove it too strict.
9. **`terminateOcrWorker` is renamed `releaseOcrEngine`** (MUST-4.37) rather than kept as an inaccurate name with a comment. Two lines in `queue.ts`.
10. **The tesseract path is moved verbatim, not rewritten** (MUST-5.12 step 3). The fallback should be the code that shipped, not a fresh derivation of it.
11. **A run-time ONNX error never rewrites the cached engine** (MUST-5.12 step 4). Only the probe decides. A bad receipt must not reconfigure the install.
12. **The probe is keyed on version and architecture** (MUST-12.5), so a backup restored across architectures re-probes.
13. **No manual re-probe control and no engine override** (MUST-5.10). A setting whose wrong value crashes the OCR queue is a support burden with no upside.
14. **The fallback warning lives on Settings, About only** (MUST-5.17). It is an install-level fact nobody can act on; a banner on every upload would be a permanent apology.
15. **No library names in user-facing copy** (MUST-5.18).
16. **Auto-accept after 4 seconds with a visible countdown** (MUST-8.14). The crop is right in the common case and a mandatory tap taxes it; **Use the original** is framed as an undo.
17. **The scanner works at 1600 pixels and outputs at up to 2400** (MUST-8.12). Contours do not need the full 12 MP; the recogniser does want more than 1600.
18. **Scanner output is always JPEG at quality 0.92**, because `image/jpeg` is already an accepted mime and adding one is a server change this release does not need.
19. **Scanner failures are silent to the user** (MUST-8.15). An assistive crop that did not happen is not news.
20. **Files are scanned sequentially** (MUST-8.16). Three concurrent WASM warps is how a mid-range phone tab dies.
21. **`'wasm-unsafe-eval'`, not `'unsafe-eval'`** (MUST-8.9). The narrow token exists for exactly this and does not re-enable `eval`.
22. **`camera=()` stays** (MUST-8.3) as a mechanical guard against a future viewfinder.
23. **Scanner assets are generated and gitignored; models are committed** (MUST-8.7). npm is already a build dependency; ModelScope must not be.
24. **Only `darwin` and `win32` are stripped** (MUST-10.2). The extra 20 to 37 MB from stripping the non-target linux directory needs `TARGETARCH` plumbing and is deferred.
25. **`check-ocr-assets.mjs` asserts the strip happened** (MUST-10.9). An un-stripped image is 204 MB heavier and otherwise silent.
26. **SHA256 verification runs at fetch time, at image-build time and once per process** (MUST-3.6, MUST-10.8, MUST-3.12). Three checkpoints, because a swapped model is undetectable from its output.
27. **`onnxruntime-node` is pinned exactly, not caret-ranged** (MUST-2.4). The ARM risk is a property of a build.
28. **`intraOpNumThreads = 2` and the CPU memory arena is off** (MUST-4.36), tuned for a 2-core or 4-core NAS running a concurrency-1 queue, not for throughput.
29. **No automatic mass re-OCR** (MUST-9.1). The existing per-receipt button already does the job on demand.
30. **No accuracy test in CI** (MUST-13.5 item 2). It would require committing photographs of the household's real receipts to git.
31. **PDFs are not rasterised in this release** (MUST-7.2), because the render-to-image path the ruling assumes does not exist and adding it means a new native canvas dependency. Flagged to the controller in §17.

---

## 16. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | onnxruntime-node dies with SIGILL on the owner's arm64 NAS and takes the whole app down | §5 in its entirety. The first use runs in a spawned child whose death is observable; the parent survives any signal; the verdict is cached per version and architecture; tesseract stays in the image as the fallback; A7 is the acceptance run on adverse hardware, and a crashed container there blocks the release |
| R2 | The dictionary does not match the recognition model, and every receipt decodes into confident nonsense that looks like the bug we set out to fix | MUST-3.16 compares the dictionary's class count against the model's declared output width at session creation and **refuses to run** on a mismatch. AC10 makes it a release gate. The research doc explicitly left the exact dictionary path to be confirmed at implementation, so this is the known-weak link and it is guarded at the only point where it is cheap to catch |
| R3 | The det or rec normalisation is subtly wrong (channel order, mean and std, pad value), producing boxes and text that are plausible but degraded, with nothing failing | §13.2 pins the first sixteen tensor floats for a fixed 4 by 4 fixture in both the det and rec paths, and §4.11 gives every constant a named provenance so a reviewer can diff them against PaddleOCR rather than guess. MUST-4.28's pad-value note exists because padding in pixel space instead of normalised space is the specific version of this bug that is hardest to see |
| R4 | The pipeline's own JavaScript blocks the event loop, and the app becomes unresponsive while a receipt is read; the tesseract worker process used to prevent this | MUST-4.39 states the change honestly and bounds it three ways: `DET_MAX_BOXES = 200`, a `setImmediate` yield between recognition batches, and a contour bitmap fixed at 960 by 960 regardless of input size. `session.run` itself is off-thread on libuv. A10 measures the real number on the real NAS |
| R5 | OpenCV.js fails on the owner's phone (CSP, iOS Safari, memory) and receipt capture regresses instead of improving | MUST-8.15's rule that the scanner never blocks an upload, applied to nine enumerated failure paths plus one catch-all try/catch. A failure uploads the original and the server-side pipeline handles it exactly as it would have without a scanner. A8 deliberately breaks it and checks that the upload still completes |
| R6 | The CSP silently blocks WebAssembly and nobody notices, because the fallback is silent by design | MUST-8.9 adds `'wasm-unsafe-eval'`, `tests/ops/csp.test.ts` asserts it is present and that `'unsafe-eval'` is not, and A5 is a real phone on a real LAN. The interaction between R5's deliberate silence and this risk is the reason the CSP gets its own test rather than being left to A5 |
| R7 | A model file is corrupted or swapped in transit, in the repository, or in the image | Three SHA256 checkpoints (MUST-3.6 at fetch, MUST-10.8 at image build, MUST-3.12 once per process), each naming the specific file. MUST-3.13 falls back rather than crashing and does **not** rewrite the hardware verdict, because a bad file is not a CPU fact |
| R8 | The image balloons because onnxruntime-node ships five platforms' binaries | MUST-10.1's strip removes 204 MB, MUST-10.9 asserts in the image build that it happened, and AC7 checks the measured size against §10.5's arithmetic within 10 MB. Without the assert this is a regression nobody would see for months |
| R9 | The new engine produces one long line and every suggestion silently gets worse, even though the raw text improved | MUST-4.34 makes line structure a requirement rather than a formatting habit, and `assemble.test.ts` asserts it by running the real `suggestFromOcrText` over the assembled fixture and checking vendor, date and price. This is the one place where "better OCR" could make the product worse |
| R10 | A cached probe verdict is carried onto different hardware by a backup restore | MUST-12.5 keys the cache on `process.arch` as well as `APP_VERSION`, so a cross-architecture restore re-probes. The same-architecture, different-CPU-generation case remains uncovered and is stated rather than engineered away: a Cortex-A55 backup restored onto a Cortex-A53 would carry an `'onnx'` verdict onto hardware that cannot honour it, and the symptom would be the OCR queue's process dying. This is a two-Synology household edge and the recovery is one settings-row delete, documented in INSTALL.md |
| R11 | `DET_LIMIT_SIDE_LEN = 960` throws away the small print on tall receipts, and the release under-delivers on its whole premise | MUST-4.42 names the constant, names `1536` as the tested alternative, states the roughly 2.5x cost, and A9 makes it a measurement on the owner's own five failing receipts rather than a guess in this document |
| R12 | jscanify or @techstark/opencv-js changes its `dist/` layout and the vendoring script silently copies nothing | MUST-8.6 makes the script fail the build with the directory listing it found and the two shapes it accepts; MUST-10.10 re-checks the result inside the image build. Both are exact pins, so this can only happen on a deliberate upgrade |
| R13 | Committing 12.7 MB of binaries to git is regretted later | It is the tessdata precedent (1,962,155 bytes already committed) at a larger size, it is a one-time repository growth, it is what makes an offline build possible, and no Git LFS is introduced, so a plain `git clone` still yields a buildable tree |
| R14 | A future contributor adds a live viewfinder and it silently does nothing on plain HTTP | MUST-8.3 keeps `camera=()` and `tests/ops/no-viewfinder.test.ts` fails on any `getUserMedia` or `mediaDevices` reference under `src/`. The reason is stated in §8.1 rather than left as folklore |

---

## 17. Where the research doc was insufficient, and what this spec assumed

Each item names the assumption, why it was safe to make, and how the design fails loudly rather than quietly if it is wrong.

**17.1 The PP-OCR tensor constants are not in the research doc.** The doc covers versions, URLs, hashes, sizes, licences and risks. It contains no normalisation means or standard deviations, no detection thresholds, no unclip ratio, no recognition input height, no batch sizes and no CTC conventions. Every value in §4.11 marked "PaddleOCR" or "RapidOCR" comes from those projects' published default inference configurations, not from the research doc. **The implementer must verify each one against RapidOCR at tag `v3.9.2` before writing it**, and §4.41 puts them all in one file so that verification is one file review rather than a hunt. The ones most worth double-checking: `DET_MEAN` and `DET_STD` (ImageNet triples), `REC_MEAN` and `REC_STD` (both 0.5), `REC_INPUT_HEIGHT` (48 for v4 and v5, 32 for v2), and `REC_BLANK_INDEX` (0, from `CTCLabelDecode` prepending the blank). **RESOLVED 2026-08-18 by Task 2's review.** `DET_MEAN` and `DET_STD` were indeed worth double-checking: they were not ImageNet triples in RapidOCR's actual shipped runtime, and neither was `DET_LIMIT_SIDE_LEN` / `DET_LIMIT_TYPE`. All four are corrected; see MUST-4.42 and the revision history's Task 2 entry. `REC_MEAN`, `REC_STD`, `REC_INPUT_HEIGHT` and `REC_BLANK_INDEX` were checked against the same source and confirmed as written.

**17.2 The exact dictionary file is unresolved. RESOLVED 2026-08-18 by measurement, and the resolution contradicted the research doc.** The research doc says the dictionary lives in the RapidOCR GitHub source tree rather than the ModelScope weights repo, names `ppocrv5_latin_dict.txt` as the community-cited filename, notes that PaddleOCR carries `ppocr/utils/en_dict.txt`, and states in as many words that the exact path must be confirmed at implementation because RapidOCR reorganised that directory in the v3.x restructure. **Measured:** the RapidOCR GitHub source tree carries no dictionary files at tag `v3.9.2` (`python/rapidocr/models/` holds only a `.gitkeep`); all four GitHub-raw candidates tried (the RapidOCR `models/` and `utils/dict/` paths, `ppocrv5_latin_dict.txt`, and PaddleOCR's own `ppocr/utils/en_dict.txt`) either 404 or, in the last case, download a 95-entry ASCII-only dictionary that does not match this model. The correct pairing is published by RapidOCR itself in `python/rapidocr/default_models.yaml`, which lists a `dict_url` next to every `model_dir`; the entry for `en_PP-OCRv5_rec_mobile` names `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt`, a 436-entry file. Loading the real `en_PP-OCRv5_rec_mobile.onnx` in `onnxruntime-node` gives an output last dimension of 438; `436 + 2` (the CTC blank plus one appended space, since this dictionary does not already contain a lone space entry) equals 438, so `REC_USE_SPACE_CHAR = true` is confirmed rather than merely assumed. **Guarded by:** MUST-3.16's class-count check, which refuses to decode on a mismatch, and AC10, which makes it a release gate.

**17.3 The angle classifier's input geometry and byte size are unknown.** The doc gives the SHA256 and says "small, sub-1 MB class, exact byte size not captured". It gives no input shape. The legacy v2.0 classifier uses 48 by 192; PP-OCRv5's `PP-LCNet_x0_25_textline_ori` is a different model family and is reported elsewhere at 80 by 160. **Assumed:** 80 by 160 as the fallback. **Guarded by:** MUST-4.22 reads the shape from the ONNX graph and only falls back when the dimension is symbolic, plus MUST-4.24's two-class assertion. The 12.7 MB total in §10.5 assumes the classifier is about 0.6 MB, matching the legacy model the doc did measure.

**17.4 "Fetched at build time by script" versus the tessdata pattern.** The ruling says the model vendoring must follow the same pattern as tesseract's, and describes that pattern as "fetched at build time by script, checked into image, never fetched at runtime". The actual tesseract pattern in this repository is different in one respect: `scripts/fetch-tessdata.mjs` is run by a maintainer and the result is **committed to git**; the Docker build only copies it, and its header says it is never invoked by a build. **Assumed:** the "same pattern as tesseract" clause is the binding one, so the models are committed (MUST-3.1) and `docker build` performs no download. **Compensated by:** SHA256 verification at image-build time as well as at fetch time (MUST-10.8), so the "verified by the build" property of the other reading is preserved. **If the controller intended a genuine build-time download**, this is a small change: move the fetch into the deps stage, add ModelScope to the build-time network requirements, and delete MUST-3.1's committed-blob rule. It would break offline builds and add a build-time dependency on ModelScope's uptime, which is why this reading was chosen.

**17.5 The PDF render-to-image path does not exist.** The ruling says "PDFs keep the existing pdfjs render-to-image path, feeding the new engine." There is no such path. `src/lib/warranty/ocr/pdf.ts` extracts the text layer and raises `ScannedPdfError` for scans; warranty MUST-7.14 pins that PDFs are not rasterised. **Assumed:** the ruling meant "the PDF path is unchanged", so §7 changes nothing. **The alternative, if the controller wants scanned-PDF OCR**, needs a Node canvas backend (`@napi-rs/canvas` or `node-canvas`), which is a new native multi-arch dependency evaluated nowhere in the research doc and would need its own arm64 prebuild check. It is a separate release.

**17.6 `sharp`'s installed size is not in the research doc.** The doc confirms per-platform optional dependencies, confirms linux/arm64 prebuilts, and gives no byte figures. **Assumed:** about 12 MB per platform for `sharp` plus `@img/sharp-linux-*` plus `@img/sharp-libvips-linux-*`. **Guarded by:** AC7 measures the real image and compares against §10.5's total within 10 MB, so a wrong assumption here surfaces as a failed acceptance criterion rather than a silent surprise. Also worth flagging: `sharp@0.34.5` is already present in `node_modules` as a transitive of Next, but it is **not** currently copied into the runner stage and `images: { unoptimized: true }` means Next never needs it at run time, so this is genuinely new weight in the image, not a free ride.

**17.7 `@techstark/opencv-js@4.7.0-release.1`'s `dist/` contents were not enumerated.** The doc gives the version, the licence, the 14.7 MB unpacked figure and the roughly 8 MB WASM figure, but not the filenames. **Assumed:** `dist/opencv.js` plus one sibling `.wasm`. **Guarded by:** MUST-8.6 makes the vendoring script fail the build with the actual directory listing and the two accepted shapes, so the assumption is checked mechanically on the first build rather than discovered at QA.

**17.8 jscanify's exact API surface was not captured.** The doc gives the version, the licence, the star count and the hard OpenCV.js dependency, but no method names. §8.12 names `findPaperContour`, `getCornerPoints` and `extractPaper`, which are jscanify's documented methods. **Assumed:** those three names and their signatures at 1.4.3. **Guarded by:** MUST-8.15's catch-all, which turns any wrong-name `TypeError` into an original-file upload rather than a broken uploader, and by A5 on a real phone.

**17.9 The `'wasm-unsafe-eval'` CSP requirement is not in the research doc at all.** It was found by reading `src/lib/auth/security-headers.ts` against the browser WASM story. Chromium enforces CSP on `WebAssembly.instantiate`; the current policy has neither `'wasm-unsafe-eval'` nor `'unsafe-eval'`, so OpenCV.js would fail to initialise on Android Chrome, the primary target. **Assumed:** current Chromium behaviour. **Guarded by:** MUST-8.9 adds the token, `tests/ops/csp.test.ts` pins it, and MUST-8.15 means that even if the assumption is wrong in either direction, the upload still works.

**17.10 The repository is at version 1.3.1, and this spec is written as 1.5.0.** That assumes a 1.4.0 ships between the two. If v1.5.0 is meant to follow 1.3.1 directly, every "1.5.0" and "before 1.5.0" in this document (including the §5.16 warning copy and §13.4's `_journal.json` comparison against "v1.4.0") needs the number changed, and nothing else does.

---

## 18. Out of scope (explicitly deferred)

**Rejected outright by the owner:** a paste-a-block-of-text input as an alternative to OCR. Recorded here so it is not re-proposed as an easy win.

**Recognition:** multi-language recognition of any kind; the `latin_PP-OCRv5_rec_mobile.onnx` model (a two-line swap if accented vendor names ever matter); PP-OCRv6, pending a follow-up evaluation against the owner's own receipts; table, layout or column analysis; line-item extraction; barcode and QR decoding; handwriting; per-word bounding boxes surfaced in the UI; a confidence score shown to the user; any accuracy metric collected or stored.

**Engine and infrastructure:** any execution provider other than CPU; `onnxruntime-web`'s WASM backend as a third tier below tesseract (the research doc suggests it, and two fallbacks for one problem is one too many until the fleet reports in); removing tesseract.js from the image, which is a later release's decision once the probe results are known; a sidecar container, which the research doc rules out on the grounds that the same CPU runs the same instructions either way; a manual engine override or a re-probe button; stripping the non-target linux platform directory via `TARGETARCH`; a QEMU `cortex-a53` smoke test in CI; model quantisation; warming the sessions at boot.

**PDFs:** rasterising a scanned PDF and running it through the new engine, which needs a Node canvas backend (see §17.5).

**Capture:** a live camera viewfinder of any kind; anything requiring a secure context; TLS termination or certificate provisioning for the LAN deployment; manual corner adjustment of the detected quad; multi-page or batch scanning into one receipt; automatic shutter; glare or shadow removal; colour-mode selection.

**Workflow:** automatic mass re-OCR of the existing corpus; comparing old and new OCR text and keeping the better one; a diff view; a bulk "re-run OCR on everything" admin action; storing the pre-crop original alongside the corrected image; a per-receipt record of which engine read it.

---

## Revision history

- **v1.0** (2026-08-18): initial approved design. Ships as **v1.5.0**. Replaces tesseract.js with a self-implemented PP-OCRv5 pipeline on `onnxruntime-node@1.27.0`: sharp preprocessing (EXIF orient, flatten, greyscale, percentile normalise, upscale, projection-profile deskew), DBNet detection with a rectangle-expansion unclip in place of a Vatti offset, an orientation classifier, and CTC greedy decoding against a class-count-verified dictionary, with every tensor constant pinned in one file. Models (12.7 MB, Apache-2.0, PP-OCRv5 mobile det plus English mobile rec plus textline orientation cls) are fetched from ModelScope at tag `v3.9.2` by a maintainer script that verifies three published SHA256 values, committed to `vendor/ocr-models/` following the tessdata precedent, and re-verified at image build and once per process. Hardware compatibility is decided by a one-time probe in a spawned child process, because an ARM illegal-instruction fault raises SIGILL and cannot be caught in-process; the verdict is cached in the `settings` table keyed on version and architecture, tesseract.js stays in the image as the fallback, and Settings, About carries the warning when it fires. Browser capture gains a jscanify 1.4.3 plus self-hosted `@techstark/opencv-js@4.7.0-release.1` scanner that finds, straightens and crops the paper after the phone's native camera hands back a still, auto-accepting after 4 seconds, never blocking an upload on failure, and never touching `getUserMedia`. `script-src` gains `'wasm-unsafe-eval'`, the only security-header change. The queue, the PDF path, `suggest.ts`, `search.ts`, the schema and the egress model are all unchanged; the image grows by about 91 MB after stripping 204 MB of unusable onnxruntime platform binaries.
- **Task 1 correction** (2026-08-18): measured against the real vendored files. MUST-3.7's dictionary shape guard is corrected from "fewer than 90 or more than 200 lines" to "fewer than 400 or more than 500 lines", and its download location from the RapidOCR GitHub source tree to the ModelScope `paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt` resource named by `dict_url` in RapidOCR's own `default_models.yaml`: the real English PP-OCRv5 dictionary has 436 entries (Latin-extended and punctuation, not plain ASCII), and no dictionary file exists in the GitHub source tree at this tag. §17.2 is updated with the same resolution. All three published `.onnx` SHA256 values, `CLS_INPUT_HEIGHT = 80` / `CLS_INPUT_WIDTH = 160` (§17.3), `REC_USE_SPACE_CHAR = true`, and the classifier's exact-2-class output (MUST-4.24) were all measured against the real model graphs and confirmed unchanged from this document's assumptions.
- **Task 2 correction** (2026-08-18): `constants.ts`'s one file review (§17.1) checked every PaddleOCR- or RapidOCR-attributed §4.11 value against RapidOCR v3.9.2's actual source (`python/rapidocr/config.yaml`, `ch_ppocr_det/utils.py`, `ch_ppocr_det/main.py`, `ch_ppocr_cls/main.py`, `ch_ppocr_rec/main.py`, `ch_ppocr_rec/utils.py`) and PaddleOCR's own published `PP-OCRv5_mobile_det.yml` and `ppocr/data/imaug/operators.py`. Four values disagreed and are corrected: `DET_LIMIT_SIDE_LEN` from `960` to `736`, `DET_LIMIT_TYPE` from `'max'` to `'min'`, `DET_MEAN` from ImageNet's `[0.485, 0.456, 0.406]` to `[0.5, 0.5, 0.5]`, and `DET_STD` from ImageNet's `[0.229, 0.224, 0.225]` to `[0.5, 0.5, 0.5]`. The `960`/`'max'` pair is a real PaddleOCR default, but it belongs to `tools/infer/utility.py`'s inference CLI argparse, not to the `DetResizeForTest` operator's own fallback (`736`/`'min'`), which is what the model's published Eval config and RapidOCR's runtime both use. The ImageNet triple is what PaddleOCR's training and evaluation config normalises with, but RapidOCR's shipped runtime for this exact vendored `.onnx` file normalises uniformly instead, and RapidOCR, not a from-source PaddleOCR reimplementation, is the pipeline this release replicates. MUST-4.7, MUST-4.8, MUST-4.39 and MUST-4.42 are updated to match; MUST-4.39's detection bitmap bound changes from a fixed 960 by 960 to `PREPROCESS_MAX_LONG_SIDE_PX` (4000) on the long side, since `'min'`-type resize supplies no upper bound of its own, which §14 acceptance step A9 now needs to confirm is still fast enough on real hardware. Every other PaddleOCR- or RapidOCR-attributed §4.11 value, including `DET_BINARY_THRESH`, `DET_BOX_THRESH`, `DET_UNCLIP_RATIO`, `DET_MAX_CANDIDATES`, `DET_MIN_BOX_SIDE_PX`, `DET_USE_DILATION`, `DET_DILATION_KERNEL`, `DET_SCORE_MODE`, `CLS_INPUT_HEIGHT` / `CLS_INPUT_WIDTH`, `CLS_MEAN`, `CLS_STD`, `CLS_THRESH`, `CLS_BATCH_SIZE`, `REC_INPUT_HEIGHT`, `REC_BASE_WIDTH`, `REC_MEAN`, `REC_STD`, `REC_BATCH_SIZE`, `REC_BLANK_INDEX`, `REC_USE_SPACE_CHAR` and `REC_DROP_SCORE`, was checked against the same sources and confirmed unchanged. `CLS_INPUT_HEIGHT` / `CLS_INPUT_WIDTH` = 80/160 turns out to be RapidOCR's own hardcoded `CLS_SHAPE_BY_OCR_VERSION['PP-OCRv5']`, not merely a fallback guess, which strengthens rather than changes §17.3's assumption.

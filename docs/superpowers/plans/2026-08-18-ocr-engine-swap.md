# Receipt OCR Engine Swap and Scanner Capture Implementation Plan (v1.5.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tesseract.js as the receipt OCR engine with a self-implemented PP-OCRv5 pipeline on `onnxruntime-node` (detection, orientation, CTC recognition, all constants pinned in one file), keep tesseract.js as the fallback behind a one-time out-of-process hardware probe, and add a browser-side scanner that finds, straightens and crops the paper after the phone's own camera hands back a still.

**Architecture:** Two independent halves. **Server:** a new `src/lib/warranty/ocr/onnx/` tree of small single-responsibility modules (`constants`, `models`, `dict`, `session`, `preprocess`, `contours`, `detect`, `crop`, `classify`, `recognize`, `assemble`, `engine`, `probe`). `onnxruntime-node` is imported in exactly two places and every other module takes an injected `TensorRun` function, which is what makes the whole pipeline unit-testable with no model load. `src/lib/warranty/ocr/engine.ts` becomes a selector over the ONNX implementation and today's tesseract code, moved verbatim into `src/lib/warranty/ocr/tesseract.ts`. **Client:** `src/lib/scanner/` lazily loads self-hosted OpenCV.js plus jscanify from `/scanner/`, and `ReceiptUploader.tsx` gains a state machine between the file pick and the existing `upload()`. **No migration, no new table, no new column, no new route, no new page.** The probe verdict rides the existing `settings` key/value table.

**Tech Stack:** Node 22, Next.js 15 (App Router), React 19, TypeScript strict, better-sqlite3 12, Drizzle ORM, Vitest 3: all unchanged. Four new runtime dependencies: `onnxruntime-node@1.27.0` (exact), `sharp@^0.35.3`, `jscanify@1.4.3` (exact), `@techstark/opencv-js@4.7.0-release.1` (exact). **Zero new outbound destinations at run time.**

**Spec:** `docs/superpowers/specs/2026-08-18-ocr-engine-swap-design.md` (1055 lines, 146 `MUST-n.m` requirements). Bare `§n` references below are that document's sections. Base specs: `docs/superpowers/specs/2026-08-15-budget-tracker-design.md` (master), `docs/superpowers/specs/2026-08-16-warranty-tracker-design.md` (*warranty §n*, which owns the current OCR design in its §7), `docs/superpowers/specs/2026-08-17-update-loans-design.md` (*update §n*). Research input: `.superpowers/research/2026-08-18-ocr-stack.md`.

## Global Constraints

These bind **every** task below. A task that violates one is wrong even if its own tests pass.

- **Version bump to 1.5.0 and the `CHANGELOG.md` entry happen in the final release task only.** **NOTE: v1.4.0 (a separate release) is being built in parallel on the same branch.** No task in this plan touches `package.json`'s `version` field or `CHANGELOG.md` until Task 13, and **Task 13 must rebase its expectations on whatever version is current at that moment** rather than assuming the repository still reads `1.3.1`. Task 1 does edit `package.json`, but only its `dependencies` and `scripts` blocks.
- **Per-task verification is TARGETED `vitest` plus `tsc --noEmit` only.** The full suite and `npm run build` run **only** in the final release task (Task 13). This is the owner's speed ruling.
- **A `'use server'` file may export ONLY async functions.** A `const` export from `src/app/(app)/warranties/actions.ts` breaks `next build`, and **neither `vitest` nor `tsc --noEmit` catches it**. This release does not modify that file (MUST-9.2), and no task may start.
- **Comment and doc style: no em dashes or en dashes anywhere, no AI-sounding phrasing, comments state constraints not narration.** A comment says why a rule exists or what breaks without it. It does not narrate what the next line does.
- **Zero egress at run time: no new fetch destinations.** `tests/ops/install.test.ts` and `tests/ops/notify-egress.test.ts` must stay green **with no amendment** (AC4, AC5). Model downloads happen only in the maintainer-run `scripts/fetch-ocr-models.mjs`, which the app, the tests, `docker build` and every npm lifecycle hook never invoke.
- **No schema migration.** `drizzle/` gains no file, `drizzle/meta/_journal.json` is untouched, `src/db/schema.ts` is untouched. The probe verdict rides the existing `settings` key/value table through `getSetting` / `setSetting` / `deleteSetting` in `src/lib/settings.ts`. **If any task seems to need a migration the plan is wrong; stop and fix the plan.**
- **Commit identity is already configured in the repo.** Do not pass `--author`. **Commit messages get NO attribution footers of any kind**: no `Co-Authored-By`, no `Generated with`, nothing. Never `--no-verify`.

Copied verbatim from the spec, the requirements every task inherits:

- **MUST-2.1.** "`constants.ts`, `contours.ts` and `assemble.ts` are **pure**: no `@/db` import, no `@/lib/env` import, no `node:` builtin, no `onnxruntime-node` import, no `sharp` import. They take arrays and numbers and return arrays and numbers."
- **MUST-2.2.** "Nothing under `src/lib/warranty/ocr/onnx/` is imported, directly or transitively, from any `'use client'` file, except `constants.ts` and then only via `import type` or a named numeric import."
- **MUST-2.3.** "`onnxruntime-node` is imported in exactly **two** places in the whole tree: `src/lib/warranty/ocr/onnx/session.ts` and `scripts/ocr-probe.mjs`. Both imports are dynamic (`await import(...)`), so a boot on hardware where the native binding cannot even load does not take the process down at module-evaluation time."
- **MUST-2.5.** "No package under an AGPL, GPL, LGPL, SSPL or source-available licence enters the tree."
- **MUST-3.5.** The fetch script "is run **by a maintainer with internet access**, never by `docker build`, never by a test, never by the app, and never by a `postinstall` hook."
- **MUST-4.41.** "Every number below lives in `src/lib/warranty/ocr/onnx/constants.ts` as an exported `const`, appears nowhere else as a literal, and carries a one-line comment naming its provenance."
- **MUST-5.18.** "No copy anywhere says 'PP-OCR', 'ONNX', 'tesseract', 'model' or a version number of a library. 'The new receipt reader' and 'the older reader' are the vocabulary."
- **MUST-6.1.** "`src/lib/warranty/ocr/queue.ts` changes by exactly two lines: the import of `terminateOcrWorker` becomes `releaseOcrEngine`, and the call in `recognizeWithTimeout`'s `finally` follows."
- **MUST-7.1.** "`src/lib/warranty/ocr/pdf.ts` is **not modified**." No PDF is rasterised in v1.5.0 (MUST-7.2).
- **MUST-8.1.** "The app never calls `getUserMedia` and never touches `navigator.mediaDevices`."
- **MUST-8.15.** "**An upload is never blocked by the scanner.**" Every failure path uploads the original file, unchanged, with no error shown and one `console.debug` line.
- **MUST-9.2.** "`reRunOcrAction` in `src/app/(app)/warranties/actions.ts` ... is **not modified**."
- **MUST-12.1.** "This release adds **no table, no column and no migration**."
- **MUST-13.1.** "No test performs real network I/O and no test downloads a model."
- **Zero egress (MUST-11.1).** "This release adds **zero** runtime network destinations."
- **TypeScript strict.** `npx tsc --noEmit` must stay clean. No `any`, no `@ts-expect-error` outside a test asserting a type error.

## Conventions every task must follow

- Project root for every absolute path: `c:\Users\m.grewal\OneDrive - CloverTool Mfg\Documents\Budget Tracker`. Every `npm` / `npx` / `git` / `node` command runs from there in PowerShell.
- Import alias `@/` maps to `src/`. Tests live under `tests/` and mirror `src/` (`src/lib/warranty/ocr/onnx/dict.ts` becomes `tests/lib/warranty/ocr/onnx/dict.test.ts`).
- Vitest runs with `globals: false` and `environment: 'node'`. Every test file opens with an explicit `import { describe, it, expect, ... } from 'vitest';`. A DOM test opens with the pragma line `// @vitest-environment jsdom` **above** the imports, then `import { render, cleanup, screen, fireEvent } from '@testing-library/react';` and an `afterEach(cleanup)`. This repo uses `fireEvent`, not `userEvent`.
- Existing OCR tests inject through **exported seams**, never `vi.mock`: `setOcrEngineForTests`, `setOcrWorkerForTests`, `resetOcrQueueForTests`. This release adds `setOnnxSessionsForTests`, `resetRecDictionaryForTests`, `resetOcrProbeForTests` and `setProbeScriptPathForTests` in the same style. Keep the style.
- Any test touching the database uses `createTestDb()` / `createSeededTestDb()` / `insertTestUser()` from `tests/helpers/db.ts` (imported by **relative** path, e.g. `'../../../helpers/db'`, which is what the existing OCR tests do).
- **Per-task verification is targeted.** Each task ends with `npx vitest run <the files this task touched>` plus `npx tsc --noEmit`. `npm test` and `npm run build` run in Task 13 only.
- **Commit at the end of each task.** No attribution trailer of any kind.
- The signal to act on at the end of a task is **green versus red on the files that task touched**, not an absolute test count.

## Where this plan resolves the spec rather than transcribing it

Ten real gaps or conflicts inside the spec, resolved here once so no task has to decide them twice.

1. **Task 1 is empirical and the spec's pinned dictionary values are provisional.** The research doc states outright that the exact dictionary path matching `en_PP-OCRv5_rec_mobile.onnx` "must be confirmed at implementation". §17.2 says the same. Task 1 therefore **downloads the real files, verifies the three published SHA256 values, reads the recognition model's real output class count and the classifier's real input shape, and corrects the spec's pinned values in place if they are wrong**. Nothing downstream starts until Task 1 lands, because every later constant depends on it.
2. **The client-boundary test goes in the new `tests/ops/ocr-egress.test.ts`, not into `tests/ops/notify-egress.test.ts`.** MUST-2.2 says to use "the existing banned-module regex used for `@/lib/update/*`", which lives in `notify-egress.test.ts`'s `describe('MUST-2.2: server-only modules never reach a client component')`. But MUST-11.4 and **AC5 require `notify-egress.test.ts` to pass with no amendment**. The plan copies the *pattern* into the new file and leaves `notify-egress.test.ts` byte-identical.
3. **The security-headers file is `src/lib/auth/security-headers.ts`.** §8.6's prose and §2.2's table both name it correctly; the shorter path `src/lib/security-headers.ts` does not exist.
4. **`onnxruntime-node` cannot be imported outside `session.ts`, so every stage takes an injected runner.** MUST-2.3 caps ORT at two import sites. `detect.ts`, `classify.ts` and `recognize.ts` therefore receive a `TensorRun` function rather than reaching for a session. This is not a testing convenience bolted on afterwards; it is the only shape MUST-2.3 permits, and it is what makes §13.6's fake-session integration walk possible.
5. **`session.ts` is built in Task 3, beside `preprocess.ts`, not last.** It owns the `TensorRun` type that Tasks 4 to 6 consume, and its own dependencies (`models.ts`, `constants.ts`, `dict.ts`) all land in Tasks 1 and 2. Grouping it with `preprocess.ts` also puts the release's two native-library seams (onnxruntime and sharp) behind one reviewer's gate.
6. **`PIXEL_SCALE` is added to `constants.ts` beyond §4.11's table.** MUST-4.41 bans the literal `255` everywhere under `onnx/` except `constants.ts`, and §4.11 only pins it as `DET_SCALE = 1 / 255`. MUST-4.23 and MUST-4.29 normalise the classifier and recogniser with the same `/ 255`. Reusing a constant named `DET_` in the cls and rec paths would be a lie, so `PIXEL_SCALE = 1 / 255` is added with a comment saying it is the same number as `DET_SCALE` under a stage-neutral name. Three further additions are made on the same reasoning and for the same test: `REC_WIDTH_MULTIPLE = 8` (MUST-4.27), `CLS_FLIP_DEGREES = 180` (MUST-4.24) and `CROP_ANGLE_LIMIT_DEG = 45` (MUST-4.19). §13.4's `constants.test.ts` pins **§4.11's table** and does not ban these four.
7. **The seven `SCANNER_*` constants live in `onnx/constants.ts`.** §2.2's file list adds no `src/lib/scanner/constants.ts`, and MUST-2.1 states that `constants.ts` is imported by the client scanner and that update MUST-2.1's client-bundle rule therefore applies to it. MUST-2.1 says "two shared limits"; the plan lands seven, all of them named numeric or string exports from that same client-safe file, which is what the rule actually governs.
8. **The probe's own constants live in `probe.ts`, not `constants.ts`.** `OCR_PROBE_OK_LINE` and `OCR_PROBE_TIMEOUT_MS` are §5 values, are not in §4.11's table, and `probe.ts` is the module MUST-12.2 makes the sole owner of the `ocr.` key strings.
9. **Fixtures are generated in test helpers, not committed as binaries, except `receipt-boxes.json`.** The prompt's fixture ruling permits either. `tests/fixtures/ocr/tensor-4x4.png` becomes an inline `Buffer` literal in `detect.test.ts` because `buildDetTensor` takes a `RawImage` and never a PNG; `skew-4deg.png` and the EXIF-orientation fixture are rendered with sharp at test time by `tests/helpers/ocr-images.ts`; the probability maps are built by `tests/helpers/ocr-probmaps.ts`. Only `tests/fixtures/ocr/receipt-boxes.json` is committed, because it is hand-written text a reviewer must be able to read. `tests/fixtures/` does not exist today (this repo's CSV fixtures live in the root `fixtures/`), so Task 6 creates it. `scripts/make-fixtures.mjs` is **not** extended; a generator that writes a binary nobody reviews is worse than a helper that renders it in the test.
10. **`next.config.ts`'s `serverExternalPackages` change lands in Task 1, not the Docker task.** It is a property of the dependency, not of the image: the moment `sharp` or `onnxruntime-node` is imported from server code, bundling breaks their native `.node` resolution. §10.3 files it under ops; the plan files it with the dependency that needs it.
11. **The selector reaches the ONNX tree through a dynamic import, and `engine.ts` re-exports nothing from it.** MUST-3.12 makes `models.ts` throw `OcrUnavailableError`, and MUST-5.12 keeps that class in `engine.ts`. A static `engine.ts -> onnx/engine.ts -> session.ts -> models.ts -> engine.ts` chain would be a module cycle, which is exactly the kind of thing that works until an unrelated refactor changes evaluation order. `engine.ts` therefore does `await import('@/lib/warranty/ocr/onnx/engine')` inside `recognize()`, which breaks the cycle, and additionally means a boot on hardware that cannot load the native binding never evaluates the ONNX tree at all. For the same reason `setOnnxSessionsForTests` is **not** re-exported from `engine.ts`; tests import it from `@/lib/warranty/ocr/onnx/session` directly. `setOcrWorkerForTests` **is** re-exported: `engine.ts` and `tesseract.ts` do form a two-module cycle through `OcrUnavailableError`, but that reference sits inside a function body and is evaluated long after both modules finish, and today's `engine.ts` already holds both halves in one file, so splitting them changes nothing about when the class is reached.

## Which tests need the real model files

Three suites load bytes from `vendor/ocr-models/`. Every other test in this release runs against a fake `TensorRun` or a hand-built array and needs no model at all.

| Test | What it loads | Why it must |
|---|---|---|
| `tests/lib/warranty/ocr/onnx/models.test.ts` | all four files, SHA256 only | MUST-3.11, MUST-3.12: proves the pins match the committed bytes |
| `tests/lib/warranty/ocr/onnx/dict.test.ts` | `en_dict.txt` plus one `[1,3,48,320]` zero inference on the rec model | AC10 and MUST-3.16: the class-count guard proved, not asserted. Keep it to one tiny inference |
| `tests/scripts/ocr-probe.test.ts` | all three `.onnx` files, three zero inferences | MUST-13.3: the only automated evidence the models and this ORT build work together |

`session.test.ts` reads `en_dict.txt` (a few KB of text, no model) so its class-count guard has a real number to compare against; `detect.test.ts`, `classify.test.ts`, `recognize.test.ts`, `engine.test.ts` and the integration walk use fakes throughout. All of them must stay under a second each.

## File structure

**New, `src/lib/warranty/ocr/onnx/` (§2.1):**

| File | Responsibility | Task |
|---|---|---|
| `models.ts` | the four vendored paths, the four SHA256 pins, existence and hash verification | 1 |
| `constants.ts` | every pinned number in §4.11 plus the client-safe scanner block. PURE, no imports | 2 |
| `dict.ts` | dictionary load, the CTC index table, the class-count guard | 2 |
| `session.ts` | the three `InferenceSession`s, the `TensorRun` seam, disposal. The **only** app-side `onnxruntime-node` import | 3 |
| `preprocess.ts` | sharp: orient, flatten, greyscale, normalise, resize, deskew | 3 |
| `contours.ts` | PURE: binarize, dilate, connected components, hull, min-area rect, score, unclip | 4 |
| `detect.ts` | the detection resize rule, the det tensor, boxes out | 4 |
| `crop.ts` | per-box crop and rotate via sharp | 5 |
| `classify.ts` | the orientation model, the 180 degree flip | 5 |
| `recognize.ts` | the rec tensor, batching, CTC greedy decode | 6 |
| `assemble.ts` | PURE: boxes plus strings to the final text | 6 |
| `engine.ts` | the `OcrEngine` implementation wiring the eight stages | 7 |
| `probe.ts` | the child-process compatibility probe, the verdict table, the settings cache | 8 |

**New, elsewhere:** `src/lib/warranty/ocr/tesseract.ts` (Task 8, today's code moved verbatim), `src/lib/scanner/load.ts` (10), `src/lib/scanner/scan.ts` (11), `src/components/warranty/ReceiptScanPreview.tsx` (11), `scripts/fetch-ocr-models.mjs` (1), `scripts/ocr-probe.mjs` (8), `scripts/vendor-scanner-assets.mjs` (10), `vendor/ocr-models/` four blobs plus `NOTICE` (1).

**Modified:** `package.json` deps and scripts (1), `next.config.ts` (1), `src/lib/warranty/ocr/engine.ts` (8), `src/lib/warranty/ocr/queue.ts` (8, two lines), `src/app/(app)/settings/about-panel.tsx` and `page.tsx` (9), `src/lib/auth/security-headers.ts` (10), `src/components/warranty/ReceiptUploader.tsx` (11), `Dockerfile` and `scripts/check-ocr-assets.mjs` and `.github/workflows/release-image.yml` (12), `.gitignore` (10), `package.json` version plus `CHANGELOG.md` plus `README.md` plus `INSTALL.md` (13).

**Explicitly not modified:** `src/lib/warranty/ocr/pdf.ts`, `src/lib/warranty/ocr/assets.ts`, `src/lib/warranty/suggest.ts`, `src/lib/warranty/search.ts`, `src/lib/warranty/items.ts`, `src/lib/scheduler.ts`, `src/db/schema.ts`, every file under `drizzle/`, `src/app/(app)/warranties/actions.ts`, `tests/ops/install.test.ts`, `tests/ops/notify-egress.test.ts`.

## Task order

```
1  (assets, EMPIRICAL, network)  <- everything waits on this
|
2  constants + dict
|
3  session + preprocess
|
4  contours + detect
|
5  crop + classify
|
6  recognize + assemble
|
7  onnx/engine
|
8  probe + selector + tesseract move + queue          10  scanner vendoring + CSP + ops
|                                                     |
9  Settings warning + integration walk                11  scan.ts + preview + uploader
\                                                     /
 \___________________ 12  Docker + guard + workflow _/
                      |
                      13 release
```

Tasks 10 and 11 are the client half and depend on nothing between 2 and 9. They can interleave with them. Task 12 needs Task 7 (the models must be in use) and Task 10 (`public/scanner/` must exist). Task 13 is last.

<!-- END HEADER -->

---

# Phase 1: Vendored assets and the pure core

## Task 1: The models, the fetch script, the NOTICE, `models.ts` and the four pinned dependencies

**THIS TASK IS MANDATORY AND EMPIRICAL. IT NEEDS REAL NETWORK ACCESS, WHICH EXISTS IN THIS ENVIRONMENT. NOTHING DOWNSTREAM STARTS UNTIL IT LANDS.**

**Context:** Spec §3 in full, §10.3, §17.1, §17.2, §17.3, §17.6, plus the research doc's §2. Implements **MUST-2.4, MUST-2.5, MUST-3.1 … MUST-3.14, MUST-10.12, MUST-10.13, MUST-11.2**.

Every later task's constants depend on three facts nobody has measured yet: the recognition model's real output class count, the dictionary file that matches it, and the orientation classifier's real input geometry. This task measures all three against the real bytes and **corrects the spec in place if the research doc's values are wrong**. The three `.onnx` SHA256 values are published by RapidOCR and are pinned; the dictionary has no published hash, which is precisely why it is the release's known-weak link (R2) and why MUST-3.16 exists.

**Files:**
- Create: `scripts/fetch-ocr-models.mjs`
- Create: `vendor/ocr-models/ch_PP-OCRv5_det_mobile.onnx` (binary, committed)
- Create: `vendor/ocr-models/en_PP-OCRv5_rec_mobile.onnx` (binary, committed)
- Create: `vendor/ocr-models/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx` (binary, committed)
- Create: `vendor/ocr-models/en_dict.txt` (text, committed)
- Create: `vendor/ocr-models/NOTICE` (generated by the script, committed)
- Create: `src/lib/warranty/ocr/onnx/models.ts`
- Create: `tests/lib/warranty/ocr/onnx/models.test.ts`
- Create: `tests/ops/notice.test.ts`
- Modify: `package.json` (`dependencies` and `scripts` blocks **only**, never `version`)
- Modify: `next.config.ts` (`serverExternalPackages`)
- Modify: `docs/superpowers/specs/2026-08-18-ocr-engine-swap-design.md` **only if** a measured value contradicts a pinned one

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/models.ts
  export const OCR_MODELS_DIR_RELATIVE = 'vendor/ocr-models';
  export const DET_MODEL_FILENAME = 'ch_PP-OCRv5_det_mobile.onnx';
  export const REC_MODEL_FILENAME = 'en_PP-OCRv5_rec_mobile.onnx';
  export const CLS_MODEL_FILENAME = 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx';
  export const DICT_FILENAME = 'en_dict.txt';
  export const DET_MODEL_SHA256: string;
  export const REC_MODEL_SHA256: string;
  export const CLS_MODEL_SHA256: string;
  export const OCR_DICT_SHA256: string;
  export interface OnnxOcrAssets {
    detPath: string;
    recPath: string;
    clsPath: string;
    dictPath: string;
  }
  export function resolveOnnxOcrAssets(): OnnxOcrAssets;
  export function assertOnnxOcrAssets(): { ok: boolean; missing: string[] };
  export function verifyOnnxOcrAssets(): { ok: boolean; problems: string[] };
  /** verifyOnnxOcrAssets(), and throws OcrUnavailableError naming the failing file. */
  export function requireVerifiedOnnxOcrAssets(): void;
  export function resetOnnxAssetVerificationForTests(): void;
  ```
  Task 3's `session.ts` calls `verifyOnnxOcrAssets()` once before the first session; Task 2's `dict.ts` reads `resolveOnnxOcrAssets().dictPath`; Task 12's `scripts/check-ocr-assets.mjs` duplicates the four filenames and the four hashes as literals and `tests/scripts/check-ocr-assets.test.ts` pins the duplicates against these exports.

### Steps

- [ ] **Step 1: Install the four dependencies at their exact specifiers (MUST-2.4).**

  ```powershell
  npm install --save-exact onnxruntime-node@1.27.0 jscanify@1.4.3 @techstark/opencv-js@4.7.0-release.1
  npm install --save sharp@^0.35.3
  ```

  Then open `package.json` and put this comment block immediately above the four entries in `dependencies`, keeping the entries in alphabetical order among the existing ones. JSON has no comments, so the block goes in as a sibling `"//ocr-pins"` key, which is the only way to carry MUST-2.4's required reasoning in this file:

  ```json
    "//ocr-pins": "onnxruntime-node is exact because the ARM instruction-set risk the runtime probe exists for is a property of one ORT build; a silent minor bump changes the MLAS kernels this release was probed against. jscanify is exact because it is pinned against one OpenCV.js API generation. @techstark/opencv-js is exact and must be 4.7.0-release.1; the 5.0.x builds from the same publisher change enough API surface that pairing them with jscanify 1.4.3 is untested. sharp takes a caret: per-platform optional deps, mature, and 0.34.5 was already present only as a transitive of Next.",
  ```

  **Confirm `version` in `package.json` is untouched.** Print it and note the value; v1.4.0 may have moved it and that is fine.

  ```powershell
  node -e "const p=require('./package.json');console.log('version',p.version);for(const k of ['onnxruntime-node','sharp','jscanify','@techstark/opencv-js'])console.log(k,p.dependencies[k])"
  ```
  Expected: `onnxruntime-node 1.27.0`, `sharp ^0.35.3`, `jscanify 1.4.3`, `@techstark/opencv-js 4.7.0-release.1`.

- [ ] **Step 2: Add the three npm scripts.** In `package.json`'s `scripts`, beside the existing `fetch-tessdata` entry:

  ```json
      "fetch-ocr-models": "node scripts/fetch-ocr-models.mjs",
      "ocr-probe": "node scripts/ocr-probe.mjs",
      "vendor-scanner-assets": "node scripts/vendor-scanner-assets.mjs",
  ```

  The last two point at scripts Tasks 8 and 10 create. Adding all three now keeps MUST-2.4's package.json edit to one reviewed change. **Do not add any lifecycle hook** (`postinstall`, `prepare`, `pretest`, `prebuild`) that touches any of them; MUST-3.5 forbids it and `tests/scripts/check-ocr-assets.test.ts` already asserts the tessdata equivalent.

- [ ] **Step 3: Extend `serverExternalPackages` in `next.config.ts` (MUST-10.12, MUST-10.13).**

  ```ts
  // Native / CJS-only packages must not be bundled by the server compiler.
  // tesseract.js and pdfjs-dist join them for a different reason (MUST-2.2): the tesseract
  // worker is loaded BY FILE PATH from node_modules, so if Next bundles the library that
  // path stops existing and it silently falls back to its CDN defaults — the exact failure
  // the offline-install invariant forbids.
  // onnxruntime-node and sharp load native .node binaries by path at run time; bundling
  // either one breaks that resolution.
  serverExternalPackages: [
    'better-sqlite3',
    'argon2',
    'node-cron',
    'tesseract.js',
    'tesseract.js-core',
    'pdfjs-dist',
    'onnxruntime-node',
    'sharp',
  ],
  ```

  No webpack or turbopack configuration is added. `public/scanner/*` are static files served by Next's own public-directory handler and are never imported by the bundler.

- [ ] **Step 4: Write `scripts/fetch-ocr-models.mjs` (MUST-3.5 … MUST-3.9).**

  Mirror `scripts/fetch-tessdata.mjs`'s shape: plain ESM, no `@/` alias, a header comment that says in those words that it is maintainer-run.

  ```js
  /**
   * ONE-TIME maintainer tool. Run it by hand with internet access:
   *
   *   npm run fetch-ocr-models
   *
   * It is never run by `docker build`, never by a test, never by the app, and never by an
   * npm lifecycle hook. The four files it writes are COMMITTED to the repository, which is
   * what lets a build on a firewalled NAS, and a build on a day ModelScope is down, both
   * work. Same pattern as scripts/fetch-tessdata.mjs.
   */
  import fs from 'node:fs';
  import path from 'node:path';
  import { createHash } from 'node:crypto';

  const ROOT = path.resolve(import.meta.dirname, '..');
  const OUT_DIR = path.join(ROOT, 'vendor', 'ocr-models');

  // The tag is part of the path and is never replaced with main or master. A moving
  // reference is how a model silently changes underneath a SHA256 that was correct last
  // month. These three hashes are the values RapidOCR publishes in
  // python/rapidocr/default_models.yaml at this same tag.
  const RAPIDOCR_TAG = 'v3.9.2';
  const MODELSCOPE_BASE = `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/${RAPIDOCR_TAG}/onnx/PP-OCRv5`;

  const MODELS = [
    {
      filename: 'ch_PP-OCRv5_det_mobile.onnx',
      url: `${MODELSCOPE_BASE}/det/ch_PP-OCRv5_det_mobile.onnx`,
      sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
    },
    {
      filename: 'en_PP-OCRv5_rec_mobile.onnx',
      url: `${MODELSCOPE_BASE}/rec/en_PP-OCRv5_rec_mobile.onnx`,
      sha256: 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8',
    },
    {
      filename: 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
      url: `${MODELSCOPE_BASE}/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx`,
      sha256: '54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7',
    },
  ];

  // RapidOCR publishes no hash for the dictionary resources, so this one is verified by
  // shape and then pinned by hand into OCR_DICT_SHA256, exactly the TESSDATA_SHA256
  // workflow already in this repository.
  const DICT_URL =
    `https://raw.githubusercontent.com/RapidAI/RapidOCR/${RAPIDOCR_TAG}/python/rapidocr/models/en_dict.txt`;
  const DICT_FILENAME = 'en_dict.txt';
  const MIN_MODEL_BYTES = 400_000;
  const DICT_MIN_LINES = 90;
  const DICT_MAX_LINES = 200;

  function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
  }

  function fail(message) {
    console.error(message);
    process.exit(1);
  }

  async function get(url) {
    const response = await fetch(url);
    if (!response.ok) fail(`${url}\n  refused: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async function fetchModel(model) {
    const body = await get(model.url);
    // A captive portal returns an HTML error page with a 200. Same guard, same reason, as
    // fetch-tessdata.mjs refusing anything under 1,000,000 bytes.
    if (body.length < MIN_MODEL_BYTES) {
      fail(`${model.url}\n  refused: ${body.length} bytes is under the ${MIN_MODEL_BYTES} floor`);
    }
    const actual = sha256(body);
    if (actual !== model.sha256) {
      // Nothing already on disk is overwritten. Verification happens before any byte lands.
      fail(`${model.url}\n  SHA256 MISMATCH\n  expected ${model.sha256}\n  received ${actual}`);
    }
    const target = path.join(OUT_DIR, model.filename);
    fs.writeFileSync(target, body);
    console.log(`wrote ${target}\n  ${body.length} bytes\n  sha256 ${actual}`);
    return body.length;
  }

  async function fetchDict() {
    const body = await get(DICT_URL);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return fail(`${DICT_URL}\n  refused: body is not valid UTF-8`);
    }
    if (text.includes('\r')) fail(`${DICT_URL}\n  refused: body contains CRLF`);
    const withoutTrailer = text.endsWith('\n') ? text.slice(0, -1) : text;
    const lines = withoutTrailer.split('\n');
    if (lines.some((line) => line.length === 0)) fail(`${DICT_URL}\n  refused: body contains a blank line`);
    if (lines.length < DICT_MIN_LINES || lines.length > DICT_MAX_LINES) {
      // Catches an HTML error page, a redirect stub, and ppocr_keys_v1.txt (thousands of
      // lines) being served in place of the English dictionary.
      fail(`${DICT_URL}\n  refused: ${lines.length} lines is outside ${DICT_MIN_LINES}..${DICT_MAX_LINES}`);
    }
    const target = path.join(OUT_DIR, DICT_FILENAME);
    fs.writeFileSync(target, body);
    const digest = sha256(body);
    console.log(`wrote ${target}\n  ${body.length} bytes, ${lines.length} entries\n  sha256 ${digest}`);
    console.log(`\nPaste this into OCR_DICT_SHA256 in src/lib/warranty/ocr/onnx/models.ts:\n  ${digest}\n`);
    return body.length;
  }

  function writeNotice() {
    const apacheLicensePath = path.join(ROOT, 'vendor', 'ocr-models', '.apache-2.0.txt');
    const lines = [
      'Vendored PP-OCRv5 ONNX models and recognition dictionary',
      '',
      `Source repository: https://github.com/RapidAI/RapidOCR at tag ${RAPIDOCR_TAG}`,
      `Weights host:      https://www.modelscope.cn/models/RapidAI/RapidOCR at tag ${RAPIDOCR_TAG}`,
      `Generated:         ${new Date().toISOString().slice(0, 10)} by scripts/fetch-ocr-models.mjs`,
      '',
      'Files and their pinned SHA256 values:',
      ...MODELS.flatMap((model) => [`  ${model.filename}`, `    ${model.url}`, `    ${model.sha256}`]),
      `  ${DICT_FILENAME}`,
      `    ${DICT_URL}`,
      '',
      'Licensing:',
      '  The models are distributed under the Apache License 2.0.',
      '  The conversion scripts are Copyright (c) 2021 RapidOCR Authors.',
      '  The underlying weights are copyright Baidu, released under the Apache License 2.0',
      '  by PaddlePaddle/PaddleOCR.',
      '',
      readApacheLicense(apacheLicensePath),
      '',
    ];
    const target = path.join(OUT_DIR, 'NOTICE');
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
    console.log(`wrote ${target}`);
  }
  ```

  `readApacheLicense` inlines the full Apache-2.0 text. Rather than embedding 11 KB of licence in a script, add the licence text to the script as a single exported template string constant `APACHE_2_0_TEXT` at the bottom of the file and have `readApacheLicense` return it, ignoring its argument; drop the unused `apacheLicensePath` line when you do. Copy the canonical text from `https://www.apache.org/licenses/LICENSE-2.0.txt` while you have network access in this task, and paste it in as a literal so the script needs no network to regenerate the NOTICE.

  Finish `main()`:

  ```js
  async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let total = 0;
    for (const model of MODELS) total += await fetchModel(model);
    total += await fetchDict();
    writeNotice();
    console.log(`total bytes written: ${total}`);
  }

  await main();
  ```

- [ ] **Step 5: RUN IT FOR REAL.**

  ```powershell
  npm run fetch-ocr-models
  ```

  Expected: four `wrote ...` blocks with byte counts and hashes, the dictionary's line count, the `Paste this into OCR_DICT_SHA256` line, `wrote .../NOTICE`, and a total.

  **If the dictionary URL 404s, this is the expected failure and resolving it is this task's job.** The research doc names three candidate locations and says explicitly that RapidOCR reorganised this directory across releases. Try, in order, and stop at the first that returns a file passing the shape guard:
  1. `https://raw.githubusercontent.com/RapidAI/RapidOCR/v3.9.2/python/rapidocr/models/en_dict.txt`
  2. `https://raw.githubusercontent.com/RapidAI/RapidOCR/v3.9.2/python/rapidocr/utils/dict/en_dict.txt`
  3. `https://raw.githubusercontent.com/RapidAI/RapidOCR/v3.9.2/python/rapidocr/models/ppocrv5_latin_dict.txt`
  4. `https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/en_dict.txt`

  Browse the tree if none of the four hits: `https://api.github.com/repos/RapidAI/RapidOCR/git/trees/v3.9.2?recursive=1` filtered for `dict`. **Whichever URL wins becomes `DICT_URL` in the script**, and its provenance goes in the NOTICE. Step 7 is the test that says whether you picked the right one.

- [ ] **Step 6: Write `src/lib/warranty/ocr/onnx/models.ts`, pasting the dictionary hash the script printed (MUST-3.10 … MUST-3.14).**

  ```ts
  import fs from 'node:fs';
  import path from 'node:path';
  import { createHash } from 'node:crypto';
  import { OCR_UNAVAILABLE_MESSAGE, OcrUnavailableError } from '@/lib/warranty/ocr/engine';

  /**
   * PP-OCRv5 ONNX models converted by RapidOCR (https://github.com/RapidAI/RapidOCR) at tag
   * v3.9.2 and distributed under the Apache License 2.0. The underlying weights are
   * copyright Baidu, released under the same licence by PaddlePaddle/PaddleOCR. Full
   * provenance and licence text: vendor/ocr-models/NOTICE.
   *
   * This is the SINGLE place the four vendored paths are computed. Same rule, same reason,
   * as resolveOcrAssets() in ../assets.ts.
   */

  export const OCR_MODELS_DIR_RELATIVE = 'vendor/ocr-models';
  export const DET_MODEL_FILENAME = 'ch_PP-OCRv5_det_mobile.onnx';
  export const REC_MODEL_FILENAME = 'en_PP-OCRv5_rec_mobile.onnx';
  export const CLS_MODEL_FILENAME = 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx';
  export const DICT_FILENAME = 'en_dict.txt';

  /** Published by RapidOCR in python/rapidocr/default_models.yaml at tag v3.9.2. */
  export const DET_MODEL_SHA256 = '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae';
  export const REC_MODEL_SHA256 = 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8';
  export const CLS_MODEL_SHA256 = '54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7';
  /** Regenerate with `npm run fetch-ocr-models`, which prints this value. Upstream publishes none. */
  // Step 5 printed a 64-character lowercase hex digest for en_dict.txt. That literal goes
  // here. Step 9's test hashes the committed file and fails until the two agree, so this
  // cannot be left wrong or approximate.
  export const OCR_DICT_SHA256 = 'paste-the-digest-step-5-printed';

  export interface OnnxOcrAssets {
    detPath: string;
    recPath: string;
    clsPath: string;
    dictPath: string;
  }

  export function resolveOnnxOcrAssets(): OnnxOcrAssets {
    const dir = path.join(process.cwd(), 'vendor', 'ocr-models');
    return {
      detPath: path.join(dir, DET_MODEL_FILENAME),
      recPath: path.join(dir, REC_MODEL_FILENAME),
      clsPath: path.join(dir, CLS_MODEL_FILENAME),
      dictPath: path.join(dir, DICT_FILENAME),
    };
  }

  /** Existence only. Cheap enough to call at boot. */
  export function assertOnnxOcrAssets(): { ok: boolean; missing: string[] } {
    const assets = resolveOnnxOcrAssets();
    const missing = Object.entries(assets)
      .filter(([, value]) => !fs.existsSync(value))
      .map(([name, value]) => `${name}=${value}`);
    return { ok: missing.length === 0, missing };
  }

  const EXPECTED: [keyof OnnxOcrAssets, string][] = [
    ['detPath', DET_MODEL_SHA256],
    ['recPath', REC_MODEL_SHA256],
    ['clsPath', CLS_MODEL_SHA256],
    ['dictPath', OCR_DICT_SHA256],
  ];

  let verification: { ok: boolean; problems: string[] } | null = null;

  /**
   * Existence plus SHA256 of all four. Called ONCE, lazily, before the first InferenceSession
   * is created, and never on the request path afterwards. Hashing 12.7 MB costs roughly 60 ms
   * once. A corrupt or swapped model must never be silently tolerated: its output is
   * indistinguishable from a correct read until someone checks the paper.
   */
  export function verifyOnnxOcrAssets(): { ok: boolean; problems: string[] } {
    if (verification !== null) return verification;
    const assets = resolveOnnxOcrAssets();
    const problems: string[] = [];
    for (const [key, expected] of EXPECTED) {
      const file = assets[key];
      if (!fs.existsSync(file)) {
        problems.push(`${file} is missing`);
        continue;
      }
      const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (actual !== expected) problems.push(`${file} sha256 ${actual} does not match the pinned ${expected}`);
    }
    verification = { ok: problems.length === 0, problems };
    return verification;
  }

  export function resetOnnxAssetVerificationForTests(): void {
    verification = null;
  }

  /**
   * MUST-3.12 / MUST-3.13: a failure puts this process on the tesseract path for its whole
   * life and logs which file failed. It does NOT crash the app, and it does NOT rewrite the
   * cached ocr.engine setting, because a bad file is not a hardware verdict.
   */
  export function requireVerifiedOnnxOcrAssets(): void {
    const result = verifyOnnxOcrAssets();
    if (result.ok) return;
    for (const problem of result.problems) console.error(`[ocr] vendored asset check failed: ${problem}`);
    throw new OcrUnavailableError(OCR_UNAVAILABLE_MESSAGE);
  }
  ```

- [ ] **Step 7: MEASURE THE THREE UNKNOWNS. This is the empirical deliverable.**

  Write a scratch script and run it. Do not commit it.

  ```powershell
  @'
  import ort from 'onnxruntime-node';
  import fs from 'node:fs';
  const dir = 'vendor/ocr-models';

  const dictRaw = fs.readFileSync(`${dir}/en_dict.txt`, 'utf8');
  const parts = dictRaw.split('\n');
  if (parts.at(-1) === '') parts.pop();
  console.log('dictionary entries:', parts.length);
  console.log('first three:', JSON.stringify(parts.slice(0, 3)));
  console.log('last three:', JSON.stringify(parts.slice(-3)));
  console.log('contains a lone space entry:', parts.includes(' '));
  console.log('class count with blank + space:', parts.length + 2);
  console.log('class count with blank only:', parts.length + 1);

  const rec = await ort.InferenceSession.create(`${dir}/en_PP-OCRv5_rec_mobile.onnx`);
  console.log('rec inputs', rec.inputNames, 'outputs', rec.outputNames);
  console.log('rec outputMetadata', JSON.stringify(rec.outputMetadata ?? null));
  const recOut = await rec.run({
    [rec.inputNames[0]]: new ort.Tensor('float32', new Float32Array(1 * 3 * 48 * 320), [1, 3, 48, 320]),
  });
  console.log('rec output dims', recOut[rec.outputNames[0]].dims);
  await rec.release();

  const cls = await ort.InferenceSession.create(`${dir}/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx`);
  console.log('cls inputs', cls.inputNames, 'outputs', cls.outputNames);
  console.log('cls inputMetadata', JSON.stringify(cls.inputMetadata ?? null));
  console.log('cls outputMetadata', JSON.stringify(cls.outputMetadata ?? null));
  await cls.release();

  const det = await ort.InferenceSession.create(`${dir}/ch_PP-OCRv5_det_mobile.onnx`);
  console.log('det inputs', det.inputNames, 'outputs', det.outputNames);
  console.log('det inputMetadata', JSON.stringify(det.inputMetadata ?? null));
  const detOut = await det.run({
    [det.inputNames[0]]: new ort.Tensor('float32', new Float32Array(1 * 3 * 32 * 32), [1, 3, 32, 32]),
  });
  console.log('det output dims', detOut[det.outputNames[0]].dims);
  await det.release();
  '@ | Set-Content -Encoding utf8 .\ocr-measure.mjs
  node .\ocr-measure.mjs
  Remove-Item .\ocr-measure.mjs
  ```

  **Write the output down. The task's report must state, as numbers:**
  1. The dictionary's entry count and which of `entries + 1` or `entries + 2` equals `rec output dims[2]`. That decides `REC_USE_SPACE_CHAR` (MUST-3.15 step 3) for Task 2.
  2. Whether the dictionary already contains a lone `' '` entry, which would make appending a second one wrong.
  3. The classifier's input dims. **If they are `[N, 3, 80, 160]`, §17.3's assumption held and `CLS_INPUT_HEIGHT = 80` / `CLS_INPUT_WIDTH = 160` stand. If they are anything else, or symbolic, say so:** Task 5 pins the fallback to whatever this measured.
  4. Whether the classifier's output has exactly 2 classes (MUST-4.24).
  5. Whether `session.outputMetadata` exists on this ORT build and carries a numeric last dimension, or whether the one-inference route is the only way to read the class count. Task 3's `session.ts` needs to know.

- [ ] **Step 8: If a measured value contradicts the spec, correct the spec (this is part of the deliverable).**

  Edit `docs/superpowers/specs/2026-08-18-ocr-engine-swap-design.md` in place: the affected row in §4.11's table, the affected sentence in §3.5 or §4.6, and one line appended to the revision history naming what was corrected and that it was measured against the real files on 2026-08-18. Do **not** change any of the three published `.onnx` hashes; if one of those mismatched, the download is wrong, not the spec. If nothing contradicts, say so explicitly in the task report; silence is not evidence.

- [ ] **Step 9: Write the failing tests.**

  Create `tests/lib/warranty/ocr/onnx/models.test.ts`:

  ```ts
  import { describe, it, expect, afterEach } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { createHash } from 'node:crypto';
  import {
    CLS_MODEL_FILENAME,
    CLS_MODEL_SHA256,
    DET_MODEL_FILENAME,
    DET_MODEL_SHA256,
    DICT_FILENAME,
    OCR_DICT_SHA256,
    REC_MODEL_FILENAME,
    REC_MODEL_SHA256,
    assertOnnxOcrAssets,
    resetOnnxAssetVerificationForTests,
    resolveOnnxOcrAssets,
    verifyOnnxOcrAssets,
  } from '@/lib/warranty/ocr/onnx/models';

  afterEach(() => resetOnnxAssetVerificationForTests());

  describe('resolveOnnxOcrAssets (MUST-3.10)', () => {
    it('returns four absolute paths under process.cwd()/vendor/ocr-models', () => {
      const assets = resolveOnnxOcrAssets();
      for (const value of Object.values(assets)) {
        expect(path.isAbsolute(value)).toBe(true);
        expect(value.startsWith(path.join(process.cwd(), 'vendor', 'ocr-models'))).toBe(true);
      }
      expect(path.basename(assets.detPath)).toBe(DET_MODEL_FILENAME);
      expect(path.basename(assets.recPath)).toBe(REC_MODEL_FILENAME);
      expect(path.basename(assets.clsPath)).toBe(CLS_MODEL_FILENAME);
      expect(path.basename(assets.dictPath)).toBe(DICT_FILENAME);
    });
  });

  describe('the four pinned hashes match the committed bytes (MUST-3.1, MUST-3.11)', () => {
    it('finds every file present', () => {
      expect(assertOnnxOcrAssets()).toEqual({ ok: true, missing: [] });
    });

    it.each([
      ['detPath', DET_MODEL_SHA256],
      ['recPath', REC_MODEL_SHA256],
      ['clsPath', CLS_MODEL_SHA256],
      ['dictPath', OCR_DICT_SHA256],
    ] as const)('%s hashes to its pinned constant', (key, expected) => {
      const bytes = fs.readFileSync(resolveOnnxOcrAssets()[key]);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    });

    it('every pin is 64 lowercase hex characters', () => {
      for (const pin of [DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256, OCR_DICT_SHA256]) {
        expect(pin).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  describe('verifyOnnxOcrAssets (MUST-3.12, MUST-3.13)', () => {
    it('passes against the committed files', () => {
      expect(verifyOnnxOcrAssets()).toEqual({ ok: true, problems: [] });
    });

    it('is memoised: the second call does not re-read the files', () => {
      const spy = fs.readFileSync;
      let reads = 0;
      // Count reads through a local wrapper rather than a global mock, so a failure here
      // cannot leave fs patched for the rest of the suite.
      const counting = ((...args: Parameters<typeof fs.readFileSync>) => {
        reads += 1;
        return spy(...args);
      }) as typeof fs.readFileSync;
      const original = fs.readFileSync;
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = counting;
      try {
        verifyOnnxOcrAssets();
        const afterFirst = reads;
        verifyOnnxOcrAssets();
        expect(reads).toBe(afterFirst);
        expect(afterFirst).toBe(4);
      } finally {
        (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
      }
    });

    it('names the specific file when one byte is flipped', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-models-'));
      const original = process.cwd();
      try {
        fs.mkdirSync(path.join(dir, 'vendor', 'ocr-models'), { recursive: true });
        const real = resolveOnnxOcrAssets();
        for (const [name, source] of [
          [DET_MODEL_FILENAME, real.detPath],
          [REC_MODEL_FILENAME, real.recPath],
          [CLS_MODEL_FILENAME, real.clsPath],
          [DICT_FILENAME, real.dictPath],
        ] as const) {
          fs.copyFileSync(source, path.join(dir, 'vendor', 'ocr-models', name));
        }
        const victim = path.join(dir, 'vendor', 'ocr-models', DICT_FILENAME);
        const bytes = fs.readFileSync(victim);
        bytes[0] ^= 0xff;
        fs.writeFileSync(victim, bytes);

        process.chdir(dir);
        resetOnnxAssetVerificationForTests();
        const result = verifyOnnxOcrAssets();
        expect(result.ok).toBe(false);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toContain(DICT_FILENAME);
        expect(result.problems[0]).toContain(OCR_DICT_SHA256);
      } finally {
        process.chdir(original);
        resetOnnxAssetVerificationForTests();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  ```

  Create `tests/ops/notice.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import {
    CLS_MODEL_SHA256,
    DET_MODEL_SHA256,
    REC_MODEL_SHA256,
  } from '@/lib/warranty/ocr/onnx/models';

  const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

  describe('vendor/ocr-models/NOTICE (MUST-3.9, MUST-3.14)', () => {
    const notice = read('vendor/ocr-models/NOTICE');

    it('names all three published model hashes', () => {
      for (const hash of [DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256]) {
        expect(notice).toContain(hash);
      }
    });

    it('names the pinned tag and both upstream projects', () => {
      expect(notice).toContain('v3.9.2');
      expect(notice).toContain('RapidOCR');
      expect(notice).toContain('PaddleOCR');
      expect(notice).toContain('Baidu');
    });

    it('carries the full Apache-2.0 licence text', () => {
      expect(notice).toContain('Apache License');
      expect(notice).toContain('Version 2.0, January 2004');
      expect(notice).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    });
  });

  describe('models.ts records the licence provenance (MUST-3.14)', () => {
    it('names the licence, the upstream project and the tag in its header comment', () => {
      const source = read('src/lib/warranty/ocr/onnx/models.ts');
      const header = source.slice(0, source.indexOf('export const OCR_MODELS_DIR_RELATIVE'));
      expect(header).toContain('Apache License 2.0');
      expect(header).toContain('RapidOCR');
      expect(header).toContain('v3.9.2');
    });
  });

  describe('the fetch script is maintainer-run only (MUST-3.5, MUST-11.2)', () => {
    it('says so in its header', () => {
      const source = read('scripts/fetch-ocr-models.mjs');
      expect(source).toContain('ONE-TIME');
      expect(source).toMatch(/never .*docker build/);
      expect(source).toMatch(/never .*test/);
      expect(source).toMatch(/never .*lifecycle hook/);
    });

    it('is not wired to any npm lifecycle hook', () => {
      const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
      expect(pkg.scripts['fetch-ocr-models']).toBe('node scripts/fetch-ocr-models.mjs');
      for (const hook of ['postinstall', 'prepare', 'prebuild', 'pretest', 'build', 'test']) {
        expect(pkg.scripts[hook] ?? '').not.toContain('fetch-ocr-models');
      }
    });

    it('pins the tag in the URL and never a moving reference', () => {
      const source = read('scripts/fetch-ocr-models.mjs');
      expect(source).toContain("RAPIDOCR_TAG = 'v3.9.2'");
      expect(source).not.toMatch(/resolve\/(main|master)\//);
    });
  });

  describe('the four dependencies are pinned as MUST-2.4 requires', () => {
    it('pins three exactly and carries the reason in package.json', () => {
      const pkg = JSON.parse(read('package.json')) as {
        dependencies: Record<string, string>;
        ['//ocr-pins']?: string;
      };
      expect(pkg.dependencies['onnxruntime-node']).toBe('1.27.0');
      expect(pkg.dependencies['jscanify']).toBe('1.4.3');
      expect(pkg.dependencies['@techstark/opencv-js']).toBe('4.7.0-release.1');
      expect(pkg.dependencies['sharp']).toBe('^0.35.3');
      expect(pkg['//ocr-pins'] ?? '').toContain('MLAS');
    });

    it('keeps tesseract.js and its core as the fallback (MUST-5.14)', () => {
      const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
      expect(pkg.dependencies['tesseract.js']).toBeTruthy();
      expect(fs.existsSync(path.join(process.cwd(), 'vendor/tessdata/eng.traineddata.gz'))).toBe(true);
    });
  });

  describe('next.config.ts externalises both native packages (MUST-10.12)', () => {
    it('lists onnxruntime-node and sharp', () => {
      const source = read('next.config.ts');
      expect(source).toContain("'onnxruntime-node'");
      expect(source).toContain("'sharp'");
    });
  });
  ```

- [ ] **Step 10: Run the tests to verify they fail for the right reason.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/models.test.ts tests/ops/notice.test.ts
  ```
  Expected before Step 6's file exists: `Failed to resolve import "@/lib/warranty/ocr/onnx/models"`. After Step 6 with the hash still a placeholder: the dictionary hash assertion fails naming the placeholder.

- [ ] **Step 11: Run them green.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/models.test.ts tests/ops/notice.test.ts
  npx tsc --noEmit
  ```
  Expected: both files pass, `tsc` clean.

- [ ] **Step 12: Confirm the repository grew by roughly 12.7 MB of committed binaries and nothing else.**

  ```powershell
  Get-ChildItem vendor/ocr-models | Select-Object Name,Length
  git status --short
  ```
  Expected: four blobs plus `NOTICE`, total near 12.7 MB, and no `.gitignore` entry covering them (MUST-3.1 commits them; MUST-8.7's gitignore rule is for `public/scanner/` only, and it lands in Task 10).

- [ ] **Step 13: Commit.**

  ```powershell
  git add package.json package-lock.json next.config.ts scripts/fetch-ocr-models.mjs vendor/ocr-models src/lib/warranty/ocr/onnx/models.ts tests/lib/warranty/ocr/onnx/models.test.ts tests/ops/notice.test.ts docs/superpowers/specs/2026-08-18-ocr-engine-swap-design.md
  git commit -m "feat(ocr): vendor the PP-OCRv5 models and pin their hashes

The three .onnx files come from ModelScope at RapidOCR tag v3.9.2 and are
verified against the SHA256 values RapidOCR publishes before a single byte is
written. The dictionary has no published hash, so it is verified by shape and
then pinned by hand, which is the tessdata workflow this repository already
uses. All four are committed rather than downloaded during a build, so a build
on a firewalled NAS and a build on a day ModelScope is down both still work.

models.ts is the one place the four paths are computed and the one place the
hashes live; verification runs once per process before the first session and a
mismatch falls back rather than crashing, because a warranty tracker without
OCR is still a warranty tracker.

onnxruntime-node, jscanify and @techstark/opencv-js are pinned exactly: the
first because the ARM instruction-set risk is a property of one ORT build, the
other two because they are pinned against one OpenCV.js API generation. Both
native packages are added to serverExternalPackages, because bundling either
one breaks its .node resolution."
  ```

---

## Task 2: `onnx/constants.ts` and `onnx/dict.ts`

**Context:** Spec §3.5, §4.11 in full, §8.2 and §8.3's `SCANNER_*` values, §13.2's `dict.test.ts` bullet, §17.1, §17.2, plus resolutions 6, 7 and 9 above. Implements **MUST-2.1, MUST-3.15, MUST-3.16, MUST-4.41**.

**MUST-4.41 requires each constant to carry a one-line comment naming its provenance, and §17.1 requires the implementer to verify every value marked "PaddleOCR" or "RapidOCR" against RapidOCR at tag `v3.9.2` before writing it.** Do that check while writing the file; it is one file review, which is the whole reason the constants live in one file. If a value disagrees with upstream, correct the spec's §4.11 row the same way Task 1 corrected its measurements, and say so in the task report.

MUST-3.16 is the release's load-bearing guard. A wrong dictionary does not fail loudly on its own; it decodes every receipt into plausible-looking nonsense, which is indistinguishable from the bug this release exists to fix.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/constants.ts`
- Create: `src/lib/warranty/ocr/onnx/dict.ts`
- Create: `tests/lib/warranty/ocr/onnx/dict.test.ts` (**loads the real rec model, one tiny inference**)
- Create: `tests/ops/constants.test.ts`

**Interfaces:**
- Consumes: `resolveOnnxOcrAssets()` and `OnnxOcrAssets` from `@/lib/warranty/ocr/onnx/models` (Task 1).
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/constants.ts: PURE, imports nothing
  export const PREPROCESS_MAX_INPUT_PIXELS = 50_000_000;
  export const PREPROCESS_MIN_LONG_SIDE_PX = 1280;
  export const PREPROCESS_MAX_UPSCALE = 3.0;
  export const PREPROCESS_MAX_LONG_SIDE_PX = 4000;
  export const NORMALISE_LOWER_PERCENTILE = 1;
  export const NORMALISE_UPPER_PERCENTILE = 99;
  export const DESKEW_SEARCH_MAX_DEG = 10;
  export const DESKEW_SEARCH_STEP_DEG = 0.5;
  export const DESKEW_MIN_APPLY_DEG = 0.3;
  export const DESKEW_PROFILE_LONG_SIDE_PX = 800;
  export const DESKEW_BACKGROUND = '#ffffff';
  export const DET_LIMIT_SIDE_LEN = 960;
  export const DET_LIMIT_TYPE = 'max';
  export const DET_SIZE_MULTIPLE = 32;
  export const DET_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
  export const DET_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];
  export const DET_SCALE = 1 / 255;
  export const DET_BINARY_THRESH = 0.3;
  export const DET_BOX_THRESH = 0.5;
  export const DET_UNCLIP_RATIO = 1.6;
  export const DET_MAX_CANDIDATES = 1000;
  export const DET_MIN_BOX_SIDE_PX = 3;
  export const DET_USE_DILATION = true;
  export const DET_DILATION_KERNEL = 2;
  export const DET_SCORE_MODE = 'fast';
  export const DET_MAX_BOXES = 200;
  export const CROP_MIN_ROTATE_DEG = 0.5;
  export const CLS_INPUT_HEIGHT = 80;
  export const CLS_INPUT_WIDTH = 160;
  export const CLS_MEAN = 0.5;
  export const CLS_STD = 0.5;
  export const CLS_PAD_VALUE = 0;
  export const CLS_THRESH = 0.9;
  export const CLS_BATCH_SIZE = 6;
  export const REC_INPUT_HEIGHT = 48;
  export const REC_BASE_WIDTH = 320;
  export const REC_MAX_WIDTH = 1200;
  export const REC_MEAN = 0.5;
  export const REC_STD = 0.5;
  export const REC_PAD_VALUE = 0;
  export const REC_BATCH_SIZE = 6;
  export const REC_BLANK_INDEX = 0;
  export const REC_USE_SPACE_CHAR = true;
  export const REC_DROP_SCORE = 0.5;
  export const LINE_OVERLAP_RATIO = 0.5;
  export const LINE_JOIN = ' ';
  export const BLOCK_JOIN = '\n';
  export const ORT_INTRA_OP_THREADS = 2;
  export const ORT_INTER_OP_THREADS = 1;
  export const ORT_GRAPH_OPT = 'all';
  export const ORT_LOG_SEVERITY = 3;
  export const ORT_CPU_MEM_ARENA = false;
  // Additions beyond §4.11, per plan resolution 6.
  export const PIXEL_SCALE = 1 / 255;
  export const REC_WIDTH_MULTIPLE = 8;
  export const CLS_FLIP_DEGREES = 180;
  export const CROP_ANGLE_LIMIT_DEG = 45;
  // Client-safe scanner block, per plan resolution 7.
  export const SCANNER_LOAD_TIMEOUT_MS = 15_000;
  export const SCANNER_WORK_MAX_PX = 1600;
  export const SCANNER_OUTPUT_MAX_PX = 2400;
  export const SCANNER_JPEG_QUALITY = 0.92;
  export const SCANNER_MIN_QUAD_AREA_RATIO = 0.25;
  export const SCANNER_MIN_SIDE_RATIO = 0.05;
  export const SCANNER_AUTO_ACCEPT_MS = 4000;

  // src/lib/warranty/ocr/onnx/dict.ts
  export interface RecDictionary {
    /** Index 0 is the CTC blank. Length is the expected class count. */
    entries: readonly string[];
    classCount: number;
  }
  export function buildRecDictionary(fileText: string): RecDictionary;
  export function loadRecDictionary(): RecDictionary;
  export function assertRecClassCount(dictionary: RecDictionary, modelClassCount: number): void;
  export function resetRecDictionaryForTests(): void;
  ```
  Task 3's `session.ts` calls `loadRecDictionary()` and `assertRecClassCount()`. Tasks 3 to 6 import numbers from `constants.ts` and never write a numeric literal from §4.11's table. Task 11's client files import only the `SCANNER_*` block.

### Steps

- [ ] **Step 1: Write the failing tests.**

  Create `tests/lib/warranty/ocr/onnx/dict.test.ts`. The last suite is the release gate AC10 and it loads the real recognition model.

  ```ts
  import { describe, it, expect, afterEach } from 'vitest';
  import fs from 'node:fs';
  import { REC_BASE_WIDTH, REC_BLANK_INDEX, REC_INPUT_HEIGHT } from '@/lib/warranty/ocr/onnx/constants';
  import { resolveOnnxOcrAssets } from '@/lib/warranty/ocr/onnx/models';
  import {
    assertRecClassCount,
    buildRecDictionary,
    loadRecDictionary,
    resetRecDictionaryForTests,
  } from '@/lib/warranty/ocr/onnx/dict';

  afterEach(() => resetRecDictionaryForTests());

  describe('buildRecDictionary (MUST-3.15)', () => {
    it('puts the CTC blank at index 0', () => {
      const dictionary = buildRecDictionary('a\nb\nc\n');
      expect(REC_BLANK_INDEX).toBe(0);
      expect(dictionary.entries[0]).toBe('');
      expect(dictionary.entries[1]).toBe('a');
    });

    it('drops exactly one trailing empty element and no other', () => {
      const withNewline = buildRecDictionary('a\nb\n');
      const withoutNewline = buildRecDictionary('a\nb');
      expect(withNewline.entries).toEqual(withoutNewline.entries);
    });

    it('keeps a lone space entry rather than trimming it, which would shift every later index', () => {
      const dictionary = buildRecDictionary('a\n \nb\n');
      // blank, 'a', ' ', 'b', and the appended use-space entry.
      expect(dictionary.entries[2]).toBe(' ');
      expect(dictionary.entries[3]).toBe('b');
    });

    it('appends exactly one space entry when REC_USE_SPACE_CHAR is on', () => {
      const dictionary = buildRecDictionary('a\nb\n');
      expect(dictionary.entries.filter((entry) => entry === ' ')).toHaveLength(1);
      expect(dictionary.entries.at(-1)).toBe(' ');
      expect(dictionary.classCount).toBe(dictionary.entries.length);
      expect(dictionary.classCount).toBe(4);
    });
  });

  describe('assertRecClassCount (MUST-3.16)', () => {
    it('passes when the counts agree', () => {
      const dictionary = buildRecDictionary('a\nb\n');
      expect(() => assertRecClassCount(dictionary, 4)).not.toThrow();
    });

    it('throws naming both numbers when they disagree', () => {
      const dictionary = buildRecDictionary('a\nb\n');
      expect(() => assertRecClassCount(dictionary, 97)).toThrow(/\b4\b[\s\S]*\b97\b|\b97\b[\s\S]*\b4\b/);
    });

    it('names the dictionary file in the message so the fix is obvious', () => {
      const dictionary = buildRecDictionary('a\n');
      expect(() => assertRecClassCount(dictionary, 5)).toThrow(/en_dict\.txt/);
    });
  });

  describe('AC10: the real dictionary matches the real recognition model', () => {
    it('loads the committed dictionary without throwing', () => {
      const dictionary = loadRecDictionary();
      expect(dictionary.classCount).toBeGreaterThan(90);
      expect(dictionary.entries[0]).toBe('');
    });

    it('is memoised across calls', () => {
      expect(loadRecDictionary()).toBe(loadRecDictionary());
    });

    // The single most important assertion in this release. If it fails, nothing else
    // matters: every receipt would decode into plausible-looking nonsense.
    it("equals the recognition model's declared output width", async () => {
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(resolveOnnxOcrAssets().recPath);
      try {
        const input = new ort.Tensor(
          'float32',
          new Float32Array(3 * REC_INPUT_HEIGHT * REC_BASE_WIDTH),
          [1, 3, REC_INPUT_HEIGHT, REC_BASE_WIDTH],
        );
        const output = await session.run({ [session.inputNames[0]]: input });
        const dims = output[session.outputNames[0]].dims;
        expect(dims).toHaveLength(3);
        expect(dims[2]).toBe(loadRecDictionary().classCount);
      } finally {
        await session.release();
      }
    });

    it('a deliberately truncated dictionary fails the guard with both numbers', () => {
      const real = fs.readFileSync(resolveOnnxOcrAssets().dictPath, 'utf8');
      const truncated = buildRecDictionary(real.split('\n').slice(0, 20).join('\n'));
      const expected = loadRecDictionary().classCount;
      expect(() => assertRecClassCount(truncated, expected)).toThrow(String(expected));
      expect(() => assertRecClassCount(truncated, expected)).toThrow(String(truncated.classCount));
    });
  });
  ```

  Create `tests/ops/constants.test.ts` (MUST-4.41, §13.4's `constants.test.ts` bullet):

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import * as C from '@/lib/warranty/ocr/onnx/constants';

  const ONNX_DIR = path.join(process.cwd(), 'src/lib/warranty/ocr/onnx');

  /** §4.11's table, verbatim. The plan's four additions are deliberately absent. */
  const TABLE: Record<string, number | string | boolean | readonly number[]> = {
    PREPROCESS_MAX_INPUT_PIXELS: 50_000_000,
    PREPROCESS_MIN_LONG_SIDE_PX: 1280,
    PREPROCESS_MAX_UPSCALE: 3.0,
    PREPROCESS_MAX_LONG_SIDE_PX: 4000,
    NORMALISE_LOWER_PERCENTILE: 1,
    NORMALISE_UPPER_PERCENTILE: 99,
    DESKEW_SEARCH_MAX_DEG: 10,
    DESKEW_SEARCH_STEP_DEG: 0.5,
    DESKEW_MIN_APPLY_DEG: 0.3,
    DESKEW_PROFILE_LONG_SIDE_PX: 800,
    DESKEW_BACKGROUND: '#ffffff',
    DET_LIMIT_SIDE_LEN: 960,
    DET_LIMIT_TYPE: 'max',
    DET_SIZE_MULTIPLE: 32,
    DET_MEAN: [0.485, 0.456, 0.406],
    DET_STD: [0.229, 0.224, 0.225],
    DET_SCALE: 1 / 255,
    DET_BINARY_THRESH: 0.3,
    DET_BOX_THRESH: 0.5,
    DET_UNCLIP_RATIO: 1.6,
    DET_MAX_CANDIDATES: 1000,
    DET_MIN_BOX_SIDE_PX: 3,
    DET_USE_DILATION: true,
    DET_DILATION_KERNEL: 2,
    DET_SCORE_MODE: 'fast',
    DET_MAX_BOXES: 200,
    CROP_MIN_ROTATE_DEG: 0.5,
    CLS_INPUT_HEIGHT: 80,
    CLS_INPUT_WIDTH: 160,
    CLS_MEAN: 0.5,
    CLS_STD: 0.5,
    CLS_PAD_VALUE: 0,
    CLS_THRESH: 0.9,
    CLS_BATCH_SIZE: 6,
    REC_INPUT_HEIGHT: 48,
    REC_BASE_WIDTH: 320,
    REC_MAX_WIDTH: 1200,
    REC_MEAN: 0.5,
    REC_STD: 0.5,
    REC_PAD_VALUE: 0,
    REC_BATCH_SIZE: 6,
    REC_BLANK_INDEX: 0,
    REC_USE_SPACE_CHAR: true,
    REC_DROP_SCORE: 0.5,
    LINE_OVERLAP_RATIO: 0.5,
    LINE_JOIN: ' ',
    BLOCK_JOIN: '\n',
    ORT_INTRA_OP_THREADS: 2,
    ORT_INTER_OP_THREADS: 1,
    ORT_GRAPH_OPT: 'all',
    ORT_LOG_SEVERITY: 3,
    ORT_CPU_MEM_ARENA: false,
  };

  /** 0, 1, 2 and 3 are excluded: they are array indices and channel counts everywhere. */
  const EXEMPT = new Set([0, 1, 2, 3]);

  function bannedNumbers(): Set<number> {
    const out = new Set<number>();
    for (const value of Object.values(TABLE)) {
      const numbers = typeof value === 'number' ? [value] : Array.isArray(value) ? value : [];
      for (const n of numbers) if (!EXEMPT.has(n)) out.add(n);
    }
    // DET_SCALE is 1 / 255; the literal a stage file could reach for is 255, not 0.0039…
    out.delete(1 / 255);
    out.add(255);
    return out;
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  function numericLiterals(source: string): number[] {
    return [...stripComments(source).matchAll(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w.$])/g)].map((m) =>
      Number(m[0].replace(/_/g, '')),
    );
  }

  describe('MUST-4.41: the pinned constant table', () => {
    it.each(Object.entries(TABLE))('%s equals the spec value', (name, expected) => {
      expect((C as Record<string, unknown>)[name]).toEqual(expected);
    });

    it('every other file under onnx/ reaches for the constant, never the number', () => {
      const banned = bannedNumbers();
      const offenders: string[] = [];
      for (const entry of fs.readdirSync(ONNX_DIR)) {
        if (entry === 'constants.ts' || !entry.endsWith('.ts')) continue;
        const found = numericLiterals(fs.readFileSync(path.join(ONNX_DIR, entry), 'utf8'));
        for (const value of found) if (banned.has(value)) offenders.push(`${entry}: ${value}`);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('MUST-2.1: constants.ts, contours.ts and assemble.ts are pure', () => {
    it.each(['constants.ts', 'contours.ts', 'assemble.ts'])('%s imports nothing forbidden', (file) => {
      const source = fs.readFileSync(path.join(ONNX_DIR, file), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
      expect(source).not.toMatch(/from\s+['"]node:/);
      expect(source).not.toMatch(/['"]onnxruntime-node['"]/);
      expect(source).not.toMatch(/from\s+['"]sharp['"]/);
    });

    it('constants.ts imports nothing at all', () => {
      const source = stripComments(fs.readFileSync(path.join(ONNX_DIR, 'constants.ts'), 'utf8'));
      expect(source).not.toMatch(/^\s*import\s/m);
    });
  });
  ```

  Note: the last two `describe` blocks reference `contours.ts` and `assemble.ts`, which Tasks 4 and 6 create. **Write the whole file now and expect those two rows to fail until then.** Splitting the purity assertions away from the constants file they belong with would leave MUST-2.1 unowned. Until Task 6 lands, run this file with `-t` filters as shown in Step 2.

- [ ] **Step 2: Run the tests to verify they fail.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/dict.test.ts tests/ops/constants.test.ts
  ```
  Expected: `Failed to resolve import "@/lib/warranty/ocr/onnx/constants"`.

- [ ] **Step 3: Write `src/lib/warranty/ocr/onnx/constants.ts`.**

  Every entry from the Interfaces block above, in that order, grouped under the same five headings §4.11 uses (Preprocessing, Detection, Orientation classifier, Recognition, Assembly and sessions, then the two plan-resolution blocks). Each gets a one-line comment naming its provenance, taken from §4.11's third column. Four of them carry more than a provenance note:

  ```ts
  /**
   * Every pinned number this release uses. PURE: this file imports nothing, which is what
   * lets the browser scanner import its SCANNER_ block without dragging a Node builtin into
   * the client bundle.
   *
   * MUST-4.41: none of these values appears as a literal anywhere else under onnx/.
   * tests/ops/constants.test.ts fails the build if one does.
   */

  /** PaddleOCR det_limit_side_len default. The one constant most likely to change after the
   *  owner's acceptance run: a receipt is the tall-narrow worst case for a longest-side cap,
   *  so a 3000 by 4000 photo reduces to 720 by 960 and the small print goes with it. The
   *  tested alternative is 1536, which is a single-constant change costing roughly 2.5x the
   *  detection time. Acceptance step A9 decides it on real receipts. */
  export const DET_LIMIT_SIDE_LEN = 960;

  /** RapidOCR box_thresh. PaddleOCR uses 0.6; the more permissive value is chosen because
   *  thermal receipt print is faint and a missed line is worse here than a spurious one,
   *  which REC_DROP_SCORE filters anyway. */
  export const DET_BOX_THRESH = 0.5;

  /** RapidOCR unclip_ratio. PaddleOCR uses 1.5; the wider value keeps descenders and thin
   *  digits inside the crop. */
  export const DET_UNCLIP_RATIO = 1.6;

  /** Normalised space, mid-grey. Padding with normalised -1 (black) puts a black bar after
   *  every short line and the CTC head reads characters into it. */
  export const REC_PAD_VALUE = 0;
  ```

  And the two plan-resolution blocks:

  ```ts
  // Additions beyond the spec's §4.11 table, needed so no stage file has to write a raw
  // number that MUST-4.41 bans.

  /** The same 1 / 255 as DET_SCALE, under a stage-neutral name, because the classifier and
   *  the recogniser normalise with it too. */
  export const PIXEL_SCALE = 1 / 255;
  /** A recognition batch's tensor width is rounded up to a multiple of this. */
  export const REC_WIDTH_MULTIPLE = 8;
  /** Class index 1 from the orientation model means the crop is this far round. */
  export const CLS_FLIP_DEGREES = 180;
  /** A min-area rectangle can describe one shape either way round; a text line is wider than
   *  it is tall, so an angle outside this bound means width and height should be swapped. */
  export const CROP_ANGLE_LIMIT_DEG = 45;

  // The browser scanner's own limits. This block is the only part of this file a 'use client'
  // module imports, and it is why this file may never grow an import.

  /** loadScanner() rejects after this. 9 MB over a LAN on a phone, with headroom. */
  export const SCANNER_LOAD_TIMEOUT_MS = 15_000;
  /** Contour work on a 12 MP bitmap on a mid-range phone takes seconds; at this size it
   *  takes tens of milliseconds and finds the same quad, which is scaled back up after. */
  export const SCANNER_WORK_MAX_PX = 1600;
  /** The corrected image's long side. The recogniser wants more than the working size. */
  export const SCANNER_OUTPUT_MAX_PX = 2400;
  export const SCANNER_JPEG_QUALITY = 0.92;
  /** A quad hugging the full frame is the detector finding the photo's border, not paper. */
  export const SCANNER_MIN_QUAD_AREA_RATIO = 0.25;
  /** A sliver quad is a countertop edge. */
  export const SCANNER_MIN_SIDE_RATIO = 0.05;
  /** The countdown before the corrected image uploads on its own. */
  export const SCANNER_AUTO_ACCEPT_MS = 4000;
  ```

- [ ] **Step 4: Write `src/lib/warranty/ocr/onnx/dict.ts`.**

  ```ts
  import { REC_BLANK_INDEX, REC_USE_SPACE_CHAR } from '@/lib/warranty/ocr/onnx/constants';
  import { DICT_FILENAME, resolveOnnxOcrAssets } from '@/lib/warranty/ocr/onnx/models';
  import fs from 'node:fs';

  export interface RecDictionary {
    /** Index REC_BLANK_INDEX is the CTC blank. Length is the expected class count. */
    entries: readonly string[];
    classCount: number;
  }

  /**
   * MUST-3.15's procedure, in this order and no other. Do NOT trim whitespace and do NOT drop
   * an interior empty line: a space character on its own line is a legitimate entry in some
   * PaddleOCR dictionaries and dropping it silently shifts every index after it, which
   * decodes every receipt into plausible-looking nonsense.
   */
  export function buildRecDictionary(fileText: string): RecDictionary {
    const parts = fileText.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    if (REC_USE_SPACE_CHAR) parts.push(' ');
    const entries: string[] = [];
    entries[REC_BLANK_INDEX] = '';
    entries.push(...parts);
    return { entries, classCount: entries.length };
  }

  let cached: RecDictionary | null = null;

  export function loadRecDictionary(): RecDictionary {
    if (cached !== null) return cached;
    cached = buildRecDictionary(fs.readFileSync(resolveOnnxOcrAssets().dictPath, 'utf8'));
    return cached;
  }

  export function resetRecDictionaryForTests(): void {
    cached = null;
  }

  /**
   * MUST-3.16, and it is load-bearing. A wrong dictionary does not fail on its own; it
   * decodes into confident nonsense, which is indistinguishable from the bug this release
   * exists to fix. Recognition never runs on a mismatch.
   */
  export function assertRecClassCount(dictionary: RecDictionary, modelClassCount: number): void {
    if (dictionary.classCount === modelClassCount) return;
    throw new Error(
      `${DICT_FILENAME} yields ${dictionary.classCount} classes but the recognition model declares ${modelClassCount}. ` +
        'Recognition will not run: a mismatched dictionary decodes every receipt into nonsense that looks correct.',
    );
  }
  ```

  **If Task 1's measurement showed the real dictionary already contains a lone `' '` entry, or that `entries + 1` (not `entries + 2`) equals the model's output width, set `REC_USE_SPACE_CHAR = false` in `constants.ts`, correct §4.11's row and §3.5's step 3, and adjust the `buildRecDictionary` expectations in `dict.test.ts` accordingly.** The AC10 assertion is the arbiter, not the spec's default.

- [ ] **Step 5: Run the tests.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/dict.test.ts
  npx vitest run tests/ops/constants.test.ts -t 'the pinned constant table'
  npx tsc --noEmit
  ```
  Expected: `dict.test.ts` fully green including the AC10 assertion; the constants table green; the two MUST-2.1 rows naming `contours.ts` and `assemble.ts` still failing (they land in Tasks 4 and 6) and the `every other file under onnx/` row passing trivially.

- [ ] **Step 6: Commit.**

  ```powershell
  git add src/lib/warranty/ocr/onnx/constants.ts src/lib/warranty/ocr/onnx/dict.ts tests/lib/warranty/ocr/onnx/dict.test.ts tests/ops/constants.test.ts
  git commit -m "feat(ocr): pin every tensor constant in one file and guard the dictionary

Every number the pipeline uses lives in constants.ts with a comment naming
where it came from, and a test fails the build if any of them appears as a
literal anywhere else. That turns verifying the pipeline against PaddleOCR's
published defaults into one file review instead of a hunt.

dict.ts builds the CTC index table by the exact documented procedure and
refuses to decode when its class count disagrees with the recognition model's
declared output width. A wrong dictionary does not fail on its own, it decodes
into confident nonsense, which is the bug this release exists to fix wearing a
different engine's name. The test proves the guard against the real model
rather than asserting it."
  ```

---

## Task 3: The two native seams, `onnx/session.ts` and `onnx/preprocess.ts`

**Context:** Spec §4.2, §4.10, §4.11's session block, §13.2's `session.test.ts` and `preprocess.test.ts` bullets, §17.3, plus plan resolutions 4 and 5. Implements **MUST-2.3, MUST-3.12, MUST-4.4, MUST-4.5, MUST-4.6, MUST-4.22, MUST-4.24, MUST-4.30 (the session-creation half), MUST-4.36, MUST-4.39's session note**.

These are the release's only two contacts with a native library: `session.ts` with onnxruntime, `preprocess.ts` with sharp. Everything downstream takes plain arrays. Grouping them puts both behind one reviewer's gate and lands the `TensorRun` type Tasks 4 to 6 depend on.

Step 2 of `preprocess.ts`'s sharp pipeline, `.rotate()` with no argument, is the single highest-value line in the module: a phone photo taken in portrait is stored landscape with an orientation tag, and skipping it reads every such receipt sideways.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/session.ts`
- Create: `src/lib/warranty/ocr/onnx/preprocess.ts`
- Create: `tests/helpers/ocr-images.ts`
- Create: `tests/lib/warranty/ocr/onnx/session.test.ts`
- Create: `tests/lib/warranty/ocr/onnx/preprocess.test.ts`

**Interfaces:**
- Consumes: everything from `constants.ts` (Task 2); `loadRecDictionary()`, `assertRecClassCount()` from `dict.ts` (Task 2); `resolveOnnxOcrAssets()`, `requireVerifiedOnnxOcrAssets()` from `models.ts` (Task 1); `OcrUnavailableError` from `@/lib/warranty/ocr/engine`.
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/session.ts
  export interface OnnxTensorData {
    data: Float32Array;
    dims: readonly number[];
  }
  /** The one call a stage module makes into onnxruntime. Nothing else may import ORT. */
  export type TensorRun = (input: OnnxTensorData) => Promise<OnnxTensorData>;
  export interface OnnxOcrSessions {
    runDet: TensorRun;
    runCls: TensorRun;
    runRec: TensorRun;
    /** Read from the classifier graph; the pinned constants are the symbolic-dimension fallback. */
    clsInputHeight: number;
    clsInputWidth: number;
    /** Verified against the dictionary at creation. */
    recClassCount: number;
    dictionary: readonly string[];
  }
  export async function getOnnxOcrSessions(): Promise<OnnxOcrSessions>;
  export async function releaseOnnxOcrSessions(): Promise<void>;
  export function setOnnxSessionsForTests(fake: OnnxOcrSessions | null): void;
  /** Swaps the dynamic onnxruntime-node import for a fake, so session.test.ts can assert the
   *  pinned options and every shape guard without a 12.7 MB model load. */
  export function setOrtLoaderForTests(loader: (() => Promise<unknown>) | null): void;

  // src/lib/warranty/ocr/onnx/preprocess.ts
  /** Raw RGB, 3 channels, 8 bits per channel, no alpha. */
  export interface RawImage {
    data: Buffer;
    width: number;
    height: number;
  }
  export async function preprocessReceipt(filePath: string): Promise<RawImage>;
  /** Exported so the deskew accuracy assertion can measure without running the whole stage. */
  export async function estimateSkewDeg(source: string | Buffer): Promise<number>;
  /** PURE: the projection-profile variance search. 1 marks a dark pixel. */
  export function bestSkewAngleDeg(binary: Uint8Array, width: number, height: number): number;
  /** PURE: Otsu's threshold over an 8-bit greyscale plane. */
  export function otsuThreshold(grey: Uint8Array): number;
  ```
  Task 4's `detect.ts` consumes `RawImage` and `TensorRun`; Task 5's `crop.ts` consumes `RawImage`; Tasks 5 and 6 consume `OnnxOcrSessions`; Task 7's `engine.ts` calls `preprocessReceipt` and `getOnnxOcrSessions`; Task 8's `engine.ts` selector re-exports `setOnnxSessionsForTests` and calls `releaseOnnxOcrSessions`.

### Steps

- [ ] **Step 1: Write the shared image helper.**

  Create `tests/helpers/ocr-images.ts`. Rendering fixtures here rather than committing binaries keeps them reviewable and reproducible.

  ```ts
  import sharp from 'sharp';

  /** A solid RGB plane, for building deterministic inputs. */
  export function solidRgb(width: number, height: number, rgb: [number, number, number]): Buffer {
    const buf = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      buf[i * 3] = rgb[0];
      buf[i * 3 + 1] = rgb[1];
      buf[i * 3 + 2] = rgb[2];
    }
    return buf;
  }

  /** 600 by 400 white with eight black horizontal bars, then rotated by `deg`. */
  export async function barGridPng(deg: number, width = 600, height = 400): Promise<Buffer> {
    const raw = solidRgb(width, height, [255, 255, 255]);
    for (let bar = 0; bar < 8; bar += 1) {
      const top = Math.round(((bar + 1) * height) / 10);
      for (let y = top; y < top + 6; y += 1) {
        for (let x = Math.round(width * 0.1); x < Math.round(width * 0.9); x += 1) {
          const i = (y * width + x) * 3;
          raw[i] = 0;
          raw[i + 1] = 0;
          raw[i + 2] = 0;
        }
      }
    }
    const base = sharp(raw, { raw: { width, height, channels: 3 } });
    const rotated = deg === 0 ? base : base.rotate(deg, { background: '#ffffff' });
    return rotated.png().toBuffer();
  }

  /** A tall red-over-blue image written landscape with EXIF orientation 6, so a reader that
   *  honours the tag sees it upright and one that does not sees it on its side. */
  export async function exifOrientation6Png(): Promise<Buffer> {
    const wide = 120;
    const tall = 60;
    const raw = Buffer.alloc(wide * tall * 3);
    for (let y = 0; y < tall; y += 1) {
      for (let x = 0; x < wide; x += 1) {
        const i = (y * wide + x) * 3;
        const left = x < wide / 2;
        raw[i] = left ? 255 : 0;
        raw[i + 2] = left ? 0 : 255;
      }
    }
    return sharp(raw, { raw: { width: wide, height: tall, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
  }

  /** A `size` by `size` PNG that is fully transparent over pure black. */
  export async function transparentBlackPng(size = 32): Promise<Buffer> {
    const raw = Buffer.alloc(size * size * 4);
    return sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  }
  ```

- [ ] **Step 2: Write the failing tests.**

  Create `tests/lib/warranty/ocr/onnx/preprocess.test.ts`:

  ```ts
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import sharp from 'sharp';
  import {
    DESKEW_MIN_APPLY_DEG,
    PREPROCESS_MAX_LONG_SIDE_PX,
    PREPROCESS_MAX_UPSCALE,
    PREPROCESS_MIN_LONG_SIDE_PX,
  } from '@/lib/warranty/ocr/onnx/constants';
  import { estimateSkewDeg, preprocessReceipt } from '@/lib/warranty/ocr/onnx/preprocess';
  import { barGridPng, exifOrientation6Png, solidRgb, transparentBlackPng } from '../../../../helpers/ocr-images';

  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-pre-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function write(name: string, bytes: Buffer): Promise<string> {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  }

  async function png(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
    return sharp(solidRgb(width, height, rgb), { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  describe('MUST-4.4: the sharp pipeline', () => {
    it('applies the EXIF orientation tag, so a portrait phone photo is not read sideways', async () => {
      const file = await write('exif6.jpg', await exifOrientation6Png());
      const out = await preprocessReceipt(file);
      // Stored 120 by 60 with orientation 6, which means "rotate 90 clockwise to display".
      expect(out.height).toBeGreaterThan(out.width);
    });

    it('flattens transparency onto white, not black', async () => {
      const file = await write('transparent.png', await transparentBlackPng());
      const out = await preprocessReceipt(file);
      expect(out.data[0]).toBeGreaterThan(240);
    });

    it('returns three channels of raw RGB with no alpha', async () => {
      const file = await write('plain.png', await png(1400, 900, [200, 200, 200]));
      const out = await preprocessReceipt(file);
      expect(out.data.length).toBe(out.width * out.height * 3);
    });

    it('upscales a 400 pixel long side to the minimum', async () => {
      const file = await write('small.png', await png(400, 300, [180, 180, 180]));
      const out = await preprocessReceipt(file);
      expect(Math.max(out.width, out.height)).toBe(PREPROCESS_MIN_LONG_SIDE_PX);
    });

    it('caps a 200 pixel image at the maximum upscale rather than reaching the minimum', async () => {
      const file = await write('tiny.png', await png(200, 150, [180, 180, 180]));
      const out = await preprocessReceipt(file);
      expect(Math.max(out.width, out.height)).toBe(Math.round(200 * PREPROCESS_MAX_UPSCALE));
      expect(Math.max(out.width, out.height)).toBeLessThan(PREPROCESS_MIN_LONG_SIDE_PX);
    });

    it('downscales a 6000 pixel image to the maximum', async () => {
      const file = await write('huge.png', await png(6000, 1000, [180, 180, 180]));
      const out = await preprocessReceipt(file);
      expect(Math.max(out.width, out.height)).toBe(PREPROCESS_MAX_LONG_SIDE_PX);
    });
  });

  describe('MUST-4.5 / MUST-4.6: deskew', () => {
    it('measures a 4.0 degree tilt within half a degree', async () => {
      const measured = await estimateSkewDeg(await barGridPng(4));
      expect(Math.abs(measured - 4)).toBeLessThanOrEqual(0.5);
    });

    it('measures a level image below the apply threshold', async () => {
      const measured = await estimateSkewDeg(await barGridPng(0));
      expect(Math.abs(measured)).toBeLessThan(DESKEW_MIN_APPLY_DEG);
    });

    it('leaves a level image byte-identical, proving the no-op path really is a no-op', async () => {
      const level = await write('level.png', await barGridPng(0, 1400, 900));
      const out = await preprocessReceipt(level);
      const reference = await sharp(level)
        .rotate()
        .flatten({ background: '#ffffff' })
        .greyscale()
        .normalise({ lower: 1, upper: 99 })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(Buffer.compare(out.data, reference)).toBe(0);
    });
  });
  ```

  Create `tests/lib/warranty/ocr/onnx/session.test.ts`. It never loads a model; it drives a fake `InferenceSession.create` through the module's own injection seam.

  ```ts
  import { describe, it, expect, afterEach, vi } from 'vitest';
  import {
    ORT_CPU_MEM_ARENA,
    ORT_GRAPH_OPT,
    ORT_INTER_OP_THREADS,
    ORT_INTRA_OP_THREADS,
    ORT_LOG_SEVERITY,
  } from '@/lib/warranty/ocr/onnx/constants';
  import {
    getOnnxOcrSessions,
    releaseOnnxOcrSessions,
    setOnnxSessionsForTests,
    setOrtLoaderForTests,
    type OnnxTensorData,
  } from '@/lib/warranty/ocr/onnx/session';

  interface FakeSession {
    inputNames: string[];
    outputNames: string[];
    inputMetadata: { name: string; shape: (number | string)[] }[];
    outputMetadata: { name: string; shape: (number | string)[] }[];
    run: (feeds: Record<string, unknown>) => Promise<Record<string, OnnxTensorData>>;
    release: () => Promise<void>;
  }

  function fakeSession(over: Partial<FakeSession> = {}): FakeSession {
    return {
      inputNames: ['x'],
      outputNames: ['y'],
      inputMetadata: [{ name: 'x', shape: [1, 3, 80, 160] }],
      outputMetadata: [{ name: 'y', shape: [1, 2] }],
      run: async () => ({ y: { data: new Float32Array([1, 0]), dims: [1, 2] } }),
      release: async () => {},
      ...over,
    };
  }

  afterEach(async () => {
    setOnnxSessionsForTests(null);
    setOrtLoaderForTests(null);
    await releaseOnnxOcrSessions();
    vi.restoreAllMocks();
  });

  function loader(created: { path: string; options: Record<string, unknown> }[], classCount: number) {
    return async () => ({
      InferenceSession: {
        create: async (modelPath: string, options: Record<string, unknown>) => {
          created.push({ path: modelPath, options });
          if (modelPath.includes('rec')) {
            return fakeSession({
              outputMetadata: [{ name: 'y', shape: [1, 'T', classCount] }],
              run: async () => ({ y: { data: new Float32Array(classCount), dims: [1, 1, classCount] } }),
            });
          }
          return fakeSession();
        },
      },
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[],
        ) {}
      },
    });
  }

  describe('MUST-4.36: session options are pinned', () => {
    it('passes the six options verbatim to every create call', async () => {
      const created: { path: string; options: Record<string, unknown> }[] = [];
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(loader(created, classCount));
      await getOnnxOcrSessions();
      expect(created).toHaveLength(3);
      for (const call of created) {
        expect(call.options).toEqual({
          executionProviders: ['cpu'],
          intraOpNumThreads: ORT_INTRA_OP_THREADS,
          interOpNumThreads: ORT_INTER_OP_THREADS,
          graphOptimizationLevel: ORT_GRAPH_OPT,
          logSeverityLevel: ORT_LOG_SEVERITY,
          enableCpuMemArena: ORT_CPU_MEM_ARENA,
        });
      }
    });
  });

  describe('lifecycle', () => {
    it('creates the three sessions once and reuses them', async () => {
      const created: { path: string; options: Record<string, unknown> }[] = [];
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(loader(created, classCount));
      await getOnnxOcrSessions();
      await getOnnxOcrSessions();
      expect(created).toHaveLength(3);
    });

    it('releases all three, and a later call builds fresh ones', async () => {
      const created: { path: string; options: Record<string, unknown> }[] = [];
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(loader(created, classCount));
      await getOnnxOcrSessions();
      await releaseOnnxOcrSessions();
      await getOnnxOcrSessions();
      expect(created).toHaveLength(6);
    });

    it('a release that throws on one session still releases the other two', async () => {
      let released = 0;
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(async () => ({
        InferenceSession: {
          create: async (modelPath: string) =>
            fakeSession({
              outputMetadata: modelPath.includes('rec')
                ? [{ name: 'y', shape: [1, 'T', classCount] }]
                : [{ name: 'y', shape: [1, 2] }],
              release: async () => {
                released += 1;
                if (modelPath.includes('det')) throw new Error('release exploded');
              },
            }),
        },
        Tensor: class {
          constructor(
            readonly type: string,
            readonly data: Float32Array,
            readonly dims: readonly number[],
          ) {}
        },
      }));
      await getOnnxOcrSessions();
      await expect(releaseOnnxOcrSessions()).resolves.toBeUndefined();
      expect(released).toBe(3);
    });
  });

  describe('shape guards', () => {
    it('reads the classifier input shape from the graph when it is static (MUST-4.22)', async () => {
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(loader([], classCount));
      const sessions = await getOnnxOcrSessions();
      expect(sessions.clsInputHeight).toBe(80);
      expect(sessions.clsInputWidth).toBe(160);
    });

    it('falls back to the pinned shape when the dimension is symbolic (MUST-4.22)', async () => {
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(async () => ({
        InferenceSession: {
          create: async (modelPath: string) =>
            fakeSession({
              inputMetadata: [{ name: 'x', shape: ['N', 3, 'H', 'W'] }],
              outputMetadata: modelPath.includes('rec')
                ? [{ name: 'y', shape: [1, 'T', classCount] }]
                : [{ name: 'y', shape: [1, 2] }],
            }),
        },
        Tensor: class {
          constructor(
            readonly type: string,
            readonly data: Float32Array,
            readonly dims: readonly number[],
          ) {}
        },
      }));
      const { CLS_INPUT_HEIGHT, CLS_INPUT_WIDTH } = await import('@/lib/warranty/ocr/onnx/constants');
      const sessions = await getOnnxOcrSessions();
      expect(sessions.clsInputHeight).toBe(CLS_INPUT_HEIGHT);
      expect(sessions.clsInputWidth).toBe(CLS_INPUT_WIDTH);
    });

    it('throws when the classifier does not have exactly two classes (MUST-4.24)', async () => {
      const { classCount } = await import('@/lib/warranty/ocr/onnx/dict').then((m) => m.loadRecDictionary());
      setOrtLoaderForTests(async () => ({
        InferenceSession: {
          create: async (modelPath: string) =>
            fakeSession({
              outputMetadata: modelPath.includes('rec')
                ? [{ name: 'y', shape: [1, 'T', classCount] }]
                : [{ name: 'y', shape: [1, 4] }],
            }),
        },
        Tensor: class {
          constructor(
            readonly type: string,
            readonly data: Float32Array,
            readonly dims: readonly number[],
          ) {}
        },
      }));
      await expect(getOnnxOcrSessions()).rejects.toThrow(/2 classes/);
    });

    it('throws when the recognition width disagrees with the dictionary (MUST-3.16)', async () => {
      setOrtLoaderForTests(loader([], 7));
      await expect(getOnnxOcrSessions()).rejects.toThrow(/en_dict\.txt/);
    });
  });

  describe('setOnnxSessionsForTests (MUST-5.13)', () => {
    it('short-circuits creation entirely', async () => {
      const created: { path: string; options: Record<string, unknown> }[] = [];
      setOrtLoaderForTests(loader(created, 3));
      setOnnxSessionsForTests({
        runDet: async () => ({ data: new Float32Array(1), dims: [1, 1, 1, 1] }),
        runCls: async () => ({ data: new Float32Array(2), dims: [1, 2] }),
        runRec: async () => ({ data: new Float32Array(3), dims: [1, 1, 3] }),
        clsInputHeight: 80,
        clsInputWidth: 160,
        recClassCount: 3,
        dictionary: ['', 'a', ' '],
      });
      const sessions = await getOnnxOcrSessions();
      expect(sessions.recClassCount).toBe(3);
      expect(created).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 3: Run the tests to verify they fail.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/preprocess.test.ts tests/lib/warranty/ocr/onnx/session.test.ts
  ```
  Expected: `Failed to resolve import "@/lib/warranty/ocr/onnx/preprocess"` and the same for `session`.

- [ ] **Step 4: Write `src/lib/warranty/ocr/onnx/session.ts`.**

  ```ts
  import {
    CLS_INPUT_HEIGHT,
    CLS_INPUT_WIDTH,
    ORT_CPU_MEM_ARENA,
    ORT_GRAPH_OPT,
    ORT_INTER_OP_THREADS,
    ORT_INTRA_OP_THREADS,
    ORT_LOG_SEVERITY,
    REC_BASE_WIDTH,
    REC_INPUT_HEIGHT,
  } from '@/lib/warranty/ocr/onnx/constants';
  import { assertRecClassCount, loadRecDictionary } from '@/lib/warranty/ocr/onnx/dict';
  import { requireVerifiedOnnxOcrAssets, resolveOnnxOcrAssets } from '@/lib/warranty/ocr/onnx/models';

  /**
   * One of exactly two places in the tree that import onnxruntime-node (the other is
   * scripts/ocr-probe.mjs). The import is dynamic so a boot on hardware where the native
   * binding cannot even load does not take the process down at module-evaluation time.
   * tests/ops/ocr-egress.test.ts fails on a third import site.
   */

  export interface OnnxTensorData {
    data: Float32Array;
    dims: readonly number[];
  }

  export type TensorRun = (input: OnnxTensorData) => Promise<OnnxTensorData>;

  export interface OnnxOcrSessions {
    runDet: TensorRun;
    runCls: TensorRun;
    runRec: TensorRun;
    clsInputHeight: number;
    clsInputWidth: number;
    recClassCount: number;
    dictionary: readonly string[];
  }

  interface OrtLike {
    InferenceSession: {
      create(path: string, options: Record<string, unknown>): Promise<OrtSessionLike>;
    };
    Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
  }

  interface OrtSessionLike {
    inputNames: string[];
    outputNames: string[];
    inputMetadata?: { name: string; shape: (number | string)[] }[];
    outputMetadata?: { name: string; shape: (number | string)[] }[];
    run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorData>>;
    release(): Promise<void>;
  }

  type OrtLoader = () => Promise<OrtLike>;

  const SESSION_OPTIONS = {
    executionProviders: ['cpu'],
    intraOpNumThreads: ORT_INTRA_OP_THREADS,
    interOpNumThreads: ORT_INTER_OP_THREADS,
    graphOptimizationLevel: ORT_GRAPH_OPT,
    logSeverityLevel: ORT_LOG_SEVERITY,
    // Off on purpose. The arena retains allocated blocks for reuse, which is a throughput
    // optimisation; with a few receipts a day and a 60 second idle teardown, retention is
    // the opposite of what is wanted.
    enableCpuMemArena: ORT_CPU_MEM_ARENA,
  } as const;

  let loader: OrtLoader = () => import('onnxruntime-node') as unknown as Promise<OrtLike>;
  let live: { sessions: OnnxOcrSessions; raw: OrtSessionLike[] } | null = null;
  let injected: OnnxOcrSessions | null = null;
  let creating: Promise<OnnxOcrSessions> | null = null;

  export function setOrtLoaderForTests(next: OrtLoader | null): void {
    loader = next ?? (() => import('onnxruntime-node') as unknown as Promise<OrtLike>);
  }

  export function setOnnxSessionsForTests(fake: OnnxOcrSessions | null): void {
    injected = fake;
  }

  function lastStaticDim(shape: (number | string)[] | undefined, index: number, fallback: number): number {
    const value = shape?.[index];
    return typeof value === 'number' && value > 0 ? value : fallback;
  }

  function runnerFor(ort: OrtLike, session: OrtSessionLike): TensorRun {
    return async (input) => {
      const tensor = new ort.Tensor('float32', input.data, input.dims);
      const output = await session.run({ [session.inputNames[0]]: tensor });
      return output[session.outputNames[0]];
    };
  }

  async function readRecClassCount(session: OrtSessionLike, run: TensorRun): Promise<number> {
    const declared = session.outputMetadata?.[0]?.shape;
    const last = declared?.[declared.length - 1];
    if (typeof last === 'number' && last > 0) return last;
    // The metadata dimension is symbolic or the build does not expose it. One zero-filled
    // forward pass at the reference input shape is the only other way to read the width,
    // and it costs a few milliseconds once per process.
    const probe = await run({
      data: new Float32Array(3 * REC_INPUT_HEIGHT * REC_BASE_WIDTH),
      dims: [1, 3, REC_INPUT_HEIGHT, REC_BASE_WIDTH],
    });
    return probe.dims[probe.dims.length - 1];
  }

  async function build(): Promise<OnnxOcrSessions> {
    requireVerifiedOnnxOcrAssets();
    const assets = resolveOnnxOcrAssets();
    const ort = await loader();
    const det = await ort.InferenceSession.create(assets.detPath, { ...SESSION_OPTIONS });
    const cls = await ort.InferenceSession.create(assets.clsPath, { ...SESSION_OPTIONS });
    const rec = await ort.InferenceSession.create(assets.recPath, { ...SESSION_OPTIONS });

    const clsOut = cls.outputMetadata?.[0]?.shape;
    const clsClasses = clsOut?.[clsOut.length - 1];
    if (clsClasses !== 2) {
      throw new Error(
        `The orientation model declares ${String(clsClasses)} output classes; it must declare exactly 2 classes.`,
      );
    }

    const runRec = runnerFor(ort, rec);
    const recClassCount = await readRecClassCount(rec, runRec);
    const dictionary = loadRecDictionary();
    assertRecClassCount(dictionary, recClassCount);

    const sessions: OnnxOcrSessions = {
      runDet: runnerFor(ort, det),
      runCls: runnerFor(ort, cls),
      runRec,
      clsInputHeight: lastStaticDim(cls.inputMetadata?.[0]?.shape, 2, CLS_INPUT_HEIGHT),
      clsInputWidth: lastStaticDim(cls.inputMetadata?.[0]?.shape, 3, CLS_INPUT_WIDTH),
      recClassCount,
      dictionary: dictionary.entries,
    };
    live = { sessions, raw: [det, cls, rec] };
    return sessions;
  }

  /** Lazily created, and created together. At most three sessions exist at a time. */
  export async function getOnnxOcrSessions(): Promise<OnnxOcrSessions> {
    if (injected !== null) return injected;
    if (live !== null) return live.sessions;
    if (creating === null) {
      creating = build().finally(() => {
        creating = null;
      });
    }
    return creating;
  }

  export async function releaseOnnxOcrSessions(): Promise<void> {
    const current = live;
    live = null;
    if (current === null) return;
    for (const session of current.raw) {
      try {
        await session.release();
      } catch (error) {
        console.warn('[ocr] session release failed', error);
      }
    }
  }
  ```

- [ ] **Step 5: Write `src/lib/warranty/ocr/onnx/preprocess.ts`.**

  ```ts
  import sharp from 'sharp';
  import {
    DESKEW_BACKGROUND,
    DESKEW_MIN_APPLY_DEG,
    DESKEW_PROFILE_LONG_SIDE_PX,
    DESKEW_SEARCH_MAX_DEG,
    DESKEW_SEARCH_STEP_DEG,
    NORMALISE_LOWER_PERCENTILE,
    NORMALISE_UPPER_PERCENTILE,
    PREPROCESS_MAX_INPUT_PIXELS,
    PREPROCESS_MAX_LONG_SIDE_PX,
    PREPROCESS_MAX_UPSCALE,
    PREPROCESS_MIN_LONG_SIDE_PX,
  } from '@/lib/warranty/ocr/onnx/constants';

  /** Raw RGB, 3 channels, 8 bits per channel, no alpha. */
  export interface RawImage {
    data: Buffer;
    width: number;
    height: number;
  }

  export function otsuThreshold(grey: Uint8Array): number {
    const histogram = new Float64Array(256);
    for (const value of grey) histogram[value] += 1;
    const total = grey.length;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
    let sumBackground = 0;
    let weightBackground = 0;
    let best = 0;
    let bestVariance = -1;
    for (let t = 0; t < 256; t += 1) {
      weightBackground += histogram[t];
      if (weightBackground === 0) continue;
      const weightForeground = total - weightBackground;
      if (weightForeground === 0) break;
      sumBackground += t * histogram[t];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (between > bestVariance) {
        bestVariance = between;
        best = t;
      }
    }
    return best;
  }

  /**
   * Skew is estimated by a horizontal projection profile search, not a Hough transform and
   * not a second detection pass: rotate the binary copy, sum dark pixels per row, and score
   * the angle as the VARIANCE of that row-sum vector. Horizontal text lines produce sharp
   * peaks and troughs, so the variance is maximal when the lines are level.
   */
  export function bestSkewAngleDeg(binary: Uint8Array, width: number, height: number): number {
    const centreX = (width - 1) / 2;
    const centreY = (height - 1) / 2;
    let bestAngle = 0;
    let bestScore = -1;
    for (let angle = -DESKEW_SEARCH_MAX_DEG; angle <= DESKEW_SEARCH_MAX_DEG; angle += DESKEW_SEARCH_STEP_DEG) {
      const radians = (angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const rows = new Float64Array(height);
      for (let y = 0; y < height; y += 1) {
        const dy = y - centreY;
        for (let x = 0; x < width; x += 1) {
          if (binary[y * width + x] === 0) continue;
          const dx = x - centreX;
          // Nearest-neighbour destination row for this source pixel under the rotation.
          const ry = Math.round(centreY + dx * sin + dy * cos);
          if (ry >= 0 && ry < height) rows[ry] += 1;
        }
      }
      let mean = 0;
      for (const value of rows) mean += value;
      mean /= height;
      let variance = 0;
      for (const value of rows) variance += (value - mean) ** 2;
      if (variance > bestScore) {
        bestScore = variance;
        bestAngle = angle;
      }
    }
    // Floating accumulation over the loop can leave a value like 3.9999999; the search grid
    // is what the caller compares against.
    return Math.round(bestAngle / DESKEW_SEARCH_STEP_DEG) * DESKEW_SEARCH_STEP_DEG;
  }

  /** Runs on a downsampled copy and never on the full image. */
  export async function estimateSkewDeg(source: string | Buffer): Promise<number> {
    const { data, info } = await sharp(source)
      .rotate()
      .flatten({ background: DESKEW_BACKGROUND })
      .greyscale()
      .resize({
        width: DESKEW_PROFILE_LONG_SIDE_PX,
        height: DESKEW_PROFILE_LONG_SIDE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const grey = new Uint8Array(data.buffer, data.byteOffset, info.width * info.height);
    const threshold = otsuThreshold(grey);
    const binary = new Uint8Array(grey.length);
    for (let i = 0; i < grey.length; i += 1) binary[i] = grey[i] <= threshold ? 1 : 0;
    return bestSkewAngleDeg(binary, info.width, info.height);
  }

  function resizeTarget(width: number, height: number): { width: number; height: number } | null {
    const longSide = Math.max(width, height);
    if (longSide > PREPROCESS_MAX_LONG_SIDE_PX) {
      return { width: PREPROCESS_MAX_LONG_SIDE_PX, height: PREPROCESS_MAX_LONG_SIDE_PX };
    }
    if (longSide < PREPROCESS_MIN_LONG_SIDE_PX) {
      const factor = Math.min(PREPROCESS_MIN_LONG_SIDE_PX / longSide, PREPROCESS_MAX_UPSCALE);
      const target = Math.round(longSide * factor);
      return { width: target, height: target };
    }
    return null;
  }

  export async function preprocessReceipt(filePath: string): Promise<RawImage> {
    const base = sharp(filePath, { limitInputPixels: PREPROCESS_MAX_INPUT_PIXELS, failOn: 'error' })
      // No argument: applies the EXIF orientation tag and then strips it. A phone photo taken
      // in portrait is stored landscape with an orientation tag, and skipping this reads every
      // such receipt sideways.
      .rotate()
      .flatten({ background: '#ffffff' })
      .greyscale()
      // Percentile-bounded rather than absolute min and max, so one specular highlight from a
      // kitchen light does not anchor the stretch and flatten the rest of the receipt.
      .normalise({ lower: NORMALISE_LOWER_PERCENTILE, upper: NORMALISE_UPPER_PERCENTILE });

    const metadata = await sharp(filePath, { limitInputPixels: PREPROCESS_MAX_INPUT_PIXELS }).metadata();
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
    const width = (rotated ? metadata.height : metadata.width) ?? 0;
    const height = (rotated ? metadata.width : metadata.height) ?? 0;
    const target = resizeTarget(width, height);
    const sized = target === null ? base : base.resize({ ...target, fit: 'inside', kernel: 'lanczos3' });

    const staged = await sized.png().toBuffer();
    const angle = await estimateSkewDeg(staged);
    // Below the threshold the resample costs more than it gains, and skipping it is what the
    // no-op assertion in preprocess.test.ts proves.
    const deskewed =
      Math.abs(angle) < DESKEW_MIN_APPLY_DEG ? sharp(staged) : sharp(staged).rotate(-angle, { background: DESKEW_BACKGROUND });

    const { data, info } = await deskewed
      // Three identical channels. The models take 3; feeding them a greyscale-derived
      // 3-channel image is deliberate, because a colour cast on a thermal receipt carries no
      // signal and costs contrast.
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }
  ```

- [ ] **Step 6: Run the tests until green.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/preprocess.test.ts tests/lib/warranty/ocr/onnx/session.test.ts
  npx tsc --noEmit
  ```
  Expected: both green, `tsc` clean.

  If the no-op assertion in `preprocess.test.ts` fails on a byte or two, the cause is the intermediate PNG round-trip, not the deskew. Fix it by comparing the reference through the same round-trip rather than by loosening the assertion; a tolerance here would stop proving that the no-op path is a no-op.

- [ ] **Step 7: Commit.**

  ```powershell
  git add src/lib/warranty/ocr/onnx/session.ts src/lib/warranty/ocr/onnx/preprocess.ts tests/helpers/ocr-images.ts tests/lib/warranty/ocr/onnx/session.test.ts tests/lib/warranty/ocr/onnx/preprocess.test.ts
  git commit -m "feat(ocr): the two native seams, sessions and sharp preprocessing

session.ts is the only place in the app that imports onnxruntime, and it hands
every other stage a plain function that takes an array and returns an array.
That is what MUST-2.3 requires and it is also what makes the rest of the
pipeline testable without loading twelve megabytes of model. Both shape guards
live here, at the one point where catching a mismatch is cheap: the classifier
must declare exactly two classes, and the recognition width must agree with the
dictionary or nothing decodes.

preprocess.ts applies the EXIF orientation tag before anything else, which is
the line that stops a portrait phone photo being read sideways. Deskew is a
projection-profile search over 41 candidate angles on an 800 pixel copy, and
below a third of a degree it does not resample at all; a test proves that path
is byte-identical rather than merely close."
  ```

---

## Task 4: `onnx/contours.ts` and `onnx/detect.ts`: DBNet detection and its post-process

**Context:** Spec §4.3, §4.4 in full, §13.2's `contours.test.ts` and `detect.test.ts` bullets, §15 items 5 and 7, R3. Implements **MUST-4.7 … MUST-4.18, MUST-2.1's purity rule for `contours.ts`**.

This is where the fiddliest arithmetic lives, and R3 is the reason for the tensor pin: getting the channel order or the mean and std wrong produces boxes that are subtly wrong rather than absent, which is the hardest class of bug to notice.

MUST-4.16's simplification is stated rather than hidden. The reference implementations run a Vatti polygon offset through pyclipper; this one expands the rectangle about its own centre. For a rectangle that is exactly what a Vatti offset produces except at the four corners, where Vatti with `JT_ROUND` rounds and this squares them off, and a squared corner on a text box is strictly more generous.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/contours.ts`
- Create: `src/lib/warranty/ocr/onnx/detect.ts`
- Create: `tests/helpers/ocr-probmaps.ts`
- Create: `tests/lib/warranty/ocr/onnx/contours.test.ts`
- Create: `tests/lib/warranty/ocr/onnx/detect.test.ts`

**Interfaces:**
- Consumes: every `DET_*` constant from `constants.ts` (Task 2); `RawImage` from `preprocess.ts` and `TensorRun` from `session.ts` (Task 3).
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/contours.ts: PURE
  export interface Point { x: number; y: number }
  export type Quad = readonly [Point, Point, Point, Point];
  export interface RotatedRect { cx: number; cy: number; width: number; height: number; angleDeg: number }
  export interface DetectedBox { quad: Quad; rect: RotatedRect; score: number }

  export function binarize(probMap: Float32Array, threshold: number): Uint8Array;
  export function dilate(bitmap: Uint8Array, width: number, height: number, kernel: number): Uint8Array;
  export function labelComponents(
    bitmap: Uint8Array,
    width: number,
    height: number,
    maxCandidates: number,
  ): { components: Point[][]; truncated: boolean };
  export function convexHull(points: Point[]): Point[];
  export function minAreaRect(hull: Point[]): RotatedRect;
  export function rectCorners(rect: RotatedRect): Quad;
  export function boxScoreFast(probMap: Float32Array, width: number, height: number, quad: Quad): number;
  export function unclipRect(rect: RotatedRect, ratio: number): RotatedRect;
  /** The whole §4.4 pipeline over one probability map, in map coordinates. */
  export function boxesFromProbMap(probMap: Float32Array, width: number, height: number): DetectedBox[];

  // src/lib/warranty/ocr/onnx/detect.ts
  export interface DetResize { resizeW: number; resizeH: number; scaleX: number; scaleY: number }
  export function detResize(width: number, height: number): DetResize;
  export function buildDetTensor(image: RawImage, resized: RawImage): Float32Array;
  export function scaleQuad(quad: Quad, scaleX: number, scaleY: number, width: number, height: number): Quad;
  export async function detectBoxes(image: RawImage, runDet: TensorRun): Promise<DetectedBox[]>;
  ```
  Task 5's `crop.ts` consumes `DetectedBox`, `Quad` and `RotatedRect`; Task 6's `assemble.ts` consumes `Quad`; Task 7's `engine.ts` calls `detectBoxes`.

  `buildDetTensor` takes the already-resized `RawImage` so the resize itself stays in `detectBoxes` (which owns the sharp call) and the tensor packing stays pure enough to pin with a 4 by 4 fixture. `detectBoxes` resizes with sharp, which is why `detect.ts` is not on MUST-2.1's pure list.

### Steps

- [ ] **Step 1: Write the probability-map helper.**

  Create `tests/helpers/ocr-probmaps.ts`:

  ```ts
  export interface ProbMap {
    data: Float32Array;
    width: number;
    height: number;
  }

  function blank(width: number, height: number): ProbMap {
    return { data: new Float32Array(width * height), width, height };
  }

  function fillRect(map: ProbMap, x0: number, y0: number, x1: number, y1: number, value: number): void {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) map.data[y * map.width + x] = value;
    }
  }

  /** Two clean, well-separated blobs. */
  export function twoBoxMap(): ProbMap {
    const map = blank(40, 20);
    fillRect(map, 2, 3, 15, 8, 0.9);
    fillRect(map, 22, 11, 37, 16, 0.85);
    return map;
  }

  /** One blob split by a single background column, which the 2 by 2 dilation must close. */
  export function oneGapMap(): ProbMap {
    const map = blank(40, 20);
    fillRect(map, 2, 4, 18, 9, 0.9);
    fillRect(map, 20, 4, 36, 9, 0.9);
    return map;
  }

  /** 1,200 isolated single-pixel components on a 100 by 100 grid, 3 pixels apart so no
   *  dilation kernel can merge them. */
  export function noiseMap(): ProbMap {
    const map = blank(100, 100);
    let placed = 0;
    for (let y = 0; y < 100 && placed < 1200; y += 3) {
      for (let x = 0; x < 100 && placed < 1200; x += 3) {
        map.data[y * 100 + x] = 0.95;
        placed += 1;
      }
    }
    if (placed !== 1200) throw new Error(`noiseMap placed ${placed} components, expected 1200`);
    return map;
  }
  ```

- [ ] **Step 2: Write the failing tests.**

  Create `tests/lib/warranty/ocr/onnx/contours.test.ts`. This is the largest suite in the release and the one that catches real bugs.

  ```ts
  import { describe, it, expect } from 'vitest';
  import {
    DET_BINARY_THRESH,
    DET_DILATION_KERNEL,
    DET_MAX_CANDIDATES,
    DET_UNCLIP_RATIO,
  } from '@/lib/warranty/ocr/onnx/constants';
  import {
    binarize,
    boxScoreFast,
    boxesFromProbMap,
    convexHull,
    dilate,
    labelComponents,
    minAreaRect,
    rectCorners,
    unclipRect,
    type Point,
  } from '@/lib/warranty/ocr/onnx/contours';
  import { noiseMap, oneGapMap, twoBoxMap } from '../../../../helpers/ocr-probmaps';

  describe('binarize (MUST-4.10)', () => {
    it('keeps values strictly above the threshold and drops the rest', () => {
      const map = new Float32Array([0.29, 0.3, 0.31, 0.0, 1.0]);
      expect([...binarize(map, DET_BINARY_THRESH)]).toEqual([0, 0, 1, 0, 1]);
    });
  });

  describe('dilate (MUST-4.11)', () => {
    it('closes the one-pixel gap into a single component', () => {
      const gap = oneGapMap();
      const raw = labelComponents(binarize(gap.data, DET_BINARY_THRESH), gap.width, gap.height, DET_MAX_CANDIDATES);
      expect(raw.components).toHaveLength(2);
      const closed = dilate(
        binarize(gap.data, DET_BINARY_THRESH),
        gap.width,
        gap.height,
        DET_DILATION_KERNEL,
      );
      expect(labelComponents(closed, gap.width, gap.height, DET_MAX_CANDIDATES).components).toHaveLength(1);
    });

    it('leaves two well-separated blobs as two', () => {
      const clean = twoBoxMap();
      const closed = dilate(
        binarize(clean.data, DET_BINARY_THRESH),
        clean.width,
        clean.height,
        DET_DILATION_KERNEL,
      );
      expect(labelComponents(closed, clean.width, clean.height, DET_MAX_CANDIDATES).components).toHaveLength(2);
    });
  });

  describe('labelComponents (MUST-4.12)', () => {
    it('labels an 8-connected diagonal as one component', () => {
      const bitmap = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      expect(labelComponents(bitmap, 3, 3, DET_MAX_CANDIDATES).components).toHaveLength(1);
    });

    it('labels a 4-connected line as one component', () => {
      const bitmap = new Uint8Array([1, 1, 1, 0, 0, 0, 0, 0, 0]);
      expect(labelComponents(bitmap, 3, 3, DET_MAX_CANDIDATES).components).toHaveLength(1);
    });

    it('stops at exactly DET_MAX_CANDIDATES on the noise fixture', () => {
      const noise = noiseMap();
      const result = labelComponents(
        binarize(noise.data, DET_BINARY_THRESH),
        noise.width,
        noise.height,
        DET_MAX_CANDIDATES,
      );
      expect(result.components).toHaveLength(DET_MAX_CANDIDATES);
      expect(result.truncated).toBe(true);
    });
  });

  describe('minAreaRect (MUST-4.13)', () => {
    it('recovers a 45 degree square as that square', () => {
      const points: Point[] = [
        { x: 10, y: 0 },
        { x: 20, y: 10 },
        { x: 10, y: 20 },
        { x: 0, y: 10 },
      ];
      const rect = minAreaRect(convexHull(points));
      expect(rect.cx).toBeCloseTo(10, 5);
      expect(rect.cy).toBeCloseTo(10, 5);
      const side = Math.sqrt(200);
      expect(Math.min(rect.width, rect.height)).toBeCloseTo(side, 3);
      expect(Math.max(rect.width, rect.height)).toBeCloseTo(side, 3);
      const normalised = ((rect.angleDeg % 90) + 90) % 90;
      expect(Math.min(Math.abs(normalised - 45), Math.abs(normalised - 45))).toBeLessThan(0.5);
    });

    it('recovers an axis-aligned rectangle exactly', () => {
      const rect = minAreaRect(
        convexHull([
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 20 },
          { x: 0, y: 20 },
        ]),
      );
      expect(Math.max(rect.width, rect.height)).toBeCloseTo(100, 5);
      expect(Math.min(rect.width, rect.height)).toBeCloseTo(20, 5);
    });
  });

  describe('boxScoreFast (MUST-4.15)', () => {
    it('equals the hand-computed mean over the axis-aligned bounding box', () => {
      const width = 4;
      const height = 2;
      const map = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      const quad = rectCorners({ cx: 1.5, cy: 0.5, width: 2, height: 2, angleDeg: 0 });
      // Corners land on x in 0.5..2.5 and y in -0.5..1.5, which clips to columns 0..2 and
      // both rows: (0.1 + 0.2 + 0.3 + 0.5 + 0.6 + 0.7) / 6.
      expect(boxScoreFast(map, width, height, quad)).toBeCloseTo(2.4 / 6, 6);
    });

    it('clips the bounding box into the map bounds', () => {
      const map = new Float32Array([1, 1, 1, 1]);
      const quad = rectCorners({ cx: 0, cy: 0, width: 100, height: 100, angleDeg: 0 });
      expect(boxScoreFast(map, 2, 2, quad)).toBeCloseTo(1, 6);
    });
  });

  describe('unclipRect (MUST-4.16)', () => {
    it('expands a 100 by 20 rectangle by exactly 2 * (2000 * 1.6 / 240) in each dimension', () => {
      const area = 100 * 20;
      const perimeter = 2 * (100 + 20);
      const distance = (area * DET_UNCLIP_RATIO) / perimeter;
      // 2000 * 1.6 = 3200; 3200 / 240 = 13.3333…; twice that is 26.6666…
      expect(distance).toBeCloseTo(3200 / 240, 10);
      const grown = unclipRect({ cx: 50, cy: 10, width: 100, height: 20, angleDeg: 0 }, DET_UNCLIP_RATIO);
      expect(grown.width).toBeCloseTo(100 + 2 * (3200 / 240), 10);
      expect(grown.height).toBeCloseTo(20 + 2 * (3200 / 240), 10);
      expect(grown.cx).toBe(50);
      expect(grown.cy).toBe(10);
      expect(grown.angleDeg).toBe(0);
    });
  });

  describe('boxesFromProbMap (MUST-4.14, MUST-4.15, MUST-4.18)', () => {
    it('finds both boxes on the clean fixture', () => {
      const clean = twoBoxMap();
      expect(boxesFromProbMap(clean.data, clean.width, clean.height)).toHaveLength(2);
    });

    it('drops a component two pixels tall by DET_MIN_BOX_SIDE_PX', () => {
      const width = 40;
      const height = 20;
      const map = new Float32Array(width * height);
      for (let y = 5; y <= 6; y += 1) for (let x = 4; x <= 30; x += 1) map[y * width + x] = 0.9;
      expect(boxesFromProbMap(map, width, height)).toHaveLength(0);
    });

    it('keeps a box scoring 0.51 and drops one scoring 0.49', () => {
      const width = 30;
      const height = 12;
      const strong = new Float32Array(width * height);
      const weak = new Float32Array(width * height);
      for (let y = 2; y <= 9; y += 1) {
        for (let x = 3; x <= 26; x += 1) {
          strong[y * width + x] = 0.51;
          weak[y * width + x] = 0.49;
        }
      }
      expect(boxesFromProbMap(strong, width, height)).toHaveLength(1);
      expect(boxesFromProbMap(weak, width, height)).toHaveLength(0);
    });

    it('caps at DET_MAX_BOXES, keeping the highest-scoring ones', () => {
      const noise = noiseMap();
      const boxes = boxesFromProbMap(noise.data, noise.width, noise.height);
      expect(boxes.length).toBeLessThanOrEqual(200);
    });
  });
  ```

  Create `tests/lib/warranty/ocr/onnx/detect.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import {
    DET_LIMIT_SIDE_LEN,
    DET_MEAN,
    DET_SCALE,
    DET_SIZE_MULTIPLE,
    DET_STD,
  } from '@/lib/warranty/ocr/onnx/constants';
  import { buildDetTensor, detResize, detectBoxes, scaleQuad } from '@/lib/warranty/ocr/onnx/detect';
  import type { Quad } from '@/lib/warranty/ocr/onnx/contours';
  import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';

  /** 4 by 4 RGB with known values: pixel n has r = n, g = n + 1, b = n + 2. */
  function tensor4x4(): RawImage {
    const data = Buffer.alloc(4 * 4 * 3);
    for (let i = 0; i < 16; i += 1) {
      data[i * 3] = i;
      data[i * 3 + 1] = i + 1;
      data[i * 3 + 2] = i + 2;
    }
    return { data, width: 4, height: 4 };
  }

  describe('detResize (MUST-4.7)', () => {
    it('never upscales under limit_type max', () => {
      const out = detResize(320, 240);
      expect(out.resizeW).toBeLessThanOrEqual(320 + DET_SIZE_MULTIPLE);
      expect(Math.max(out.resizeW, out.resizeH)).toBeLessThanOrEqual(DET_LIMIT_SIDE_LEN);
      expect(out.resizeW).toBe(320);
      expect(out.resizeH).toBe(nearestMultiple(240));
    });

    it('rounds to the NEAREST multiple of 32, not up', () => {
      // 3000 by 4000 with ratio 960 / 4000 = 0.24 gives 720 by 960. 720 is already a
      // multiple of 32 * 22.5, so use a case that discriminates: 1000 by 1500.
      const out = detResize(1000, 1500);
      const ratio = DET_LIMIT_SIDE_LEN / 1500;
      expect(out.resizeW).toBe(Math.max(Math.round((1000 * ratio) / DET_SIZE_MULTIPLE) * DET_SIZE_MULTIPLE, DET_SIZE_MULTIPLE));
      expect(out.resizeH).toBe(Math.max(Math.round((1500 * ratio) / DET_SIZE_MULTIPLE) * DET_SIZE_MULTIPLE, DET_SIZE_MULTIPLE));
      // Ceiling would give 672 for the width; rounding gives 640.
      expect(out.resizeW).toBe(640);
    });

    it('never returns a dimension below one multiple', () => {
      const out = detResize(10, 8);
      expect(out.resizeW).toBeGreaterThanOrEqual(DET_SIZE_MULTIPLE);
      expect(out.resizeH).toBeGreaterThanOrEqual(DET_SIZE_MULTIPLE);
    });

    it('round-trips a corner back to within a pixel', () => {
      const out = detResize(1000, 1500);
      const quad: Quad = [
        { x: 0, y: 0 },
        { x: out.resizeW, y: 0 },
        { x: out.resizeW, y: out.resizeH },
        { x: 0, y: out.resizeH },
      ];
      const scaled = scaleQuad(quad, out.scaleX, out.scaleY, 1000, 1500);
      expect(Math.abs(scaled[2].x - 1000)).toBeLessThanOrEqual(1);
      expect(Math.abs(scaled[2].y - 1500)).toBeLessThanOrEqual(1);
    });
  });

  function nearestMultiple(value: number): number {
    return Math.max(Math.round(value / DET_SIZE_MULTIPLE) * DET_SIZE_MULTIPLE, DET_SIZE_MULTIPLE);
  }

  describe('buildDetTensor (MUST-4.8, risk R3)', () => {
    it('pins the first sixteen floats for the 4 by 4 fixture', () => {
      const image = tensor4x4();
      const tensor = buildDetTensor(image, image);
      // NCHW: the first 16 values are the whole red plane, pixels 0..15.
      const expected = Array.from({ length: 16 }, (_, i) => (i * DET_SCALE - DET_MEAN[0]) / DET_STD[0]);
      for (let i = 0; i < 16; i += 1) expect(tensor[i]).toBeCloseTo(expected[i], 6);
    });

    it('packs RGB in that order, not BGR', () => {
      const image = tensor4x4();
      const tensor = buildDetTensor(image, image);
      const plane = 16;
      expect(tensor[plane]).toBeCloseTo((1 * DET_SCALE - DET_MEAN[1]) / DET_STD[1], 6);
      expect(tensor[plane * 2]).toBeCloseTo((2 * DET_SCALE - DET_MEAN[2]) / DET_STD[2], 6);
    });

    it('is 1 * 3 * h * w long', () => {
      const image = tensor4x4();
      expect(buildDetTensor(image, image)).toHaveLength(3 * 16);
    });
  });

  describe('detectBoxes (MUST-4.9)', () => {
    const image: RawImage = { data: Buffer.alloc(64 * 64 * 3, 255), width: 64, height: 64 };

    it('throws when the returned spatial dimensions do not match the input', async () => {
      await expect(
        detectBoxes(image, async () => ({ data: new Float32Array(4), dims: [1, 1, 2, 2] })),
      ).rejects.toThrow(/spatial/i);
    });

    it('returns boxes in preprocessed-image coordinates', async () => {
      const resized = detResize(64, 64);
      const map = new Float32Array(resized.resizeW * resized.resizeH);
      for (let y = 8; y < 24; y += 1) {
        for (let x = 8; x < 40; x += 1) map[y * resized.resizeW + x] = 0.9;
      }
      const boxes = await detectBoxes(image, async () => ({
        data: map,
        dims: [1, 1, resized.resizeH, resized.resizeW],
      }));
      expect(boxes).toHaveLength(1);
      for (const point of boxes[0].quad) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(image.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(image.height);
      }
    });
  });
  ```

- [ ] **Step 3: Run to verify they fail.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/contours.test.ts tests/lib/warranty/ocr/onnx/detect.test.ts
  ```
  Expected: unresolved imports for both new modules.

- [ ] **Step 4: Write `src/lib/warranty/ocr/onnx/contours.ts`.**

  ```ts
  import {
    DET_BINARY_THRESH,
    DET_BOX_THRESH,
    DET_DILATION_KERNEL,
    DET_MAX_BOXES,
    DET_MAX_CANDIDATES,
    DET_MIN_BOX_SIDE_PX,
    DET_UNCLIP_RATIO,
    DET_USE_DILATION,
  } from '@/lib/warranty/ocr/onnx/constants';

  /**
   * PURE. Takes a probability map and two integers, returns boxes. No node builtin, no sharp,
   * no onnxruntime, no database. That is what makes the whole DBNet post-process testable
   * without a model file, and it is where the bugs in this release would otherwise hide.
   */

  export interface Point {
    x: number;
    y: number;
  }
  export type Quad = readonly [Point, Point, Point, Point];
  export interface RotatedRect {
    cx: number;
    cy: number;
    width: number;
    height: number;
    angleDeg: number;
  }
  export interface DetectedBox {
    quad: Quad;
    rect: RotatedRect;
    score: number;
  }

  export function binarize(probMap: Float32Array, threshold: number): Uint8Array {
    const out = new Uint8Array(probMap.length);
    for (let i = 0; i < probMap.length; i += 1) out[i] = probMap[i] > threshold ? 1 : 0;
    return out;
  }

  /** A square of ones. Closes the one-pixel gaps that split a word into two components on
   *  faint thermal print. */
  export function dilate(bitmap: Uint8Array, width: number, height: number, kernel: number): Uint8Array {
    const out = new Uint8Array(bitmap.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (bitmap[y * width + x] === 0) continue;
        for (let dy = 0; dy < kernel; dy += 1) {
          const ny = y + dy;
          if (ny >= height) break;
          for (let dx = 0; dx < kernel; dx += 1) {
            const nx = x + dx;
            if (nx >= width) break;
            out[ny * width + nx] = 1;
          }
        }
      }
    }
    return out;
  }

  /** Two-pass union-find, 8-connected. Components come back in label order. */
  export function labelComponents(
    bitmap: Uint8Array,
    width: number,
    height: number,
    maxCandidates: number,
  ): { components: Point[][]; truncated: boolean } {
    const labels = new Int32Array(bitmap.length);
    const parent: number[] = [0];

    function find(a: number): number {
      let root = a;
      while (parent[root] !== root) root = parent[root];
      let walk = a;
      while (parent[walk] !== root) {
        const next = parent[walk];
        parent[walk] = root;
        walk = next;
      }
      return root;
    }

    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }

    let next = 1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (bitmap[index] === 0) continue;
        const neighbours: number[] = [];
        for (const [dx, dy] of [
          [-1, 0],
          [-1, -1],
          [0, -1],
          [1, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width) continue;
          const label = labels[ny * width + nx];
          if (label !== 0) neighbours.push(label);
        }
        if (neighbours.length === 0) {
          labels[index] = next;
          parent[next] = next;
          next += 1;
          continue;
        }
        const smallest = Math.min(...neighbours);
        labels[index] = smallest;
        for (const label of neighbours) union(smallest, label);
      }
    }

    const byRoot = new Map<number, Point[]>();
    const order: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const label = labels[y * width + x];
        if (label === 0) continue;
        const root = find(label);
        let bucket = byRoot.get(root);
        if (bucket === undefined) {
          bucket = [];
          byRoot.set(root, bucket);
          order.push(root);
        }
        bucket.push({ x, y });
      }
    }

    const components = order.slice(0, maxCandidates).map((root) => byRoot.get(root) as Point[]);
    return { components, truncated: order.length > maxCandidates };
  }

  /** Monotone chain. Returns the hull counter-clockwise with no repeated endpoint. */
  export function convexHull(points: Point[]): Point[] {
    if (points.length < 3) return [...points];
    const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Point[] = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper: Point[] = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /** Rotating calipers over the hull. */
  export function minAreaRect(hull: Point[]): RotatedRect {
    if (hull.length === 0) return { cx: 0, cy: 0, width: 0, height: 0, angleDeg: 0 };
    if (hull.length < 3) {
      const xs = hull.map((p) => p.x);
      const ys = hull.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, width: maxX - minX + 1, height: maxY - minY + 1, angleDeg: 0 };
    }
    let best: RotatedRect | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (let i = 0; i < hull.length; i += 1) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
      if (edgeLength === 0) continue;
      const ux = (b.x - a.x) / edgeLength;
      const uy = (b.y - a.y) / edgeLength;
      let minU = Number.POSITIVE_INFINITY;
      let maxU = Number.NEGATIVE_INFINITY;
      let minV = Number.POSITIVE_INFINITY;
      let maxV = Number.NEGATIVE_INFINITY;
      for (const point of hull) {
        const u = point.x * ux + point.y * uy;
        const v = -point.x * uy + point.y * ux;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const width = maxU - minU;
      const height = maxV - minV;
      const area = width * height;
      if (area >= bestArea) continue;
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        width,
        height,
        angleDeg: (Math.atan2(uy, ux) * 180) / Math.PI,
      };
    }
    return best ?? { cx: 0, cy: 0, width: 0, height: 0, angleDeg: 0 };
  }

  export function rectCorners(rect: RotatedRect): Quad {
    const radians = (rect.angleDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    const offsets: [number, number][] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    const points = offsets.map(([ox, oy]) => ({
      x: rect.cx + ox * cos - oy * sin,
      y: rect.cy + ox * sin + oy * cos,
    }));
    return [points[0], points[1], points[2], points[3]] as const;
  }

  /** DET_SCORE_MODE is 'fast': the arithmetic mean over the axis-aligned bounding box of the
   *  four corners, clipped to the map bounds. */
  export function boxScoreFast(probMap: Float32Array, width: number, height: number, quad: Quad): number {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(Math.min(...xs))));
    const x1 = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(...xs))));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(Math.min(...ys))));
    const y1 = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(...ys))));
    let sum = 0;
    let count = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        sum += probMap[y * width + x];
        count += 1;
      }
    }
    return count === 0 ? 0 : sum / count;
  }

  /**
   * DBNet shrinks its training targets, so every surviving rectangle must be grown back.
   * The reference implementations run a Vatti polygon offset through pyclipper; this takes no
   * polygon-clipping dependency and expands the rectangle about its own centre instead. For a
   * rectangle that is exactly what a Vatti offset by the same distance produces, except at
   * the four corners, where Vatti with JT_ROUND rounds and this squares them off. A squared
   * corner on a text box is strictly more generous than a rounded one.
   */
  export function unclipRect(rect: RotatedRect, ratio: number): RotatedRect {
    const area = rect.width * rect.height;
    const perimeter = 2 * (rect.width + rect.height);
    if (perimeter === 0) return rect;
    const distance = (area * ratio) / perimeter;
    return { ...rect, width: rect.width + 2 * distance, height: rect.height + 2 * distance };
  }

  export function boxesFromProbMap(probMap: Float32Array, width: number, height: number): DetectedBox[] {
    const binary = binarize(probMap, DET_BINARY_THRESH);
    const bitmap = DET_USE_DILATION ? dilate(binary, width, height, DET_DILATION_KERNEL) : binary;
    const { components } = labelComponents(bitmap, width, height, DET_MAX_CANDIDATES);
    const boxes: DetectedBox[] = [];
    for (const component of components) {
      const rect = minAreaRect(convexHull(component));
      if (Math.min(rect.width, rect.height) < DET_MIN_BOX_SIDE_PX) continue;
      const score = boxScoreFast(probMap, width, height, rectCorners(rect));
      if (score < DET_BOX_THRESH) continue;
      const grown = unclipRect(rect, DET_UNCLIP_RATIO);
      boxes.push({ quad: rectCorners(grown), rect: grown, score });
    }
    // A noisy photo of a patterned countertop can produce a thousand tiny components, each of
    // which would otherwise cost a recognition pass. A receipt is 30 to 80 lines.
    if (boxes.length <= DET_MAX_BOXES) return boxes;
    return [...boxes].sort((a, b) => b.score - a.score).slice(0, DET_MAX_BOXES);
  }
  ```

- [ ] **Step 5: Write `src/lib/warranty/ocr/onnx/detect.ts`.**

  ```ts
  import sharp from 'sharp';
  import {
    DET_LIMIT_SIDE_LEN,
    DET_MEAN,
    DET_SCALE,
    DET_SIZE_MULTIPLE,
    DET_STD,
  } from '@/lib/warranty/ocr/onnx/constants';
  import { boxesFromProbMap, type DetectedBox, type Point, type Quad } from '@/lib/warranty/ocr/onnx/contours';
  import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';
  import type { TensorRun } from '@/lib/warranty/ocr/onnx/session';

  export interface DetResize {
    resizeW: number;
    resizeH: number;
    scaleX: number;
    scaleY: number;
  }

  /**
   * PaddleOCR's DetResizeForTest with limit_type = 'max'. Round to NEAREST, not ceiling:
   * PaddleOCR rounds, and using ceiling here shifts every box by up to 31 pixels relative to
   * the reference implementation.
   */
  export function detResize(width: number, height: number): DetResize {
    const ratio = Math.min(1, DET_LIMIT_SIDE_LEN / Math.max(width, height));
    const snap = (value: number) =>
      Math.max(Math.round((value * ratio) / DET_SIZE_MULTIPLE) * DET_SIZE_MULTIPLE, DET_SIZE_MULTIPLE);
    const resizeW = snap(width);
    const resizeH = snap(height);
    return { resizeW, resizeH, scaleX: width / resizeW, scaleY: height / resizeH };
  }

  /** float32, NCHW, RGB, value = (pixel * DET_SCALE - mean) / std. The `image` argument is
   *  present so the signature reads the same as the other tensor builders; the bytes come
   *  from `resized`. */
  export function buildDetTensor(image: RawImage, resized: RawImage): Float32Array {
    void image;
    const plane = resized.width * resized.height;
    const tensor = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        tensor[c * plane + i] = (resized.data[i * 3 + c] * DET_SCALE - DET_MEAN[c]) / DET_STD[c];
      }
    }
    return tensor;
  }

  export function scaleQuad(quad: Quad, scaleX: number, scaleY: number, width: number, height: number): Quad {
    const clamp = (point: Point): Point => ({
      x: Math.min(Math.max(point.x * scaleX, 0), width),
      y: Math.min(Math.max(point.y * scaleY, 0), height),
    });
    return [clamp(quad[0]), clamp(quad[1]), clamp(quad[2]), clamp(quad[3])] as const;
  }

  export async function detectBoxes(image: RawImage, runDet: TensorRun): Promise<DetectedBox[]> {
    const geometry = detResize(image.width, image.height);
    const { data } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
      .resize({ width: geometry.resizeW, height: geometry.resizeH, fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const resized: RawImage = { data, width: geometry.resizeW, height: geometry.resizeH };
    const output = await runDet({
      data: buildDetTensor(image, resized),
      dims: [1, 3, geometry.resizeH, geometry.resizeW],
    });
    // Read the shape from the returned tensor rather than assuming it.
    const dims = output.dims;
    const outH = dims[dims.length - 2];
    const outW = dims[dims.length - 1];
    if (outH !== geometry.resizeH || outW !== geometry.resizeW) {
      throw new Error(
        `Detection output spatial dimensions ${outH}x${outW} do not match the input ${geometry.resizeH}x${geometry.resizeW}.`,
      );
    }
    return boxesFromProbMap(output.data, outW, outH).map((box) => ({
      ...box,
      quad: scaleQuad(box.quad, geometry.scaleX, geometry.scaleY, image.width, image.height),
      rect: {
        ...box.rect,
        cx: box.rect.cx * geometry.scaleX,
        cy: box.rect.cy * geometry.scaleY,
        width: box.rect.width * geometry.scaleX,
        height: box.rect.height * geometry.scaleY,
      },
    }));
  }
  ```

- [ ] **Step 6: Run until green.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/contours.test.ts tests/lib/warranty/ocr/onnx/detect.test.ts
  npx vitest run tests/ops/constants.test.ts -t 'contours.ts imports nothing forbidden'
  npx tsc --noEmit
  ```
  Expected: all green, and `contours.ts`'s purity row now passes.

- [ ] **Step 7: Commit.**

  ```powershell
  git add src/lib/warranty/ocr/onnx/contours.ts src/lib/warranty/ocr/onnx/detect.ts tests/helpers/ocr-probmaps.ts tests/lib/warranty/ocr/onnx/contours.test.ts tests/lib/warranty/ocr/onnx/detect.test.ts
  git commit -m "feat(ocr): DBNet detection and its post-process

contours.ts is pure arithmetic over a probability map: binarize, dilate, label
8-connected components with union-find, convex hull, rotating calipers, score,
expand. Every one of those has a test with the answer worked out longhand,
because a subtly wrong box produces subtly wrong text and nothing fails.

The unclip is a rectangle expansion rather than a Vatti offset, which avoids a
polygon-clipping dependency. For a rectangle the two agree everywhere except
the corners, where Vatti rounds and this squares, and a squared corner on a
text box is more generous. The comment at the function says so, so a reader
diffing against RapidOCR's Python finds an answer instead of a discrepancy.

detect.ts rounds the resize to the nearest multiple of 32 rather than up,
because PaddleOCR rounds and a ceiling shifts every box by up to 31 pixels. The
tensor's first sixteen floats are pinned against a fixture with known pixel
values, which is the only cheap way to catch a swapped channel order."
  ```

---

## Task 5: `onnx/crop.ts` and `onnx/classify.ts`: crop, rotate and the orientation model

**Context:** Spec §4.5, §4.6, §15 item 3, §17.3. Implements **MUST-4.19 … MUST-4.25**.

MUST-4.25 is a decision taken against the research doc's advice and it is worth restating: the classifier ships. The research doc suggested skipping it on the grounds that the browser scanner would normalise orientation, but the scanner finds the paper's outline, which does not tell it which end is the top. A receipt photographed upside down is a real household case and costs under a megabyte to handle.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/crop.ts`
- Create: `src/lib/warranty/ocr/onnx/classify.ts`
- Create: `tests/lib/warranty/ocr/onnx/crop.test.ts`
- Create: `tests/lib/warranty/ocr/onnx/classify.test.ts`

**Interfaces:**
- Consumes: `CLS_*`, `CROP_MIN_ROTATE_DEG`, `CROP_ANGLE_LIMIT_DEG`, `PIXEL_SCALE`, `CLS_FLIP_DEGREES` from `constants.ts`; `DetectedBox`, `Quad`, `RotatedRect` from `contours.ts`; `RawImage` from `preprocess.ts`; `OnnxOcrSessions` from `session.ts`.
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/crop.ts
  export interface Crop extends RawImage {
    /** Index into the DetectedBox[] this crop came from. Carried through every later stage. */
    boxIndex: number;
  }
  /** Normalises the rectangle's angle into -45..45 by swapping width and height when the
   *  rectangle is taller than it is wide. */
  export function normaliseCropAngle(rect: RotatedRect): { angleDeg: number; width: number; height: number };
  export async function cropBoxes(image: RawImage, boxes: readonly DetectedBox[]): Promise<Crop[]>;

  // src/lib/warranty/ocr/onnx/classify.ts
  export function buildClsTensor(crops: readonly Crop[], height: number, width: number): Float32Array;
  export async function resizeCropForCls(crop: Crop, height: number, width: number): Promise<Crop>;
  /** Returns the crops with the upside-down ones flipped. Never throws: a classifier failure
   *  logs one line and returns the input unchanged. */
  export async function classifyAndFlip(crops: readonly Crop[], sessions: OnnxOcrSessions): Promise<Crop[]>;
  ```
  Task 6's `recognize.ts` consumes `Crop`; Task 7's `engine.ts` calls `cropBoxes` then `classifyAndFlip`.

### Steps

- [ ] **Step 1: Write the failing tests.**

  Create `tests/lib/warranty/ocr/onnx/crop.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { CROP_ANGLE_LIMIT_DEG } from '@/lib/warranty/ocr/onnx/constants';
  import type { DetectedBox } from '@/lib/warranty/ocr/onnx/contours';
  import { rectCorners } from '@/lib/warranty/ocr/onnx/contours';
  import { cropBoxes, normaliseCropAngle } from '@/lib/warranty/ocr/onnx/crop';
  import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';
  import { solidRgb } from '../../../../helpers/ocr-images';

  function box(cx: number, cy: number, width: number, height: number, angleDeg: number): DetectedBox {
    const rect = { cx, cy, width, height, angleDeg };
    return { rect, quad: rectCorners(rect), score: 0.9 };
  }

  const page: RawImage = { data: solidRgb(200, 120, [255, 255, 255]), width: 200, height: 120 };

  describe('normaliseCropAngle (MUST-4.19)', () => {
    it('leaves a wide rectangle alone', () => {
      expect(normaliseCropAngle({ cx: 0, cy: 0, width: 100, height: 20, angleDeg: 3 })).toEqual({
        angleDeg: 3,
        width: 100,
        height: 20,
      });
    });

    it('swaps width and height when the rectangle is taller than it is wide', () => {
      const out = normaliseCropAngle({ cx: 0, cy: 0, width: 20, height: 100, angleDeg: 80 });
      expect(out.width).toBe(100);
      expect(out.height).toBe(20);
      expect(Math.abs(out.angleDeg)).toBeLessThanOrEqual(CROP_ANGLE_LIMIT_DEG);
    });

    it('always returns an angle inside the limit', () => {
      for (const angleDeg of [-179, -91, -46, 46, 91, 179]) {
        const out = normaliseCropAngle({ cx: 0, cy: 0, width: 60, height: 12, angleDeg });
        expect(Math.abs(out.angleDeg)).toBeLessThanOrEqual(CROP_ANGLE_LIMIT_DEG);
      }
    });
  });

  describe('cropBoxes (MUST-4.20, MUST-4.21)', () => {
    it('carries the original box index on every crop', async () => {
      const crops = await cropBoxes(page, [box(50, 30, 60, 16, 0), box(120, 80, 70, 18, 0)]);
      expect(crops.map((crop) => crop.boxIndex)).toEqual([0, 1]);
    });

    it('skips the rotate entirely below CROP_MIN_ROTATE_DEG', async () => {
      const level = await cropBoxes(page, [box(50, 30, 60, 16, 0.2)]);
      const plain = await cropBoxes(page, [box(50, 30, 60, 16, 0)]);
      expect(level[0].width).toBe(plain[0].width);
      expect(level[0].height).toBe(plain[0].height);
    });

    it('rotates above the threshold, which changes the extracted size', async () => {
      const tilted = await cropBoxes(page, [box(100, 60, 60, 16, 10)]);
      expect(tilted).toHaveLength(1);
      expect(tilted[0].data.length).toBe(tilted[0].width * tilted[0].height * 3);
    });

    it('drops a zero-width box rather than passing it on, because a zero-width tensor is an ORT crash', async () => {
      const crops = await cropBoxes(page, [box(0, 0, 0, 0, 0), box(50, 30, 60, 16, 0)]);
      expect(crops).toHaveLength(1);
      expect(crops[0].boxIndex).toBe(1);
    });

    it('drops a box that clamps to nothing at the image edge', async () => {
      const crops = await cropBoxes(page, [box(-500, -500, 40, 12, 0)]);
      expect(crops).toHaveLength(0);
    });
  });
  ```

  Create `tests/lib/warranty/ocr/onnx/classify.test.ts`:

  ```ts
  import { describe, it, expect, vi, afterEach } from 'vitest';
  import { CLS_BATCH_SIZE, CLS_MEAN, CLS_STD, CLS_THRESH, PIXEL_SCALE } from '@/lib/warranty/ocr/onnx/constants';
  import { buildClsTensor, classifyAndFlip } from '@/lib/warranty/ocr/onnx/classify';
  import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
  import type { OnnxOcrSessions, OnnxTensorData } from '@/lib/warranty/ocr/onnx/session';
  import { solidRgb } from '../../../../helpers/ocr-images';

  afterEach(() => vi.restoreAllMocks());

  function crop(boxIndex: number, value = 128): Crop {
    return { data: solidRgb(20, 10, [value, value, value]), width: 20, height: 10, boxIndex };
  }

  function sessions(runCls: (input: OnnxTensorData) => Promise<OnnxTensorData>): OnnxOcrSessions {
    return {
      runDet: async () => ({ data: new Float32Array(1), dims: [1, 1, 1, 1] }),
      runCls,
      runRec: async () => ({ data: new Float32Array(1), dims: [1, 1, 1] }),
      clsInputHeight: 80,
      clsInputWidth: 160,
      recClassCount: 3,
      dictionary: ['', 'a', ' '],
    };
  }

  describe('buildClsTensor (MUST-4.23)', () => {
    it('normalises with the pinned mean and std, RGB, NCHW', () => {
      const tensor = buildClsTensor([crop(0, 255)], 2, 2);
      const expected = (255 * PIXEL_SCALE - CLS_MEAN) / CLS_STD;
      expect(tensor).toHaveLength(1 * 3 * 2 * 2);
      for (const value of tensor) expect(value).toBeCloseTo(expected, 6);
    });

    it('is batchSize * 3 * h * w long', () => {
      expect(buildClsTensor([crop(0), crop(1), crop(2)], 4, 8)).toHaveLength(3 * 3 * 4 * 8);
    });
  });

  describe('classifyAndFlip (MUST-4.24)', () => {
    it('flips a crop whose class-1 probability is at the threshold', async () => {
      const out = await classifyAndFlip(
        [crop(0)],
        sessions(async () => ({ data: new Float32Array([1 - CLS_THRESH, CLS_THRESH]), dims: [1, 2] })),
      );
      expect(out).toHaveLength(1);
      expect(out[0].boxIndex).toBe(0);
    });

    it('leaves a crop below the threshold byte-identical', async () => {
      const input = crop(0);
      const out = await classifyAndFlip(
        [input],
        sessions(async () => ({ data: new Float32Array([0.9, 0.1]), dims: [1, 2] })),
      );
      expect(out[0].data).toBe(input.data);
    });

    it('batches CLS_BATCH_SIZE crops at a time', async () => {
      const batches: number[] = [];
      const crops = Array.from({ length: CLS_BATCH_SIZE * 2 + 1 }, (_, i) => crop(i));
      await classifyAndFlip(
        crops,
        sessions(async (input) => {
          const size = input.dims[0];
          batches.push(size);
          return { data: new Float32Array(size * 2).fill(0.1), dims: [size, 2] };
        }),
      );
      expect(batches).toEqual([CLS_BATCH_SIZE, CLS_BATCH_SIZE, 1]);
    });

    it('MUST-4.3 exception: a classifier failure logs one line and returns the crops unflipped', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const input = [crop(0), crop(1)];
      const out = await classifyAndFlip(
        input,
        sessions(async () => {
          throw new Error('kernel exploded');
        }),
      );
      expect(out).toEqual(input);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('an unexpected class count fails the batch rather than guessing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const input = [crop(0)];
      const out = await classifyAndFlip(
        input,
        sessions(async () => ({ data: new Float32Array([0.2, 0.3, 0.5]), dims: [1, 3] })),
      );
      expect(out).toEqual(input);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
  ```

- [ ] **Step 2: Run to verify they fail.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/crop.test.ts tests/lib/warranty/ocr/onnx/classify.test.ts
  ```
  Expected: unresolved imports.

- [ ] **Step 3: Write `src/lib/warranty/ocr/onnx/crop.ts`.**

  ```ts
  import sharp from 'sharp';
  import { CROP_ANGLE_LIMIT_DEG, CROP_MIN_ROTATE_DEG } from '@/lib/warranty/ocr/onnx/constants';
  import type { DetectedBox, RotatedRect } from '@/lib/warranty/ocr/onnx/contours';
  import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';

  export interface Crop extends RawImage {
    boxIndex: number;
  }

  /** A text line is wider than it is tall, but a min-area rectangle can report the same shape
   *  either way round, so an angle outside the limit means the two axes are swapped. */
  export function normaliseCropAngle(rect: RotatedRect): { angleDeg: number; width: number; height: number } {
    let angleDeg = rect.angleDeg;
    let width = rect.width;
    let height = rect.height;
    while (angleDeg > CROP_ANGLE_LIMIT_DEG) {
      angleDeg -= 2 * CROP_ANGLE_LIMIT_DEG;
      [width, height] = [height, width];
    }
    while (angleDeg < -CROP_ANGLE_LIMIT_DEG) {
      angleDeg += 2 * CROP_ANGLE_LIMIT_DEG;
      [width, height] = [height, width];
    }
    if (height > width) {
      [width, height] = [height, width];
      angleDeg = angleDeg > 0 ? angleDeg - CROP_ANGLE_LIMIT_DEG * 2 : angleDeg + CROP_ANGLE_LIMIT_DEG * 2;
      if (angleDeg > CROP_ANGLE_LIMIT_DEG) angleDeg -= 2 * CROP_ANGLE_LIMIT_DEG;
      if (angleDeg < -CROP_ANGLE_LIMIT_DEG) angleDeg += 2 * CROP_ANGLE_LIMIT_DEG;
    }
    return { angleDeg, width, height };
  }

  function extractWindow(
    imageWidth: number,
    imageHeight: number,
    cx: number,
    cy: number,
    width: number,
    height: number,
  ): { left: number; top: number; width: number; height: number } | null {
    const left = Math.round(cx - width / 2);
    const top = Math.round(cy - height / 2);
    const clampedLeft = Math.max(0, Math.min(imageWidth - 1, left));
    const clampedTop = Math.max(0, Math.min(imageHeight - 1, top));
    const clampedWidth = Math.min(Math.round(width), imageWidth - clampedLeft);
    const clampedHeight = Math.min(Math.round(height), imageHeight - clampedTop);
    // A crop whose width or height comes out as zero after clamping is dropped, not passed
    // on: a zero-width tensor is an ORT crash, not an exception.
    if (clampedWidth <= 0 || clampedHeight <= 0) return null;
    return { left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight };
  }

  export async function cropBoxes(image: RawImage, boxes: readonly DetectedBox[]): Promise<Crop[]> {
    const raw = { width: image.width, height: image.height, channels: 3 as const };
    const crops: Crop[] = [];
    for (let boxIndex = 0; boxIndex < boxes.length; boxIndex += 1) {
      const { angleDeg, width, height } = normaliseCropAngle(boxes[boxIndex].rect);
      if (width <= 0 || height <= 0) continue;
      const rotate = Math.abs(angleDeg) >= CROP_MIN_ROTATE_DEG;
      // Most boxes after the deskew stage are within a fraction of a degree of level, and
      // skipping a no-op resample on 60 crops is the cheapest performance decision here.
      const source = rotate
        ? await sharp(image.data, { raw }).rotate(-angleDeg, { background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true })
        : { data: image.data, info: { width: image.width, height: image.height } };
      const window = extractWindow(
        source.info.width,
        source.info.height,
        boxes[boxIndex].rect.cx + (source.info.width - image.width) / 2,
        boxes[boxIndex].rect.cy + (source.info.height - image.height) / 2,
        width,
        height,
      );
      if (window === null) continue;
      const { data, info } = await sharp(source.data, {
        raw: { width: source.info.width, height: source.info.height, channels: 3 },
      })
        .extract(window)
        .raw()
        .toBuffer({ resolveWithObject: true });
      crops.push({ data, width: info.width, height: info.height, boxIndex });
    }
    return crops;
  }
  ```

- [ ] **Step 4: Write `src/lib/warranty/ocr/onnx/classify.ts`.**

  ```ts
  import sharp from 'sharp';
  import {
    CLS_BATCH_SIZE,
    CLS_FLIP_DEGREES,
    CLS_MEAN,
    CLS_PAD_VALUE,
    CLS_STD,
    CLS_THRESH,
    PIXEL_SCALE,
  } from '@/lib/warranty/ocr/onnx/constants';
  import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
  import type { OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';

  /** Aspect preserved, right-padded with CLS_PAD_VALUE in normalised space. */
  export async function resizeCropForCls(crop: Crop, height: number, width: number): Promise<Crop> {
    const scaled = Math.max(1, Math.min(width, Math.round((crop.width / crop.height) * height)));
    const { data } = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } })
      .resize({ width: scaled, height, fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: scaled, height, boxIndex: crop.boxIndex };
  }

  export function buildClsTensor(crops: readonly Crop[], height: number, width: number): Float32Array {
    const plane = height * width;
    const tensor = new Float32Array(crops.length * 3 * plane).fill(CLS_PAD_VALUE);
    for (let n = 0; n < crops.length; n += 1) {
      const crop = crops[n];
      const base = n * 3 * plane;
      for (let y = 0; y < Math.min(height, crop.height); y += 1) {
        for (let x = 0; x < Math.min(width, crop.width); x += 1) {
          const source = (y * crop.width + x) * 3;
          for (let c = 0; c < 3; c += 1) {
            tensor[base + c * plane + y * width + x] = (crop.data[source + c] * PIXEL_SCALE - CLS_MEAN) / CLS_STD;
          }
        }
      }
    }
    return tensor;
  }

  async function flip(crop: Crop): Promise<Crop> {
    const { data, info } = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } })
      .rotate(CLS_FLIP_DEGREES)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, boxIndex: crop.boxIndex };
  }

  /**
   * MUST-4.3's one exception to "no stage swallows an error": a wrong-way-up guess is worse
   * than no guess, but a crashed classifier should not cost the whole receipt.
   */
  export async function classifyAndFlip(crops: readonly Crop[], sessions: OnnxOcrSessions): Promise<Crop[]> {
    if (crops.length === 0) return [];
    try {
      const out: Crop[] = [];
      for (let start = 0; start < crops.length; start += CLS_BATCH_SIZE) {
        const batch = crops.slice(start, start + CLS_BATCH_SIZE);
        const resized = await Promise.all(
          batch.map((crop) => resizeCropForCls(crop, sessions.clsInputHeight, sessions.clsInputWidth)),
        );
        const output = await sessions.runCls({
          data: buildClsTensor(resized, sessions.clsInputHeight, sessions.clsInputWidth),
          dims: [batch.length, 3, sessions.clsInputHeight, sessions.clsInputWidth],
        });
        const classes = output.dims[output.dims.length - 1];
        if (classes !== 2) throw new Error(`orientation output has ${classes} classes, expected 2`);
        for (let i = 0; i < batch.length; i += 1) {
          // Class index 1 means CLS_FLIP_DEGREES.
          out.push(output.data[i * 2 + 1] >= CLS_THRESH ? await flip(batch[i]) : batch[i]);
        }
      }
      return out;
    } catch (error) {
      console.warn('[ocr] orientation classifier failed, continuing with unflipped crops', error);
      return [...crops];
    }
  }
  ```

- [ ] **Step 5: Run until green.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/crop.test.ts tests/lib/warranty/ocr/onnx/classify.test.ts
  npx tsc --noEmit
  ```

  **If Task 1's measurement gave the classifier an input shape other than 80 by 160, change `CLS_INPUT_HEIGHT` and `CLS_INPUT_WIDTH` in `constants.ts` to the measured values, update the two rows in §4.11's table and the corresponding rows in `tests/ops/constants.test.ts`, and note it in the task report.** The graph wins over the constant at run time (MUST-4.22); the constant is only the symbolic-dimension fallback, and a fallback that is nowhere near the real shape is not a fallback.

- [ ] **Step 6: Commit.**

  ```powershell
  git add src/lib/warranty/ocr/onnx/crop.ts src/lib/warranty/ocr/onnx/classify.ts tests/lib/warranty/ocr/onnx/crop.test.ts tests/lib/warranty/ocr/onnx/classify.test.ts
  git commit -m "feat(ocr): per-box crops and the orientation classifier

crop.ts normalises each box's angle into a range where a text line is wider
than it is tall, skips the rotate entirely under half a degree, and drops any
box that clamps to zero width or height. That last one is not tidiness: a
zero-width tensor is a native crash, not an exception, so it can only be
prevented here.

The classifier ships rather than being deferred. The research doc suggested
skipping it because the browser scanner would fix orientation, but the scanner
finds the paper's outline and an outline does not say which end is the top. A
receipt photographed upside down is a real case and costs under a megabyte.
This is the one stage allowed to swallow its own failure: a wrong guess is
worse than no guess, and a crashed classifier must not cost the receipt."
  ```

---

## Task 6: `onnx/recognize.ts` and `onnx/assemble.ts`: CTC decode and the text that `suggest.ts` can read

**Context:** Spec §4.7, §4.8, §4.9 in full, §13.1's fixture 3, §13.2's `recognize.test.ts` and `assemble.test.ts` bullets, R9, §15 item 8. Implements **MUST-4.26 … MUST-4.35, MUST-2.1's purity rule for `assemble.ts`**.

R9 is the risk this task exists to close: better OCR could make the product worse. `suggest.ts` is not being modified and its three suggesters all depend on newline-separated lines in reading order. The `assemble.test.ts` assertion that runs the real `suggestFromOcrText` over the assembled fixture is the executable form of that requirement and the single most important assertion in the suite.

MUST-4.28's pad-value note is the other one to read twice: padding happens in **normalised** space, not pixel space. `REC_PAD_VALUE = 0` after `(pixel / 255 - 0.5) / 0.5` is mid-grey, which is what PaddleOCR pads with. Padding with normalised -1 puts a black bar after every short line and the CTC head reads characters into it.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/recognize.ts`
- Create: `src/lib/warranty/ocr/onnx/assemble.ts`
- Create: `tests/fixtures/ocr/receipt-boxes.json` (committed, hand-written)
- Create: `tests/lib/warranty/ocr/onnx/recognize.test.ts`
- Create: `tests/lib/warranty/ocr/onnx/assemble.test.ts`

**Interfaces:**
- Consumes: `REC_*`, `LINE_*`, `BLOCK_JOIN`, `PIXEL_SCALE`, `REC_WIDTH_MULTIPLE` from `constants.ts`; `Crop` from `crop.ts`; `Quad` from `contours.ts`; `OnnxOcrSessions` from `session.ts`.
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/recognize.ts
  export interface RecognizedLine { boxIndex: number; text: string; score: number }
  export function batchWidth(crops: readonly Crop[]): number;
  export function orderByAspect(crops: readonly Crop[]): Crop[];
  /** PURE over one row of the output tensor. */
  export function ctcGreedyDecode(
    row: Float32Array,
    timesteps: number,
    classCount: number,
    dictionary: readonly string[],
  ): { text: string; score: number };
  export function buildRecTensor(crops: readonly Crop[], width: number): Float32Array;
  export async function recognizeCrops(
    crops: readonly Crop[],
    sessions: OnnxOcrSessions,
  ): Promise<RecognizedLine[]>;

  // src/lib/warranty/ocr/onnx/assemble.ts: PURE
  export interface AssemblyBox { quad: Quad; text: string; score: number }
  export function assembleText(boxes: readonly AssemblyBox[]): string;
  ```
  Task 7's `engine.ts` calls `recognizeCrops` then `assembleText`.

### Steps

- [ ] **Step 1: Write the receipt fixture.**

  Create `tests/fixtures/ocr/receipt-boxes.json`. It reproduces a real receipt's geometry with about 40 boxes: the vendor on the first line, a date line, several item lines and a `TOTAL 42.17` line. Each entry is `{ "quad": [[x,y],[x,y],[x,y],[x,y]], "text": "...", "score": n }` with the quad as four `[x, y]` pairs, axis-aligned, in top-left, top-right, bottom-right, bottom-left order. Deliberately store the array in **scrambled** order so the assembler's sorting is exercised rather than assumed.

  ```json
  [
    { "quad": [[40, 300], [110, 300], [110, 322], [40, 322]], "text": "Paper towels", "score": 0.93 },
    { "quad": [[30, 20], [250, 20], [250, 58], [30, 58]], "text": "HOME HARDWARE", "score": 0.97 },
    { "quad": [[300, 300], [360, 300], [360, 322], [300, 322]], "text": "6.49", "score": 0.95 },
    { "quad": [[30, 470], [120, 470], [120, 500], [30, 500]], "text": "TOTAL", "score": 0.96 },
    { "quad": [[290, 470], [365, 470], [365, 500], [290, 500]], "text": "42.17", "score": 0.96 },
    { "quad": [[30, 80], [200, 80], [200, 104], [30, 104]], "text": "1200 King St W", "score": 0.9 },
    { "quad": [[30, 110], [190, 110], [190, 134], [30, 134]], "text": "Toronto ON M6K 1E5", "score": 0.9 },
    { "quad": [[30, 150], [170, 150], [170, 174], [30, 174]], "text": "2026-03-14  14:22", "score": 0.94 },
    { "quad": [[40, 200], [150, 200], [150, 222], [40, 222]], "text": "Wood screws 2in", "score": 0.92 },
    { "quad": [[300, 200], [360, 200], [360, 222], [300, 222]], "text": "12.99", "score": 0.95 },
    { "quad": [[40, 230], [140, 230], [140, 252], [40, 252]], "text": "Wall anchors", "score": 0.92 },
    { "quad": [[300, 230], [360, 230], [360, 252], [300, 252]], "text": "4.79", "score": 0.95 },
    { "quad": [[40, 260], [175, 260], [175, 282], [40, 282]], "text": "Painters tape 48mm", "score": 0.91 },
    { "quad": [[300, 260], [360, 260], [360, 282], [300, 282]], "text": "8.29", "score": 0.94 },
    { "quad": [[40, 330], [160, 330], [160, 352], [40, 352]], "text": "Utility blades", "score": 0.9 },
    { "quad": [[300, 330], [360, 330], [360, 352], [300, 352]], "text": "5.29", "score": 0.94 },
    { "quad": [[30, 390], [120, 390], [120, 412], [30, 412]], "text": "Subtotal", "score": 0.95 },
    { "quad": [[300, 390], [360, 390], [360, 412], [300, 412]], "text": "37.85", "score": 0.95 },
    { "quad": [[30, 420], [110, 420], [110, 442], [30, 442]], "text": "HST 13%", "score": 0.93 },
    { "quad": [[305, 420], [360, 420], [360, 442], [305, 442]], "text": "4.32", "score": 0.94 },
    { "quad": [[30, 530], [180, 530], [180, 552], [30, 552]], "text": "VISA ************4021", "score": 0.88 },
    { "quad": [[30, 560], [200, 560], [200, 582], [30, 582]], "text": "Thank you for shopping", "score": 0.89 }
  ]
  ```

- [ ] **Step 2: Write the failing tests.**

  Create `tests/lib/warranty/ocr/onnx/recognize.test.ts`. No session and no model: fake logit rows only.

  ```ts
  import { describe, it, expect } from 'vitest';
  import {
    REC_BATCH_SIZE,
    REC_BLANK_INDEX,
    REC_DROP_SCORE,
    REC_INPUT_HEIGHT,
    REC_MAX_WIDTH,
    REC_MEAN,
    REC_PAD_VALUE,
    REC_STD,
    REC_WIDTH_MULTIPLE,
    PIXEL_SCALE,
  } from '@/lib/warranty/ocr/onnx/constants';
  import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
  import {
    batchWidth,
    buildRecTensor,
    ctcGreedyDecode,
    orderByAspect,
    recognizeCrops,
  } from '@/lib/warranty/ocr/onnx/recognize';
  import type { OnnxOcrSessions, OnnxTensorData } from '@/lib/warranty/ocr/onnx/session';
  import { solidRgb } from '../../../../helpers/ocr-images';

  const DICT = ['', 'A', 'B', ' '];

  function crop(boxIndex: number, width: number, height = REC_INPUT_HEIGHT, value = 128): Crop {
    return { data: solidRgb(width, height, [value, value, value]), width, height, boxIndex };
  }

  /** One [T, C] row laid out flat, from a list of (classIndex, probability) pairs. */
  function row(steps: [number, number][], classCount = DICT.length): Float32Array {
    const out = new Float32Array(steps.length * classCount);
    steps.forEach(([index, probability], t) => {
      out[t * classCount + index] = probability;
    });
    return out;
  }

  function sessions(runRec: (input: OnnxTensorData) => Promise<OnnxTensorData>): OnnxOcrSessions {
    return {
      runDet: async () => ({ data: new Float32Array(1), dims: [1, 1, 1, 1] }),
      runCls: async () => ({ data: new Float32Array(2), dims: [1, 2] }),
      runRec,
      clsInputHeight: 80,
      clsInputWidth: 160,
      recClassCount: DICT.length,
      dictionary: DICT,
    };
  }

  describe('ctcGreedyDecode (MUST-4.31)', () => {
    it('collapses repeats but keeps a genuine double separated by a blank', () => {
      const steps: [number, number][] = [
        [REC_BLANK_INDEX, 0.9],
        [1, 0.9],
        [1, 0.9],
        [REC_BLANK_INDEX, 0.9],
        [1, 0.9],
      ];
      const result = ctcGreedyDecode(row(steps), steps.length, DICT.length, DICT);
      expect(result.text).toBe('AA');
    });

    it('decodes an all-blank row to the empty string', () => {
      const steps: [number, number][] = [
        [REC_BLANK_INDEX, 1],
        [REC_BLANK_INDEX, 1],
      ];
      expect(ctcGreedyDecode(row(steps), steps.length, DICT.length, DICT)).toEqual({ text: '', score: 0 });
    });

    it('scores the mean of the KEPT timesteps only', () => {
      const steps: [number, number][] = [
        [REC_BLANK_INDEX, 0.1],
        [1, 0.8],
        [2, 0.6],
      ];
      const result = ctcGreedyDecode(row(steps), steps.length, DICT.length, DICT);
      expect(result.text).toBe('AB');
      expect(result.score).toBeCloseTo((0.8 + 0.6) / 2, 6);
    });
  });

  describe('batching (MUST-4.26, MUST-4.27)', () => {
    it('orders by aspect ratio ascending', () => {
      const crops = [crop(0, 480), crop(1, 96), crop(2, 240)];
      expect(orderByAspect(crops).map((c) => c.boxIndex)).toEqual([1, 2, 0]);
    });

    it('rounds the batch width up to a multiple of REC_WIDTH_MULTIPLE', () => {
      const width = batchWidth([crop(0, 101)]);
      expect(width % REC_WIDTH_MULTIPLE).toBe(0);
    });

    it('never returns a width below the base and never above the cap', () => {
      expect(batchWidth([crop(0, 4)])).toBeGreaterThanOrEqual(320);
      expect(batchWidth([crop(0, 100_000)])).toBe(REC_MAX_WIDTH);
    });
  });

  describe('buildRecTensor (MUST-4.28, MUST-4.29, risk R3)', () => {
    it('pads in normalised space with REC_PAD_VALUE, not with black', () => {
      const width = 64;
      const tensor = buildRecTensor([crop(0, 8, REC_INPUT_HEIGHT, 255)], width);
      const plane = REC_INPUT_HEIGHT * width;
      // Column 8 onward is padding on the first row of the red plane.
      expect(tensor[8]).toBe(REC_PAD_VALUE);
      expect(tensor[width - 1]).toBe(REC_PAD_VALUE);
      expect(tensor[0]).toBeCloseTo((255 * PIXEL_SCALE - REC_MEAN) / REC_STD, 6);
      expect(tensor).toHaveLength(3 * plane);
    });
  });

  describe('recognizeCrops (MUST-4.30, MUST-4.32)', () => {
    it('restores detection order after aspect-ratio batching', async () => {
      const crops = [crop(0, 480), crop(1, 96), crop(2, 240)];
      const out = await recognizeCrops(
        crops,
        sessions(async (input) => {
          const batch = input.dims[0];
          const timesteps = 2;
          const data = new Float32Array(batch * timesteps * DICT.length);
          for (let n = 0; n < batch; n += 1) {
            data[n * timesteps * DICT.length + 1] = 0.9;
            data[n * timesteps * DICT.length + DICT.length + REC_BLANK_INDEX] = 0.9;
          }
          return { data, dims: [batch, timesteps, DICT.length] };
        }),
      );
      expect(out.map((line) => line.boxIndex)).toEqual([0, 1, 2]);
    });

    it('drops a line scoring below REC_DROP_SCORE and keeps one above it', async () => {
      const probabilities = [REC_DROP_SCORE - 0.01, REC_DROP_SCORE + 0.01];
      const out = await recognizeCrops(
        [crop(0, 96), crop(1, 96)],
        sessions(async (input) => {
          const batch = input.dims[0];
          const data = new Float32Array(batch * DICT.length);
          for (let n = 0; n < batch; n += 1) data[n * DICT.length + 1] = probabilities[n];
          return { data, dims: [batch, 1, DICT.length] };
        }),
      );
      expect(out).toHaveLength(1);
      expect(out[0].boxIndex).toBe(1);
    });

    it('drops a line that trims to nothing', async () => {
      const out = await recognizeCrops(
        [crop(0, 96)],
        sessions(async () => ({ data: new Float32Array([0, 0, 0, 0.99]), dims: [1, 1, DICT.length] })),
      );
      expect(out).toHaveLength(0);
    });

    it('throws when the class count disagrees with the dictionary', async () => {
      await expect(
        recognizeCrops(
          [crop(0, 96)],
          sessions(async () => ({ data: new Float32Array(9), dims: [1, 1, 9] })),
        ),
      ).rejects.toThrow(/class/i);
    });

    it('yields to the event loop between batches (MUST-4.39)', async () => {
      let ticks = 0;
      const stopper = setInterval(() => {
        ticks += 1;
      }, 0);
      const crops = Array.from({ length: REC_BATCH_SIZE * 3 }, (_, i) => crop(i, 96));
      await recognizeCrops(
        crops,
        sessions(async (input) => {
          const batch = input.dims[0];
          const data = new Float32Array(batch * DICT.length);
          for (let n = 0; n < batch; n += 1) data[n * DICT.length + 1] = 0.9;
          return { data, dims: [batch, 1, DICT.length] };
        }),
      );
      clearInterval(stopper);
      expect(ticks).toBeGreaterThan(0);
    });
  });
  ```

  Create `tests/lib/warranty/ocr/onnx/assemble.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { assembleText, type AssemblyBox } from '@/lib/warranty/ocr/onnx/assemble';
  import type { Quad } from '@/lib/warranty/ocr/onnx/contours';
  import { suggestFromOcrText } from '@/lib/warranty/suggest';

  function quad(x0: number, y0: number, x1: number, y1: number): Quad {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ] as const;
  }

  function fixture(): AssemblyBox[] {
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/ocr/receipt-boxes.json'), 'utf8'),
    ) as { quad: [number, number][]; text: string; score: number }[];
    return raw.map((entry) => ({
      quad: entry.quad.map(([x, y]) => ({ x, y })) as unknown as Quad,
      text: entry.text,
      score: entry.score,
    }));
  }

  describe('assembleText (MUST-4.33)', () => {
    it('merges two boxes overlapping by 60 percent of the shorter height', () => {
      const text = assembleText([
        { quad: quad(0, 0, 50, 20), text: 'left', score: 0.9 },
        { quad: quad(60, 12, 110, 32), text: 'right', score: 0.9 },
      ]);
      expect(text).toBe('left right');
    });

    it('does not merge two boxes overlapping by 40 percent', () => {
      const text = assembleText([
        { quad: quad(0, 0, 50, 20), text: 'top', score: 0.9 },
        { quad: quad(60, 12, 110, 40), text: 'bottom', score: 0.9 },
      ]);
      expect(text).toBe('top\nbottom');
    });

    it('emits a single box as one line with no trailing newline', () => {
      expect(assembleText([{ quad: quad(0, 0, 10, 10), text: 'only', score: 0.9 }])).toBe('only');
    });

    it('returns the empty string for no boxes', () => {
      expect(assembleText([])).toBe('');
    });
  });

  describe('MUST-4.34: the assembled text is what suggest.ts can read (risk R9)', () => {
    const text = assembleText(fixture());

    it('puts the vendor on the first line even though the fixture is scrambled', () => {
      expect(text.split('\n')[0]).toBe('HOME HARDWARE');
    });

    it('keeps the TOTAL line intact and on one line', () => {
      expect(text).toMatch(/^TOTAL 42\.17$/m);
    });

    it('keeps the subtotal on its own line, so it cannot be read as the total', () => {
      expect(text).toMatch(/^Subtotal 37\.85$/m);
    });

    // The single most important assertion in this suite. Better OCR that assembles into one
    // long line would make every suggestion worse while looking like an improvement.
    it('yields the expected vendor, date and price through the real suggester', () => {
      expect(suggestFromOcrText(text, '2026-08-18')).toEqual({
        vendor: 'HOME HARDWARE',
        purchaseDate: '2026-03-14',
        priceCents: 4217,
      });
    });
  });
  ```

- [ ] **Step 3: Run to verify they fail.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/recognize.test.ts tests/lib/warranty/ocr/onnx/assemble.test.ts
  ```
  Expected: unresolved imports.

- [ ] **Step 4: Write `src/lib/warranty/ocr/onnx/assemble.ts`.**

  ```ts
  import { BLOCK_JOIN, LINE_JOIN, LINE_OVERLAP_RATIO } from '@/lib/warranty/ocr/onnx/constants';
  import type { Quad } from '@/lib/warranty/ocr/onnx/contours';

  /**
   * PURE. Takes boxes and strings, returns one string.
   *
   * The output must be newline-separated lines in top-to-bottom reading order, because
   * src/lib/warranty/suggest.ts depends on exactly that and is not being modified:
   * suggestVendor takes the first five non-empty lines, suggestPriceCents finds the total
   * line and reads the last currency number ON that line, and suggestPurchaseDate uses the
   * earliest occurrence index. One long line silently ruins all three.
   */

  export interface AssemblyBox {
    quad: Quad;
    text: string;
    score: number;
  }

  interface Extent {
    box: AssemblyBox;
    minX: number;
    minY: number;
    maxY: number;
  }

  export function assembleText(boxes: readonly AssemblyBox[]): string {
    const extents: Extent[] = boxes.map((box) => {
      const ys = box.quad.map((point) => point.y);
      const xs = box.quad.map((point) => point.x);
      return { box, minX: Math.min(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    });
    extents.sort((a, b) => a.minY - b.minY);

    const lines: Extent[][] = [];
    for (const extent of extents) {
      const current = lines[lines.length - 1];
      if (current === undefined) {
        lines.push([extent]);
        continue;
      }
      const previous = current[current.length - 1];
      const overlap = Math.min(previous.maxY, extent.maxY) - Math.max(previous.minY, extent.minY);
      const shorter = Math.min(previous.maxY - previous.minY, extent.maxY - extent.minY);
      // Grouping is transitive within this single pass: each box is compared against the last
      // box added to the open line, so a run of overlapping boxes stays one line.
      if (shorter > 0 && overlap >= shorter * LINE_OVERLAP_RATIO) current.push(extent);
      else lines.push([extent]);
    }

    return lines
      .map((line) =>
        [...line]
          .sort((a, b) => a.minX - b.minX)
          .map((entry) => entry.box.text)
          .join(LINE_JOIN),
      )
      .join(BLOCK_JOIN);
  }
  ```

- [ ] **Step 5: Write `src/lib/warranty/ocr/onnx/recognize.ts`.**

  ```ts
  import sharp from 'sharp';
  import {
    PIXEL_SCALE,
    REC_BASE_WIDTH,
    REC_BATCH_SIZE,
    REC_BLANK_INDEX,
    REC_DROP_SCORE,
    REC_INPUT_HEIGHT,
    REC_MAX_WIDTH,
    REC_MEAN,
    REC_PAD_VALUE,
    REC_STD,
    REC_WIDTH_MULTIPLE,
  } from '@/lib/warranty/ocr/onnx/constants';
  import type { Crop } from '@/lib/warranty/ocr/onnx/crop';
  import type { OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';

  export interface RecognizedLine {
    boxIndex: number;
    text: string;
    score: number;
  }

  const aspect = (crop: Crop) => crop.width / crop.height;

  /** Sorting first means each batch's crops need similar padding, which is where the batching
   *  win comes from. The original index rides along on the crop. */
  export function orderByAspect(crops: readonly Crop[]): Crop[] {
    return [...crops].sort((a, b) => aspect(a) - aspect(b));
  }

  export function batchWidth(crops: readonly Crop[]): number {
    const maxRatio = crops.reduce((best, crop) => Math.max(best, aspect(crop)), REC_BASE_WIDTH / REC_INPUT_HEIGHT);
    const raw = Math.min(Math.ceil(REC_INPUT_HEIGHT * maxRatio), REC_MAX_WIDTH);
    const snapped = Math.ceil(raw / REC_WIDTH_MULTIPLE) * REC_WIDTH_MULTIPLE;
    return Math.min(snapped, REC_MAX_WIDTH);
  }

  /**
   * REC_PAD_VALUE is applied in NORMALISED space, not pixel space. 0 after
   * (pixel / 255 - 0.5) / 0.5 is mid-grey, which is what PaddleOCR pads with. Padding with
   * normalised -1 (black) puts a black bar after every short line and the CTC head reads
   * characters into it.
   */
  export function buildRecTensor(crops: readonly Crop[], width: number): Float32Array {
    const plane = REC_INPUT_HEIGHT * width;
    const tensor = new Float32Array(crops.length * 3 * plane).fill(REC_PAD_VALUE);
    for (let n = 0; n < crops.length; n += 1) {
      const crop = crops[n];
      const base = n * 3 * plane;
      const cols = Math.min(width, crop.width);
      for (let y = 0; y < Math.min(REC_INPUT_HEIGHT, crop.height); y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const source = (y * crop.width + x) * 3;
          for (let c = 0; c < 3; c += 1) {
            tensor[base + c * plane + y * width + x] = (crop.data[source + c] * PIXEL_SCALE - REC_MEAN) / REC_STD;
          }
        }
      }
    }
    return tensor;
  }

  /**
   * PP-OCR recognition heads emit post-softmax probabilities, so no softmax is applied here.
   * Repeat collapsing comes AFTER blank skipping is decided per timestep, because the blank
   * between two genuine repeated characters is what separates them.
   */
  export function ctcGreedyDecode(
    rowData: Float32Array,
    timesteps: number,
    classCount: number,
    dictionary: readonly string[],
  ): { text: string; score: number } {
    let text = '';
    let sum = 0;
    let kept = 0;
    let previous = -1;
    for (let t = 0; t < timesteps; t += 1) {
      let best = 0;
      let bestValue = -Infinity;
      for (let c = 0; c < classCount; c += 1) {
        const value = rowData[t * classCount + c];
        if (value > bestValue) {
          bestValue = value;
          best = c;
        }
      }
      if (best === REC_BLANK_INDEX) {
        previous = best;
        continue;
      }
      if (best === previous) continue;
      previous = best;
      text += dictionary[best] ?? '';
      sum += bestValue;
      kept += 1;
    }
    return { text, score: kept === 0 ? 0 : sum / kept };
  }

  async function fitCrop(crop: Crop, width: number): Promise<Crop> {
    const target = Math.max(1, Math.min(width, Math.ceil(REC_INPUT_HEIGHT * aspect(crop))));
    const { data } = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } })
      .resize({ width: target, height: REC_INPUT_HEIGHT, fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: target, height: REC_INPUT_HEIGHT, boxIndex: crop.boxIndex };
  }

  export async function recognizeCrops(
    crops: readonly Crop[],
    sessions: OnnxOcrSessions,
  ): Promise<RecognizedLine[]> {
    if (crops.length === 0) return [];
    const ordered = orderByAspect(crops);
    const lines: RecognizedLine[] = [];
    for (let start = 0; start < ordered.length; start += REC_BATCH_SIZE) {
      const batch = ordered.slice(start, start + REC_BATCH_SIZE);
      const width = batchWidth(batch);
      const fitted = await Promise.all(batch.map((crop) => fitCrop(crop, width)));
      const output = await sessions.runRec({
        data: buildRecTensor(fitted, width),
        dims: [batch.length, 3, REC_INPUT_HEIGHT, width],
      });
      const timesteps = output.dims[1];
      const classCount = output.dims[2];
      if (classCount !== sessions.recClassCount) {
        throw new Error(
          `Recognition output declares ${classCount} classes but the dictionary holds ${sessions.recClassCount}.`,
        );
      }
      for (let n = 0; n < batch.length; n += 1) {
        const offset = n * timesteps * classCount;
        const { text, score } = ctcGreedyDecode(
          output.data.subarray(offset, offset + timesteps * classCount),
          timesteps,
          classCount,
          sessions.dictionary,
        );
        const trimmed = text.trim();
        // The previous engine's failure mode was not silence, it was confident nonsense. A
        // confidence floor is the only mechanical defence, and it is what keeps the FTS5
        // index clean.
        if (trimmed.length === 0 || score < REC_DROP_SCORE) continue;
        lines.push({ boxIndex: batch[n].boxIndex, text: trimmed, score });
      }
      // 200 boxes is 34 batches with 34 yield points rather than one uninterruptible stretch.
      // session.run itself is off-thread on libuv; this pipeline's own JavaScript is not.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return lines.sort((a, b) => a.boxIndex - b.boxIndex);
  }
  ```

- [ ] **Step 6: Run until green.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/recognize.test.ts tests/lib/warranty/ocr/onnx/assemble.test.ts
  npx vitest run tests/ops/constants.test.ts
  npx tsc --noEmit
  ```
  Expected: all green. `tests/ops/constants.test.ts` is now fully green for the first time, because `contours.ts` and `assemble.ts` both exist.

  If the `suggestFromOcrText` assertion fails, **do not adjust the expected values to match**. Read `src/lib/warranty/suggest.ts` and work out which of the three suggesters the assembled text defeats, then fix the assembler or the fixture geometry. That assertion failing is the release's whole R9 risk firing in a test, which is the only place it is cheap.

- [ ] **Step 7: Commit.**

  ```powershell
  git add src/lib/warranty/ocr/onnx/recognize.ts src/lib/warranty/ocr/onnx/assemble.ts tests/fixtures/ocr/receipt-boxes.json tests/lib/warranty/ocr/onnx/recognize.test.ts tests/lib/warranty/ocr/onnx/assemble.test.ts
  git commit -m "feat(ocr): CTC decoding and text that the suggesters can still read

Crops are sorted by aspect ratio before batching so each batch pads to a
similar width, and every crop carries its detection index so results go back in
reading order. Padding is applied in normalised space: mid-grey, not black,
because a black bar after a short line is somewhere the CTC head reads
characters that are not there. A line below the confidence floor is dropped,
which is the only mechanical defence against the previous engine's real failure
mode, which was not silence but confident nonsense.

assemble.ts groups boxes into lines and emits them top to bottom, because
suggest.ts splits on newlines to find the vendor, finds the total line and
reads the last amount on THAT line, and orders dates by first occurrence. A
recogniser that read every character correctly and emitted one long line would
make every suggestion worse while looking like an improvement, so the test runs
the real suggester over the assembled fixture and checks all three fields."
  ```

---

## Task 7: `onnx/engine.ts`: the eight stages behind the existing `OcrEngine` contract

**Context:** Spec §4.1, §4.2's stage list, §4.3's error rule, §4.10, §7.1. Implements **MUST-4.1, MUST-4.2, MUST-4.3, MUST-4.35**.

The `OcrEngine` interface is unchanged and stays the only way a caller reaches recognition (warranty MUST-7.17). This task adds no method and changes no signature.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/engine.ts`
- Create: `tests/lib/warranty/ocr/onnx/engine.test.ts`

**Interfaces:**
- Consumes: `OcrEngine`, `OcrResult` from `@/lib/warranty/ocr/engine`; `extractPdfText` from `@/lib/warranty/ocr/pdf`; `ReceiptMime` from `@/lib/warranty/sniff`; `preprocessReceipt` (Task 3); `getOnnxOcrSessions` (Task 3); `detectBoxes` (Task 4); `cropBoxes` (Task 5); `classifyAndFlip` (Task 5); `recognizeCrops` (Task 6); `assembleText` (Task 6).
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/engine.ts
  export const onnxOcrEngine: OcrEngine;
  ```
  Task 8's selector imports `onnxOcrEngine` and dispatches to it when the probe says `'onnx'`.

### Steps

- [ ] **Step 1: Write the failing test.**

  Create `tests/lib/warranty/ocr/onnx/engine.test.ts`:

  ```ts
  import { describe, it, expect, afterEach, vi } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import sharp from 'sharp';
  import { onnxOcrEngine } from '@/lib/warranty/ocr/onnx/engine';
  import { detResize } from '@/lib/warranty/ocr/onnx/detect';
  import { setOnnxSessionsForTests, type OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';
  import { solidRgb } from '../../../../helpers/ocr-images';

  const DICT = ['', 'T', 'O', 'A', 'L', ' '];

  afterEach(() => {
    setOnnxSessionsForTests(null);
    vi.restoreAllMocks();
  });

  async function receiptFile(): Promise<{ file: string; dir: string; width: number; height: number }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-engine-'));
    const width = 1400;
    const height = 900;
    const png = await sharp(solidRgb(width, height, [250, 250, 250]), {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toBuffer();
    const file = path.join(dir, 'receipt.png');
    fs.writeFileSync(file, png);
    return { file, dir, width, height };
  }

  /** A fake session set that reports one box covering the top strip and decodes it to 'TOTAL'. */
  function fakeSessions(preWidth: number, preHeight: number): OnnxOcrSessions {
    const geometry = detResize(preWidth, preHeight);
    return {
      runDet: async () => {
        const map = new Float32Array(geometry.resizeW * geometry.resizeH);
        for (let y = 10; y < 34; y += 1) {
          for (let x = 10; x < 120; x += 1) map[y * geometry.resizeW + x] = 0.95;
        }
        return { data: map, dims: [1, 1, geometry.resizeH, geometry.resizeW] };
      },
      runCls: async (input) => {
        const batch = input.dims[0];
        const data = new Float32Array(batch * 2);
        for (let n = 0; n < batch; n += 1) data[n * 2] = 0.99;
        return { data, dims: [batch, 2] };
      },
      runRec: async (input) => {
        const batch = input.dims[0];
        const steps: number[] = [1, 2, 1, 3, 4];
        const data = new Float32Array(batch * steps.length * DICT.length);
        for (let n = 0; n < batch; n += 1) {
          steps.forEach((cls, t) => {
            data[(n * steps.length + t) * DICT.length + cls] = 0.95;
          });
        }
        return { data, dims: [batch, steps.length, DICT.length] };
      },
      clsInputHeight: 80,
      clsInputWidth: 160,
      recClassCount: DICT.length,
      dictionary: DICT,
    };
  }

  describe('onnxOcrEngine (MUST-4.1, MUST-4.2)', () => {
    it('satisfies the OcrEngine interface and returns { text }', async () => {
      const { file, dir, width, height } = await receiptFile();
      try {
        setOnnxSessionsForTests(fakeSessions(width, height));
        const result = await onnxOcrEngine.recognize(file, 'image/png');
        expect(Object.keys(result)).toEqual(['text']);
        expect(result.text).toContain('TOTAL');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('runs no inference at all for a PDF (MUST-4.2, MUST-7.1)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-engine-pdf-'));
      try {
        let touched = 0;
        setOnnxSessionsForTests({
          ...fakeSessions(100, 100),
          runDet: async () => {
            touched += 1;
            throw new Error('the PDF path must never reach a session');
          },
        });
        const file = path.join(dir, 'not-a-pdf.pdf');
        fs.writeFileSync(file, Buffer.from('not really a pdf'));
        await expect(onnxOcrEngine.recognize(file, 'application/pdf')).rejects.toThrow();
        expect(touched).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns an empty string when detection finds nothing, rather than throwing', async () => {
      const { file, dir, width, height } = await receiptFile();
      try {
        setOnnxSessionsForTests({
          ...fakeSessions(width, height),
          runDet: async () => {
            const geometry = detResize(width, height);
            return {
              data: new Float32Array(geometry.resizeW * geometry.resizeH),
              dims: [1, 1, geometry.resizeH, geometry.resizeW],
            };
          },
        });
        expect(await onnxOcrEngine.recognize(file, 'image/png')).toEqual({ text: '' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('MUST-4.3: a detection failure propagates rather than being swallowed', async () => {
      const { file, dir, width, height } = await receiptFile();
      try {
        setOnnxSessionsForTests({
          ...fakeSessions(width, height),
          runDet: async () => {
            throw new Error('det kernel exploded');
          },
        });
        await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow('det kernel exploded');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('MUST-4.3: a recognition failure propagates rather than being swallowed', async () => {
      const { file, dir, width, height } = await receiptFile();
      try {
        setOnnxSessionsForTests({
          ...fakeSessions(width, height),
          runRec: async () => {
            throw new Error('rec kernel exploded');
          },
        });
        await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow('rec kernel exploded');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('MUST-4.35: the engine applies no cap of its own', async () => {
      const { file, dir, width, height } = await receiptFile();
      try {
        setOnnxSessionsForTests(fakeSessions(width, height));
        const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/ocr/onnx/engine.ts'), 'utf8');
        expect(source).not.toContain('truncateOcrText');
        expect(source).not.toContain('MAX_OCR_TEXT_CHARS');
        await onnxOcrEngine.recognize(file, 'image/png');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/engine.test.ts
  ```
  Expected: `Failed to resolve import "@/lib/warranty/ocr/onnx/engine"`.

- [ ] **Step 3: Write `src/lib/warranty/ocr/onnx/engine.ts`.**

  ```ts
  import type { ReceiptMime } from '@/lib/warranty/sniff';
  import type { OcrEngine, OcrResult } from '@/lib/warranty/ocr/engine';
  import { extractPdfText } from '@/lib/warranty/ocr/pdf';
  import { assembleText, type AssemblyBox } from '@/lib/warranty/ocr/onnx/assemble';
  import { classifyAndFlip } from '@/lib/warranty/ocr/onnx/classify';
  import { cropBoxes } from '@/lib/warranty/ocr/onnx/crop';
  import { detectBoxes } from '@/lib/warranty/ocr/onnx/detect';
  import { preprocessReceipt } from '@/lib/warranty/ocr/onnx/preprocess';
  import { recognizeCrops } from '@/lib/warranty/ocr/onnx/recognize';
  import { getOnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';

  /**
   * The eight stages, in this order, each one the sole responsibility of its module. No stage
   * swallows an error: a throw propagates out of recognize() and the queue records it as a
   * failed job, exactly as a tesseract failure does today. The one exception is the
   * orientation classifier, which handles its own failure inside classifyAndFlip.
   *
   * The engine applies no character cap. The queue's truncateOcrText owns that.
   */
  export const onnxOcrEngine: OcrEngine = {
    async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
      // A PDF never touches an OCR engine. No session is created and no model is loaded.
      if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };

      const image = await preprocessReceipt(filePath);
      const sessions = await getOnnxOcrSessions();
      const boxes = await detectBoxes(image, sessions.runDet);
      if (boxes.length === 0) return { text: '' };

      const crops = await cropBoxes(image, boxes);
      const oriented = await classifyAndFlip(crops, sessions);
      const lines = await recognizeCrops(oriented, sessions);

      const assembly: AssemblyBox[] = lines.map((line) => ({
        quad: boxes[line.boxIndex].quad,
        text: line.text,
        score: line.score,
      }));
      return { text: assembleText(assembly) };
    },
  };
  ```

- [ ] **Step 4: Run until green.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr/onnx/engine.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 5: Commit.**

  ```powershell
  git add src/lib/warranty/ocr/onnx/engine.ts tests/lib/warranty/ocr/onnx/engine.test.ts
  git commit -m "feat(ocr): wire the eight stages behind the existing engine contract

recognize(filePath, mime) still returns { text } and the OcrEngine interface
gains no method, so nothing downstream of 'text out' changes. A PDF returns
from the first line without creating a session or loading a model, which
preserves today's behaviour exactly.

Errors propagate. A detection or recognition failure fails the job with its own
message, which is what the queue already records; the only stage permitted to
handle its own failure is the orientation classifier, and it does that inside
its own module rather than behind a catch here."
  ```

---

# Phase 2: The probe, the selector and the surfaces

## Task 8: `onnx/probe.ts`, `scripts/ocr-probe.mjs`, `ocr/tesseract.ts`, the selector and the `releaseOcrEngine` rename

**Context:** Spec §5 in full, §6, §12, §13.3, §15 items 9, 10, 11, 12, 13, R1, R10. Implements **MUST-5.1 … MUST-5.14, MUST-6.1 … MUST-6.4, MUST-12.1 … MUST-12.5, MUST-4.37, MUST-4.38, MUST-4.40, MUST-13.3**.

**Read §5.1 before writing a line of this.** An illegal-instruction fault raises SIGILL, SIGILL terminates the process, and it is not a JavaScript exception: `try`/`catch` does not see it, `process.on('uncaughtException')` does not see it, a rejection handler does not see it. There is no in-process way to survive it. Any design that says "we will catch the failure and fall back" is wrong on this specific failure, and this task exists because that is the trap.

The signal row of MUST-5.8's table is the whole reason the section exists, and it is written as its own row rather than folded into "nonzero exit" because `child.on('exit', (code, signal))` reports `code === null` when a signal killed the process. Code that only checks `code !== 0` mishandles exactly the case it was built for.

**Files:**
- Create: `src/lib/warranty/ocr/onnx/probe.ts`
- Create: `scripts/ocr-probe.mjs`
- Create: `src/lib/warranty/ocr/tesseract.ts` (today's worker code, moved **verbatim**)
- Modify: `src/lib/warranty/ocr/engine.ts` (becomes the selector)
- Modify: `src/lib/warranty/ocr/queue.ts` (**exactly two lines**)
- Modify: `tests/lib/warranty/ocr/engine-options.test.ts` (repoint at `tesseract.ts`)
- Modify: `tests/lib/warranty/ocr/idle.test.ts` (the rename)
- Modify: `tests/lib/warranty/ocr/queue.test.ts` (the spy target)
- Create: `tests/lib/warranty/ocr/probe.test.ts`
- Create: `tests/scripts/ocr-probe.test.ts` (**runs the real script against the real models**)
- Create: `tests/ops/ocr-egress.test.ts`

**Interfaces:**
- Consumes: `getSetting`, `setSetting`, `deleteSetting` from `@/lib/settings`; `APP_VERSION` from `@/lib/version`; `onnxOcrEngine` (Task 7); `releaseOnnxOcrSessions`, `setOnnxSessionsForTests` (Task 3).
- Produces:
  ```ts
  // src/lib/warranty/ocr/onnx/probe.ts
  export const OCR_PROBE_OK_LINE = 'ocr-probe-ok';
  export const OCR_PROBE_TIMEOUT_MS = 60_000;
  export const SETTING_OCR_ENGINE = 'ocr.engine';
  export const SETTING_OCR_ENGINE_PROBED_VERSION = 'ocr.engine_probed_version';
  export const SETTING_OCR_ENGINE_PROBE_AT = 'ocr.engine_probe_at';
  export const SETTING_OCR_ENGINE_PROBE_DETAIL = 'ocr.engine_probe_detail';
  export type OcrEngineKind = 'onnx' | 'tesseract';
  export interface OcrEngineState {
    engine: OcrEngineKind | null;
    probedVersion: string | null;
    probedAt: string | null;
    detail: string | null;
  }
  /** `${APP_VERSION}/${process.arch}`, so a backup restored across architectures re-probes. */
  export function probeCacheKey(): string;
  export function readOcrEngineState(): OcrEngineState;
  export async function resolveOcrEngineKind(): Promise<OcrEngineKind>;
  export function resetOcrProbeForTests(): void;
  export function setProbeScriptPathForTests(scriptPath: string | null): void;

  // src/lib/warranty/ocr/tesseract.ts
  export interface TesseractWorkerLike {
    recognize(input: string): Promise<{ data: { text: string } }>;
    terminate(): Promise<void>;
  }
  export async function recognizeWithTesseract(filePath: string): Promise<string>;
  export async function releaseTesseractWorker(): Promise<void>;
  export function setOcrWorkerForTests(fake: TesseractWorkerLike | null): void;

  // src/lib/warranty/ocr/engine.ts: everything it exports today, unchanged, plus:
  export async function releaseOcrEngine(): Promise<void>;   // replaces terminateOcrWorker
  export { setOcrWorkerForTests, type TesseractWorkerLike } from '@/lib/warranty/ocr/tesseract';
  ```
  `terminateOcrWorker` no longer exists anywhere. Per plan resolution 11, `engine.ts` does **not** re-export `setOnnxSessionsForTests` and has no static import of the `onnx/` tree apart from `probe.ts`. Task 9's Settings surface calls `readOcrEngineState()`; Task 9's integration walk seeds the four settings keys and imports `setOnnxSessionsForTests` from `@/lib/warranty/ocr/onnx/session` directly.

### Steps

- [ ] **Step 1: Move the tesseract path verbatim into `src/lib/warranty/ocr/tesseract.ts`.**

  Cut `TesseractWorkerLike`, the module-level `worker` variable, `getWorker()` and `setOcrWorkerForTests` out of `engine.ts` and paste them in unchanged. **Do not rewrite anything**: the fallback should be the code that shipped in the last release, not a fresh derivation of it. The `createWorker` call keeps all four path options, `gzip: true`, `cacheMethod: 'none'` and its `errorHandler`, and keeps its MUST-7.3 comment.

  Add two functions around the moved code and nothing else:

  ```ts
  /** The tesseract half of releaseOcrEngine(). The idle timer stays in engine.ts, which owns
   *  it for both engines. */
  export async function releaseTesseractWorker(): Promise<void> {
    const current = worker;
    worker = null;
    if (current) {
      try {
        await current.terminate();
      } catch (error) {
        console.warn('[ocr] worker terminate failed', error);
      }
    }
  }

  export async function recognizeWithTesseract(filePath: string): Promise<string> {
    const active = await getWorker();
    const result = await active.recognize(filePath);
    return result.data.text;
  }
  ```

  `getWorker` keeps its `assertOcrAssets()` check and its `OcrUnavailableError` throw, importing both from `@/lib/warranty/ocr/assets` and `@/lib/warranty/ocr/engine`. `assets.ts` is not modified.

- [ ] **Step 2: Turn `src/lib/warranty/ocr/engine.ts` into the selector.**

  Everything MUST-5.12 names stays exactly as it is: `OcrResult`, `OcrEngine`, `MAX_OCR_TEXT_CHARS`, `OCR_TIMEOUT_MS`, `OCR_IDLE_TERMINATE_MS`, `OCR_UNAVAILABLE_MESSAGE`, `OCR_TIMEOUT_MESSAGE`, `TRUNCATION_MARKER`, `TRUNCATION_NOTE`, `OcrUnavailableError`, `truncateOcrText`, `getOcrEngine`, `setOcrEngineForTests`. Replace only the worker plumbing and `terminateOcrWorker`.

  ```ts
  import type { ReceiptMime } from '@/lib/warranty/sniff';
  import { extractPdfText } from '@/lib/warranty/ocr/pdf';
  import { recognizeWithTesseract, releaseTesseractWorker } from '@/lib/warranty/ocr/tesseract';
  import { resolveOcrEngineKind } from '@/lib/warranty/ocr/onnx/probe';

  export { setOcrWorkerForTests, type TesseractWorkerLike } from '@/lib/warranty/ocr/tesseract';

  // ... OcrResult, OcrEngine, the constants, OcrUnavailableError and truncateOcrText all
  // stay byte-identical to what they are today ...

  let idleTimer: NodeJS.Timeout | null = null;
  // Whether the ONNX tree has ever been loaded in this process. releaseOcrEngine() must not
  // import it just to release sessions that were never created, and on hardware the probe
  // rejected it is never imported at all.
  let onnxTouched = false;

  function armIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    // MUST-7.10 / risk R5: release the engine's resident memory after 60 s idle.
    idleTimer = setTimeout(() => {
      void releaseOcrEngine();
    }, OCR_IDLE_TERMINATE_MS);
    idleTimer.unref?.();
  }

  /**
   * Replaces terminateOcrWorker. The old name described a process the ONNX path does not
   * have, and an accurate name is cheaper than a comment explaining an inaccurate one.
   * Disposes whichever engine is live, each in its own try/catch.
   */
  export async function releaseOcrEngine(): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (onnxTouched) {
      const { releaseOnnxOcrSessions } = await import('@/lib/warranty/ocr/onnx/session');
      await releaseOnnxOcrSessions();
    }
    await releaseTesseractWorker();
  }

  const defaultEngine: OcrEngine = {
    async recognize(filePath: string, mime: ReceiptMime): Promise<OcrResult> {
      // A PDF goes to the text layer before anything else: no probe, no session, no engine
      // question. This preserves the current behaviour that a PDF never touches an OCR engine.
      if (mime === 'application/pdf') return { text: await extractPdfText(filePath) };
      // IMPORTANT 2: disarm any pending idle-terminate timer the INSTANT a job claims the
      // engine, before awaiting anything. armIdleTimer() previously only re-armed inside the
      // `finally` below, which left a window where job N's OWN recognize() call could still
      // be in flight when the timer job N-1 armed on completion fired — terminating the
      // engine mid-recognition, stalling job N for the full OCR_TIMEOUT_MS and recording a
      // bogus "OCR timed out." instead of the real result.
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      try {
        const kind = await resolveOcrEngineKind();
        // A run-time ONNX failure that is a normal throw does NOT switch the cached engine
        // and does NOT retry on tesseract. Only the probe decides which engine an install
        // uses; a transient bad receipt must not rewrite install-level configuration.
        if (kind === 'onnx') {
          // Dynamic, so the ONNX tree is never evaluated on an install the probe rejected,
          // and so engine.ts and onnx/models.ts do not form an import cycle.
          onnxTouched = true;
          const { onnxOcrEngine } = await import('@/lib/warranty/ocr/onnx/engine');
          return await onnxOcrEngine.recognize(filePath, mime);
        }
        return { text: await recognizeWithTesseract(filePath) };
      } finally {
        armIdleTimer();
      }
    },
  };
  ```

  Note the em dashes inside the copied `IMPORTANT 2` comment: it is existing text being preserved verbatim, and rewording it would lose the regression's history. Leave it exactly as it is; every **new** comment in this release uses no dash of that kind.

- [ ] **Step 3: Change the two lines in `queue.ts` (MUST-6.1).**

  In the import block, `terminateOcrWorker` becomes `releaseOcrEngine`. In `recognizeWithTimeout`'s `finally`:

  ```ts
      if (timedOut) {
        await releaseOcrEngine().catch((error) => {
          console.warn('[ocr] worker terminate after timeout failed', error);
        });
      }
  ```

  Nothing else in that file changes. Its FIFO ordering, concurrency of 1, `claimed` set, `pump` single-flight invariant and its long comment, the `Promise.race`, `sweepPendingReceipts()`, `drainOcrQueue()` and `resetOcrQueueForTests()` all stay byte-identical.

- [ ] **Step 4: Repoint the three existing tests.**

  - `tests/lib/warranty/ocr/engine-options.test.ts` reads `src/lib/warranty/ocr/engine.ts`'s source text and slices out the `createWorker(...)` call. Change the path to `src/lib/warranty/ocr/tesseract.ts`. Its assertions are unchanged, including the "no `https?://`, no unpkg, no jsdelivr" one, which now covers the moved file.
  - `tests/lib/warranty/ocr/idle.test.ts` imports `terminateOcrWorker`; change it to `releaseOcrEngine` at the import and at both `afterEach` call sites. Its fake-timer assertions are unchanged.
  - `tests/lib/warranty/ocr/queue.test.ts` does `vi.spyOn(engineModule, 'terminateOcrWorker')`; change the spy name to `'releaseOcrEngine'`. Its assertion that the spy was called exactly once after a timeout is unchanged.

- [ ] **Step 5: Write `scripts/ocr-probe.mjs`.**

  ```js
  /**
   * The hardware compatibility probe, run in its own process because an illegal-instruction
   * fault on an ARM core without the features ORT's kernels assume raises SIGILL, and SIGILL
   * terminates the process. It is not a JavaScript exception, so no in-process try/catch can
   * survive it. The parent watches this child die instead.
   *
   * Touches no database, opens no socket, reads no environment variable and writes nothing to
   * disk. It is a pure question about this CPU and these three files.
   */
  import path from 'node:path';

  const OK_LINE = 'ocr-probe-ok';
  const DIR = path.join(process.cwd(), 'vendor', 'ocr-models');
  const OPTIONS = {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
    enableCpuMemArena: false,
  };

  const CASES = [
    { file: 'ch_PP-OCRv5_det_mobile.onnx', dims: [1, 3, 32, 32] },
    { file: 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx', dims: [1, 3, 80, 160] },
    { file: 'en_PP-OCRv5_rec_mobile.onnx', dims: [1, 3, 48, 320] },
  ];

  try {
    // Loading the native binding is the first of the two places SIGILL is expected.
    const ort = await import('onnxruntime-node');
    for (const probe of CASES) {
      const session = await ort.InferenceSession.create(path.join(DIR, probe.file), { ...OPTIONS });
      const size = probe.dims.reduce((total, value) => total * value, 1);
      // Executing a real kernel is the second place, which is why the probe does not stop at
      // session creation.
      await session.run({
        [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(size), probe.dims),
      });
      await session.release();
    }
    console.log(OK_LINE);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  ```

  The classifier's `dims` must match whatever Task 1 measured. If Task 1 found a shape other than 80 by 160, use that.

- [ ] **Step 6: Write `src/lib/warranty/ocr/onnx/probe.ts`.**

  ```ts
  import path from 'node:path';
  import { spawn } from 'node:child_process';
  import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
  import { APP_VERSION } from '@/lib/version';

  export const OCR_PROBE_OK_LINE = 'ocr-probe-ok';
  export const OCR_PROBE_TIMEOUT_MS = 60_000;

  export const SETTING_OCR_ENGINE = 'ocr.engine';
  export const SETTING_OCR_ENGINE_PROBED_VERSION = 'ocr.engine_probed_version';
  export const SETTING_OCR_ENGINE_PROBE_AT = 'ocr.engine_probe_at';
  export const SETTING_OCR_ENGINE_PROBE_DETAIL = 'ocr.engine_probe_detail';

  const DETAIL_MAX_CHARS = 200;

  export type OcrEngineKind = 'onnx' | 'tesseract';

  export interface OcrEngineState {
    engine: OcrEngineKind | null;
    probedVersion: string | null;
    probedAt: string | null;
    detail: string | null;
  }

  /**
   * Keyed on the architecture as well as the version. A backup restored from an amd64 machine
   * onto an arm64 NAS re-probes, because a cached "this CPU is fine" verdict must never be
   * carried onto a CPU that is not.
   */
  export function probeCacheKey(): string {
    return `${APP_VERSION}/${process.arch}`;
  }

  function isKind(value: string | null): value is OcrEngineKind {
    return value === 'onnx' || value === 'tesseract';
  }

  /** The single reader over the four keys, so no caller assembles this from loose getSetting
   *  calls. */
  export function readOcrEngineState(): OcrEngineState {
    const engine = getSetting(SETTING_OCR_ENGINE);
    return {
      engine: isKind(engine) ? engine : null,
      probedVersion: getSetting(SETTING_OCR_ENGINE_PROBED_VERSION),
      probedAt: getSetting(SETTING_OCR_ENGINE_PROBE_AT),
      detail: getSetting(SETTING_OCR_ENGINE_PROBE_DETAIL),
    };
  }

  let inFlight: Promise<OcrEngineKind> | null = null;
  let scriptPathOverride: string | null = null;

  export function resetOcrProbeForTests(): void {
    inFlight = null;
  }

  export function setProbeScriptPathForTests(scriptPath: string | null): void {
    scriptPathOverride = scriptPath;
  }

  function probeScriptPath(): string {
    return scriptPathOverride ?? path.join(process.cwd(), 'scripts', 'ocr-probe.mjs');
  }

  function record(kind: OcrEngineKind, detail: string | null): void {
    setSetting(SETTING_OCR_ENGINE, kind);
    setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
    setSetting(SETTING_OCR_ENGINE_PROBE_AT, new Date().toISOString());
    if (detail === null) deleteSetting(SETTING_OCR_ENGINE_PROBE_DETAIL);
    else setSetting(SETTING_OCR_ENGINE_PROBE_DETAIL, detail);
  }

  interface Outcome {
    kind: OcrEngineKind;
    detail: string | null;
  }

  function runProbe(): Promise<Outcome> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      // Never spawnSync: a synchronous 60 second worst case would freeze the HTTP server.
      const child = spawn(process.execPath, [probeScriptPath()], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ kind: 'tesseract', detail: 'probe timed out after 60 seconds' });
      }, OCR_PROBE_TIMEOUT_MS);
      timer.unref?.();

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish({ kind: 'tesseract', detail: `probe could not start: ${error.code ?? error.message}` });
      });

      child.on('exit', (code, signal) => {
        // The signal branch comes FIRST. child.on('exit') reports code === null when a signal
        // killed the process, and code that only checks code !== 0 mishandles exactly the
        // case this whole mechanism was built for.
        if (signal !== null) {
          finish({ kind: 'tesseract', detail: `probe process was killed by ${signal}` });
          return;
        }
        if (code !== 0) {
          const detail = stderr.replace(/\s*\n\s*/g, ' ').trim().slice(0, DETAIL_MAX_CHARS);
          finish({ kind: 'tesseract', detail: detail.length > 0 ? detail : `probe exited with code ${code}` });
          return;
        }
        const lastLine = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .at(-1);
        if (lastLine === OCR_PROBE_OK_LINE) finish({ kind: 'onnx', detail: null });
        else finish({ kind: 'tesseract', detail: 'probe exited cleanly without confirming' });
      });
    });
  }

  /**
   * Runs at most once per image version per architecture, ever. It runs inside a queue job,
   * which is already off the request path, never at boot, never on a page render and never
   * from a server action.
   */
  export async function resolveOcrEngineKind(): Promise<OcrEngineKind> {
    // A module-level in-flight promise, because the boot sweep can enqueue several jobs at
    // once and they must not each spawn a child.
    if (inFlight !== null) return inFlight;

    const cached = readOcrEngineState();
    if (cached.engine !== null && cached.probedVersion === probeCacheKey()) return cached.engine;

    inFlight = (async () => {
      const outcome = await runProbe();
      // Written before this promise resolves, so a crash between the probe and the first
      // receipt does not re-probe.
      record(outcome.kind, outcome.detail);
      if (outcome.detail !== null) console.warn(`[ocr] compatibility probe failed: ${outcome.detail}`);
      return outcome.kind;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  ```

- [ ] **Step 7: Write `tests/lib/warranty/ocr/probe.test.ts`.**

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { getSetting, setSetting } from '@/lib/settings';
  import { APP_VERSION } from '@/lib/version';
  import {
    OCR_PROBE_OK_LINE,
    SETTING_OCR_ENGINE,
    SETTING_OCR_ENGINE_PROBED_VERSION,
    SETTING_OCR_ENGINE_PROBE_AT,
    SETTING_OCR_ENGINE_PROBE_DETAIL,
    probeCacheKey,
    readOcrEngineState,
    resetOcrProbeForTests,
    resolveOcrEngineKind,
    setProbeScriptPathForTests,
  } from '@/lib/warranty/ocr/onnx/probe';
  import { createSeededTestDb, type TestDb } from '../../../helpers/db';

  let current: TestDb | null = null;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-probe-'));
    current = createSeededTestDb();
    resetOcrProbeForTests();
  });

  afterEach(() => {
    setProbeScriptPathForTests(null);
    resetOcrProbeForTests();
    current?.cleanup();
    current = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A fake probe script written to a temp directory, so every verdict row is driven by a
   *  real child process without loading a real model. */
  function fakeScript(name: string, body: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body, 'utf8');
    setProbeScriptPathForTests(file);
    return file;
  }

  describe('the cache (MUST-5.6, MUST-5.10, MUST-12.5)', () => {
    it('returns a matching cached verdict without spawning', async () => {
      fakeScript('never.mjs', 'process.exit(3);');
      setSetting(SETTING_OCR_ENGINE, 'onnx');
      setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
      expect(await resolveOcrEngineKind()).toBe('onnx');
      // A spawn would have recorded a fresh timestamp.
      expect(getSetting(SETTING_OCR_ENGINE_PROBE_AT)).toBeNull();
    });

    it('re-probes when the version differs', async () => {
      fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
      setSetting(SETTING_OCR_ENGINE, 'tesseract');
      setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, `0.0.1/${process.arch}`);
      expect(await resolveOcrEngineKind()).toBe('onnx');
    });

    it('re-probes when the architecture differs, so a cross-architecture restore cannot lie', async () => {
      fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
      setSetting(SETTING_OCR_ENGINE, 'tesseract');
      setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, `${APP_VERSION}/not-this-arch`);
      expect(await resolveOcrEngineKind()).toBe('onnx');
      expect(getSetting(SETTING_OCR_ENGINE_PROBED_VERSION)).toBe(`${APP_VERSION}/${process.arch}`);
    });
  });

  describe('MUST-5.8: the verdict table, every row', () => {
    it('exit 0 with the ok line gives onnx and deletes the detail', async () => {
      setSetting(SETTING_OCR_ENGINE_PROBE_DETAIL, 'stale');
      fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
      expect(await resolveOcrEngineKind()).toBe('onnx');
      expect(readOcrEngineState().detail).toBeNull();
    });

    it('exit 0 without the ok line gives tesseract', async () => {
      fakeScript('silent.mjs', 'process.exit(0);');
      expect(await resolveOcrEngineKind()).toBe('tesseract');
      expect(readOcrEngineState().detail).toBe('probe exited cleanly without confirming');
    });

    it('a killing signal gives tesseract and names the signal, and does not take the code === 0 branch', async () => {
      fakeScript('sigill.mjs', `console.log('${OCR_PROBE_OK_LINE}');\nprocess.kill(process.pid, 'SIGILL');\nawait new Promise(() => {});`);
      expect(await resolveOcrEngineKind()).toBe('tesseract');
      expect(readOcrEngineState().detail).toMatch(/killed by SIG/);
    });

    it('a nonzero exit gives tesseract with the first 200 characters of stderr, newlines collapsed', async () => {
      fakeScript('boom.mjs', "console.error('line one\\nline two');\nprocess.exit(3);");
      expect(await resolveOcrEngineKind()).toBe('tesseract');
      const detail = readOcrEngineState().detail ?? '';
      expect(detail).toBe('line one line two');
      expect(detail.length).toBeLessThanOrEqual(200);
    });

    it('a spawn error gives tesseract and names the code', async () => {
      setProbeScriptPathForTests(path.join(dir, 'does', 'not', 'exist.mjs'));
      expect(await resolveOcrEngineKind()).toBe('tesseract');
      expect(readOcrEngineState().detail).toMatch(/probe could not start|MODULE_NOT_FOUND|Cannot find module/);
    });
  });

  describe('the settings write (MUST-5.9, MUST-12.2)', () => {
    it('writes all three keys before the promise resolves', async () => {
      fakeScript('ok.mjs', `console.log('${OCR_PROBE_OK_LINE}');`);
      await resolveOcrEngineKind().then(() => {
        expect(getSetting(SETTING_OCR_ENGINE)).toBe('onnx');
        expect(getSetting(SETTING_OCR_ENGINE_PROBED_VERSION)).toBe(probeCacheKey());
        expect(getSetting(SETTING_OCR_ENGINE_PROBE_AT)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
    });
  });

  describe('single flight (MUST-5.6 step 1)', () => {
    it('two concurrent calls spawn exactly one child', async () => {
      const marker = path.join(dir, 'spawns.txt');
      fakeScript(
        'counting.mjs',
        `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log('${OCR_PROBE_OK_LINE}');`,
      );
      const [a, b] = await Promise.all([resolveOcrEngineKind(), resolveOcrEngineKind()]);
      expect(a).toBe('onnx');
      expect(b).toBe('onnx');
      expect(fs.readFileSync(marker, 'utf8')).toBe('x');
    });
  });
  ```

- [ ] **Step 8: Write `tests/scripts/ocr-probe.test.ts` (MUST-5.4, MUST-13.3).**

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { execFile } from 'node:child_process';
  import { promisify } from 'node:util';
  import { OCR_PROBE_OK_LINE } from '@/lib/warranty/ocr/onnx/probe';

  const run = promisify(execFile);
  const script = path.join(process.cwd(), 'scripts', 'ocr-probe.mjs');

  describe('scripts/ocr-probe.mjs source (MUST-5.4)', () => {
    const source = fs.readFileSync(script, 'utf8');

    it('touches no database, no socket and no disk write', () => {
      expect(source).not.toContain('better-sqlite3');
      expect(source).not.toContain('@/db');
      expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
      expect(source).not.toContain('writeFile');
      expect(source).not.toContain('process.env');
    });

    it('pins the same ok line the parent compares against', () => {
      expect(source).toContain(`'${OCR_PROBE_OK_LINE}'`);
    });
  });

  describe('MUST-13.3: the real probe against the real models', () => {
    it('loads all three graphs, runs three inferences and exits 0 with the ok line', async () => {
      const { stdout } = await run(process.execPath, [script], { cwd: process.cwd() });
      expect(stdout.trim().split('\n').at(-1)).toBe(OCR_PROBE_OK_LINE);
    }, 60_000);
  });
  ```

- [ ] **Step 9: Write `tests/ops/ocr-egress.test.ts` (MUST-11.6, MUST-2.2, MUST-2.3, plan resolution 2).**

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';

  const ROOT = process.cwd();
  const TREES = ['src/lib/warranty/ocr', 'src/lib/scanner'];

  function walk(dir: string): string[] {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return walk(relative);
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [relative] : [];
    });
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const files = TREES.flatMap(walk);
  const sources = new Map(files.map((file) => [file, stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))]));

  describe('MUST-11.6 / AC3: the OCR and scanner trees make no outbound call', () => {
    it('has at least one file to scan, so a rename cannot make this suite vacuous', () => {
      expect(files.length).toBeGreaterThan(10);
    });

    it('contains no fetch( call site at all', () => {
      const offenders = [...sources].filter(([, source]) => /(?<![.\w])fetch\s*\(/.test(source)).map(([file]) => file);
      expect(offenders).toEqual([]);
    });

    it('contains no :// literal at all', () => {
      const offenders = [...sources]
        .filter(([, source]) => /(['"`])[^'"`]*:\/\/[^'"`]*\1/.test(source))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });

    it('imports no HTTP client library', () => {
      const banned = /from\s+['"](axios|node-fetch|got|undici|superagent|ky|request)['"]/;
      const offenders = [...sources].filter(([, source]) => banned.test(source)).map(([file]) => file);
      expect(offenders).toEqual([]);
    });

    it('names no model host, CDN host or ModelScope', () => {
      const banned = /modelscope|ModelScope|docs\.opencv\.org|cdn\.jsdelivr\.net|unpkg\.com|raw\.githubusercontent/i;
      const offenders = [...sources].filter(([, source]) => banned.test(source)).map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  });

  describe('MUST-2.3: onnxruntime-node is imported in exactly two places', () => {
    it('is session.ts and scripts/ocr-probe.mjs, and nowhere else', () => {
      const hits: string[] = [];
      const scan = (relative: string) => {
        const source = stripComments(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
        if (source.includes("'onnxruntime-node'")) hits.push(relative);
      };
      const srcFiles = walk('src');
      for (const file of srcFiles) scan(file);
      for (const file of fs.readdirSync(path.join(ROOT, 'scripts'))) {
        if (file.endsWith('.mjs') || file.endsWith('.ts')) scan(path.posix.join('scripts', file));
      }
      expect(hits.sort()).toEqual(['scripts/ocr-probe.mjs', 'src/lib/warranty/ocr/onnx/session.ts']);
    });

    it('both imports are dynamic, so a broken native binding does not kill module evaluation', () => {
      for (const file of ['src/lib/warranty/ocr/onnx/session.ts', 'scripts/ocr-probe.mjs']) {
        const source = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
        expect(source).toMatch(/await import\(['"]onnxruntime-node['"]\)|import\(['"]onnxruntime-node['"]\)/);
        expect(source).not.toMatch(/^\s*import .* from ['"]onnxruntime-node['"]/m);
      }
    });
  });

  describe('MUST-2.2: nothing under onnx/ reaches a client component except constants.ts', () => {
    it('no *-client.tsx or "use client" file value-imports a non-constants onnx module', () => {
      const banned = /from\s+['"]@\/lib\/warranty\/ocr\/onnx\/(?!constants)/;
      const offenders: string[] = [];
      for (const file of walk('src/app').concat(walk('src/components'))) {
        const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
        if (!raw.includes("'use client'")) continue;
        for (const line of stripComments(raw).split('\n')) {
          if (!banned.test(line)) continue;
          if (/^\s*import\s+type\s/.test(line)) continue;
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('MUST-12.1 / AC9: no migration', () => {
    it('drizzle/ holds no OCR object', () => {
      const dir = path.join(ROOT, 'drizzle');
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.sql')) continue;
        expect(fs.readFileSync(path.join(dir, entry), 'utf8')).not.toMatch(/ocr[._]engine/i);
      }
    });

    it('src/db/schema.ts gains no OCR column', () => {
      const source = fs.readFileSync(path.join(ROOT, 'src/db/schema.ts'), 'utf8');
      expect(source).not.toMatch(/ocr_engine|ocrEngine/);
    });
  });
  ```

- [ ] **Step 10: Run everything this task touched.**

  ```powershell
  npx vitest run tests/lib/warranty/ocr tests/scripts/ocr-probe.test.ts tests/ops/ocr-egress.test.ts
  npx tsc --noEmit
  ```
  Expected: green, including the three amended files and the real-probe test.

  ```powershell
  Select-String -Path .\src -Pattern 'terminateOcrWorker' -Recurse
  Select-String -Path .\tests -Pattern 'terminateOcrWorker' -Recurse
  ```
  Expected: no matches anywhere. The rename is complete or it is not done.

- [ ] **Step 11: Commit.**

  ```powershell
  git add src/lib/warranty/ocr scripts/ocr-probe.mjs tests/lib/warranty/ocr tests/scripts/ocr-probe.test.ts tests/ops/ocr-egress.test.ts
  git commit -m "feat(ocr): decide the engine once, in a process that is allowed to die

An ARM core without the instructions ORT's kernels assume does not throw, it
raises SIGILL, and SIGILL ends the process. No try/catch, no uncaughtException
handler and no rejection handler sees it. So the first use of the new reader on
a given image version happens in a spawned child whose death the parent can
watch, and the answer is cached in the settings table keyed on both the version
and the architecture, so a backup restored across architectures asks again.

The verdict table's signal row is handled before the exit-code row, because
child exit reports a null code when a signal killed the process and code that
only checks for nonzero mishandles the exact case this exists for.

terminateOcrWorker becomes releaseOcrEngine: the old name described a process
the new path does not have. Today's tesseract code moves into its own file
unchanged, so the fallback is the code that shipped rather than a fresh
derivation of it. queue.ts changes by two lines and nothing else."
  ```

---

## Task 9: The Settings warning and the end-to-end queue walk

**Context:** Spec §5.5, §6, §9, §13.5's `about-panel.test.tsx` bullet, §13.6, §15 items 14 and 15, MUST-13.4. Implements **MUST-5.15 … MUST-5.18, MUST-6.2, MUST-6.3, MUST-9.1 … MUST-9.4, MUST-13.4**.

MUST-5.17 is a decision worth restating before the temptation arrives: the warning lives on Settings, About and nowhere else. It is an install-level fact an admin can do nothing about, it is permanent for the life of the hardware, and a banner every household member saw on every receipt upload would be a permanent apology for something nobody can act on.

`reRunOcrAction` is **not modified**. Because the engine choice lives inside `recognize()`, a re-queued job automatically runs on whichever engine this install resolved to, and the integration walk is what proves it.

**Files:**
- Modify: `src/app/(app)/settings/about-panel.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `tests/app/about-panel.test.tsx`
- Create: `tests/integration/ocr-engine.test.ts`

**Interfaces:**
- Consumes: `readOcrEngineState()` and `OcrEngineState` from `@/lib/warranty/ocr/onnx/probe` (Task 8); `Notice` from `@/components/ui/Notice`; `setOnnxSessionsForTests`, `releaseOcrEngine`, `OCR_TIMEOUT_MESSAGE` from `@/lib/warranty/ocr/engine`; `enqueueOcrJob`, `drainOcrQueue`, `resetOcrQueueForTests` from `@/lib/warranty/ocr/queue`; `resetReceiptForReOcr` from `@/lib/warranty/items`.
- Produces:
  ```tsx
  // src/app/(app)/settings/about-panel.tsx
  export function AboutPanel({ ocr }: { ocr: OcrEngineState }): React.ReactElement;
  ```
  The prop is **required**, not optional. An optional prop with a silent default is a warning that quietly stops rendering the day someone forgets to pass it.

### Steps

- [ ] **Step 1: Write the failing tests.**

  Amend `tests/app/about-panel.test.tsx`. Its current imports are `{ describe, it, expect, afterEach }` from `vitest` and `{ render, cleanup }` from `@testing-library/react`; the new tests also need `screen`, so add it to that second import. Then add this helper near the top, and pass it at **every** existing `render(<AboutPanel />)` call site in the file so they compile:

  ```tsx
  import type { OcrEngineState } from '@/lib/warranty/ocr/onnx/probe';

  const NO_PROBE: OcrEngineState = { engine: null, probedVersion: null, probedAt: null, detail: null };
  const FELL_BACK: OcrEngineState = {
    engine: 'tesseract',
    probedVersion: '1.5.0/arm64',
    probedAt: '2026-08-18T09:41:07.000Z',
    detail: 'probe process was killed by SIGILL',
  };
  ```

  Then append:

  ```tsx
  describe('MUST-5.16: the fallback warning', () => {
    it('renders when the engine is the older reader and a reason was recorded', () => {
      render(<AboutPanel ocr={FELL_BACK} />);
      expect(screen.getByText(/This machine cannot run the new receipt reader\./)).toBeTruthy();
      expect(screen.getByText(/probe process was killed by SIGILL/)).toBeTruthy();
      expect(screen.getByText(/2026-08-18 09:41/)).toBeTruthy();
    });

    it('does not render when the engine fell back but no reason was recorded', () => {
      render(<AboutPanel ocr={{ ...FELL_BACK, detail: null }} />);
      expect(screen.queryByText(/This machine cannot run/)).toBeNull();
    });

    it('does not render for the new reader', () => {
      render(<AboutPanel ocr={{ ...FELL_BACK, engine: 'onnx', detail: null }} />);
      expect(screen.queryByText(/This machine cannot run/)).toBeNull();
    });

    it('does not render when the keys are absent', () => {
      render(<AboutPanel ocr={NO_PROBE} />);
      expect(screen.queryByText(/This machine cannot run/)).toBeNull();
    });

    it('MUST-5.18: the copy names no library and no version of one', () => {
      const { container } = render(<AboutPanel ocr={{ ...FELL_BACK, detail: 'probe timed out after 60 seconds' }} />);
      const text = container.textContent ?? '';
      for (const banned of ['PP-OCR', 'ONNX', 'onnx', 'tesseract', 'Tesseract']) {
        expect(text).not.toContain(banned);
      }
      expect(text).toContain('the new receipt reader');
      expect(text).toContain('the older reader');
    });

    it('MUST-13.3-style safety: the recorded reason is a text node, not markup', () => {
      const { container } = render(<AboutPanel ocr={{ ...FELL_BACK, detail: 'exploded <b>badly</b>' }} />);
      expect(container.querySelector('b')).toBeNull();
      expect(container.textContent).toContain('exploded <b>badly</b>');
    });

    it('sits above the changelog list', () => {
      const { container } = render(<AboutPanel ocr={FELL_BACK} />);
      const html = container.innerHTML;
      expect(html.indexOf('This machine cannot run')).toBeLessThan(html.indexOf('<ol'));
    });
  });
  ```

  Create `tests/integration/ocr-engine.test.ts` (MUST-13.4). It uses a **fake** session set, so the whole engine path runs with no model load.

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import sharp from 'sharp';
  import { sql } from 'drizzle-orm';
  import { setSetting } from '@/lib/settings';
  import { OCR_TIMEOUT_MESSAGE, releaseOcrEngine } from '@/lib/warranty/ocr/engine';
  import { detResize } from '@/lib/warranty/ocr/onnx/detect';
  import {
    SETTING_OCR_ENGINE,
    SETTING_OCR_ENGINE_PROBED_VERSION,
    probeCacheKey,
    resetOcrProbeForTests,
  } from '@/lib/warranty/ocr/onnx/probe';
  import { setOnnxSessionsForTests, type OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';
  import { drainOcrQueue, enqueueOcrJob, resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
  import { resetReceiptForReOcr } from '@/lib/warranty/items';
  import { receiptsDir } from '@/lib/warranty/receipts';
  import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
  import { solidRgb } from '../helpers/ocr-images';

  const DICT = ['', 'S', 'P', 'A', 'T', 'U', 'L', ' '];
  const WIDTH = 1400;
  const HEIGHT = 900;

  let current: TestDb | null = null;
  let dataDir: string;
  let originalDataDir: string | undefined;
  let storedFilename: string;

  function fakeSessions(over: Partial<OnnxOcrSessions> = {}): OnnxOcrSessions {
    const geometry = detResize(WIDTH, HEIGHT);
    return {
      runDet: async () => {
        const map = new Float32Array(geometry.resizeW * geometry.resizeH);
        for (let y = 10; y < 34; y += 1) for (let x = 10; x < 140; x += 1) map[y * geometry.resizeW + x] = 0.95;
        return { data: map, dims: [1, 1, geometry.resizeH, geometry.resizeW] };
      },
      runCls: async (input) => {
        const batch = input.dims[0];
        const data = new Float32Array(batch * 2);
        for (let n = 0; n < batch; n += 1) data[n * 2] = 0.99;
        return { data, dims: [batch, 2] };
      },
      runRec: async (input) => {
        const batch = input.dims[0];
        const steps = [1, 2, 3, 4, 5, 6, 3];
        const data = new Float32Array(batch * steps.length * DICT.length);
        for (let n = 0; n < batch; n += 1) {
          steps.forEach((cls, t) => {
            data[(n * steps.length + t) * DICT.length + cls] = 0.95;
          });
        }
        return { data, dims: [batch, steps.length, DICT.length] };
      },
      clsInputHeight: 80,
      clsInputWidth: 160,
      recClassCount: DICT.length,
      dictionary: DICT,
      ...over,
    };
  }

  function makeReceipt(): number {
    const db = (current as TestDb).db;
    const userId = insertTestUser(db);
    const itemId = Number(
      (
        db.get(sql`
          insert into warranty_items (name, created_by, created_at, updated_at)
          values ('Kitchen kit', ${userId}, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')
          returning id
        `) as { id: number }
      ).id,
    );
    return Number(
      (
        db.get(sql`
          insert into warranty_receipts
            (warranty_item_id, stored_filename, original_filename, mime, size_bytes, sha256, ocr_status, created_at)
          values (${itemId}, ${storedFilename}, 'receipt.png', 'image/png', 1, ${'a'.repeat(64)}, 'pending', '2026-08-18T00:00:00.000Z')
          returning id
        `) as { id: number }
      ).id,
    );
  }

  function statusOf(receiptId: number): { ocr_status: string; ocr_text: string | null; ocr_error: string | null } {
    return (current as TestDb).db.get(
      sql`select ocr_status, ocr_text, ocr_error from warranty_receipts where id = ${receiptId}`,
    ) as { ocr_status: string; ocr_text: string | null; ocr_error: string | null };
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-int-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    current = createSeededTestDb();
    resetOcrQueueForTests();
    resetOcrProbeForTests();
    setSetting(SETTING_OCR_ENGINE, 'onnx');
    setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
    fs.mkdirSync(receiptsDir(), { recursive: true });
    storedFilename = '00000000-0000-4000-8000-000000000001.png';
    fs.writeFileSync(
      path.join(receiptsDir(), storedFilename),
      await sharp(solidRgb(WIDTH, HEIGHT, [250, 250, 250]), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
        .png()
        .toBuffer(),
    );
  });

  afterEach(async () => {
    setOnnxSessionsForTests(null);
    await releaseOcrEngine();
    resetOcrQueueForTests();
    resetOcrProbeForTests();
    current?.cleanup();
    current = null;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('MUST-13.4: the whole engine path against a fake session set', () => {
    it('drains a pending receipt to done and indexes its text', async () => {
      setOnnxSessionsForTests(fakeSessions());
      const receiptId = makeReceipt();
      enqueueOcrJob({ kind: 'receipt', receiptId });
      await drainOcrQueue();
      const row = statusOf(receiptId);
      expect(row.ocr_status).toBe('done');
      expect(row.ocr_text).toContain('SPATULA');
      const hit = (current as TestDb).db.get(
        sql`select rowid as id from warranty_search where warranty_search match ${'"spatula"'}`,
      );
      expect(hit).toBeTruthy();
    });

    it('MUST-9.2: the unmodified re-run resets and re-reads on the same engine', async () => {
      setOnnxSessionsForTests(fakeSessions());
      const receiptId = makeReceipt();
      enqueueOcrJob({ kind: 'receipt', receiptId });
      await drainOcrQueue();
      resetReceiptForReOcr(receiptId);
      expect(statusOf(receiptId).ocr_status).toBe('pending');
      await drainOcrQueue();
      expect(statusOf(receiptId).ocr_status).toBe('done');
    });

    it('records a throwing session as failed with its message and leaves the index consistent', async () => {
      setOnnxSessionsForTests(
        fakeSessions({
          runRec: async () => {
            throw new Error('rec kernel exploded');
          },
        }),
      );
      const receiptId = makeReceipt();
      enqueueOcrJob({ kind: 'receipt', receiptId });
      await drainOcrQueue();
      const row = statusOf(receiptId);
      expect(row.ocr_status).toBe('failed');
      expect(row.ocr_error).toBe('rec kernel exploded');
      expect(row.ocr_text).toBeNull();
    });

    it('MUST-4.40: a session that never settles fails with the timeout message', async () => {
      const { OCR_TIMEOUT_MS } = await import('@/lib/warranty/ocr/engine');
      setOnnxSessionsForTests(fakeSessions({ runDet: () => new Promise(() => {}) }));
      const receiptId = makeReceipt();
      const started = Date.now();
      enqueueOcrJob({ kind: 'receipt', receiptId });
      // Do not wait the real two minutes: assert the race wiring by shrinking the wait with
      // a fake timer instead of the constant, which stays at its shipped value.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(OCR_TIMEOUT_MS).toBe(120_000);
      expect(Date.now() - started).toBeLessThan(OCR_TIMEOUT_MS);
      expect(OCR_TIMEOUT_MESSAGE).toBe('OCR timed out.');
    });
  });
  ```

  The last test as written proves only that the constant is unchanged. **Rewrite it during implementation to drive the race with `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS + 1)`, in the same shape `tests/lib/warranty/ocr/queue.test.ts`'s existing "Ruling P5" suite already uses, and assert three things: the row reaches `'failed'` with `OCR_TIMEOUT_MESSAGE`, and `releaseOcrEngine` was called exactly once (spy on the module namespace object, as `queue.test.ts` does).** Copy that suite's timer handling rather than inventing new handling; it already solves the ordering problem between the raced promise and the fake clock.

- [ ] **Step 2: Run to verify they fail.**

  ```powershell
  npx vitest run tests/app/about-panel.test.tsx tests/integration/ocr-engine.test.ts
  ```
  Expected: a type error on `AboutPanel`'s new prop and a missing warning.

- [ ] **Step 3: Add the Notice to `src/app/(app)/settings/about-panel.tsx`.**

  Give the component its prop, import `Notice`, and render the warning above the changelog list and below where the Updates card sits on the page. The copy ships **verbatim**, as plain text nodes, with no link and no `dangerouslySetInnerHTML`.

  ```tsx
  import { Notice } from '@/components/ui/Notice';
  import type { OcrEngineState } from '@/lib/warranty/ocr/onnx/probe';

  /** ISO to "YYYY-MM-DD HH:MM", which is all a household needs from a timestamp. */
  function whenChecked(probedAt: string | null): string {
    return probedAt === null ? 'an unknown date' : probedAt.slice(0, 16).replace('T', ' ');
  }

  export function AboutPanel({ ocr }: { ocr: OcrEngineState }) {
    const releases = loadChangelog();
    // Only when the probe actually fell back AND recorded a reason. Absence of a reason means
    // absence of a probe, not a silent failure.
    const fellBack = ocr.engine === 'tesseract' && ocr.detail !== null;

    return (
      <Card>
        <CardHeader ... />
        <CardBody>
          {fellBack ? (
            <Notice tone="warning" title="This machine cannot run the new receipt reader." className="mb-4">
              <p>
                Budget Tracker checked once, when version 1.5.0 first read a receipt here, and the check did not
                survive. It has gone back to the older reader that shipped before 1.5.0. Receipts still upload and are
                still read, just less accurately.
              </p>
              <p>
                There is nothing to fix. This is a limitation of the processor in this machine, not a setting, and the
                check will run again by itself the next time you update.
              </p>
              <p>
                Recorded reason: {ocr.detail}, checked on {whenChecked(ocr.probedAt)}.
              </p>
            </Notice>
          ) : null}
          {/* ... the existing changelog rendering, unchanged ... */}
        </CardBody>
      </Card>
    );
  }
  ```

  The literal `1.5.0` in the copy is the release this warning describes and it is correct as written; do not interpolate `APP_VERSION`, because a household reading this after a later upgrade needs to know which release introduced the new reader, not which one they are running.

- [ ] **Step 4: Pass the state from `src/app/(app)/settings/page.tsx`.**

  ```tsx
  import { readOcrEngineState } from '@/lib/warranty/ocr/onnx/probe';
  ```

  and at the bottom of the component:

  ```tsx
        {/* Last: the version and revision log are reference material, not a task. */}
        <AboutPanel ocr={readOcrEngineState()} />
  ```

  `page.tsx` already carries `export const dynamic = 'force-dynamic'`, so the read happens per request and needs nothing else. This is a server component, so importing from `onnx/probe` is allowed; MUST-2.2 governs `'use client'` files only, and `tests/ops/ocr-egress.test.ts` enforces exactly that boundary.

- [ ] **Step 5: Run until green.**

  ```powershell
  npx vitest run tests/app/about-panel.test.tsx tests/integration/ocr-engine.test.ts tests/ops/ocr-egress.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 6: Commit.**

  ```powershell
  git add src/app/(app)/settings/about-panel.tsx src/app/(app)/settings/page.tsx tests/app/about-panel.test.tsx tests/integration/ocr-engine.test.ts
  git commit -m "feat(ocr): say so once, on Settings, when the machine cannot run the new reader

The warning appears on Settings, About and nowhere else. It is an install-level
fact an admin can do nothing about and it is permanent for the life of the
hardware, so a banner every household member saw on every upload would be a
permanent apology for something nobody can act on. It names no library: the
vocabulary is the new receipt reader and the older reader, because a household
has no context to act on a library name. The recorded reason renders as a text
node, and a test proves injected markup arrives literally.

The integration walk runs the whole engine path against a fake session set, so
it loads no model: a pending receipt reaches done with its text in the search
index, the existing re-run button resets and re-reads it on the same engine
without that action being touched, and a throwing session records the failure
against the row instead of anywhere else."
  ```

---

# Phase 3: The browser scanner

Tasks 10 and 11 depend only on Task 1 (the dependencies) and Task 2 (the `SCANNER_*` constants). They can run in parallel with Tasks 3 to 9.

## Task 10: `public/scanner/` vendoring, `src/lib/scanner/load.ts`, the CSP token and the ops guards

**Context:** Spec §8.1, §8.2, §8.6, §10.4's guard step, §13.4's `scanner-assets.test.ts`, `no-viewfinder.test.ts` and `csp.test.ts` bullets, §15 items 21, 22, 23, §17.7, §17.9, R6, R14. Implements **MUST-8.1 … MUST-8.10, MUST-11.5**.

MUST-8.9 is a blocker, not a hardening nicety. Chromium enforces CSP on WebAssembly compilation: without `'wasm-unsafe-eval'` or the far broader `'unsafe-eval'`, `WebAssembly.instantiate` throws and OpenCV.js never initialises. Android Chrome is the primary target device for this feature. `'wasm-unsafe-eval'` permits WebAssembly compilation and nothing else; it does not re-enable `eval` or `new Function`, which is why it exists as a separate token.

R6 is why the CSP gets its own test rather than being left to a manual pass: the scanner's failure is silent by design (MUST-8.15), so a CSP that quietly blocked WASM would look exactly like a scanner that found no paper.

**Files:**
- Create: `scripts/vendor-scanner-assets.mjs`
- Create: `src/lib/scanner/load.ts`
- Modify: `src/lib/auth/security-headers.ts`
- Modify: `.gitignore`
- Create: `tests/ops/scanner-assets.test.ts`
- Create: `tests/ops/no-viewfinder.test.ts`
- Create: `tests/ops/csp.test.ts`

**Interfaces:**
- Consumes: `SCANNER_LOAD_TIMEOUT_MS` from `@/lib/warranty/ocr/onnx/constants` (Task 2).
- Produces:
  ```ts
  // src/lib/scanner/load.ts
  export interface JscanifyLike {
    findPaperContour(image: unknown): unknown;
    getCornerPoints(contour: unknown): {
      topLeftCorner: { x: number; y: number };
      topRightCorner: { x: number; y: number };
      bottomLeftCorner: { x: number; y: number };
      bottomRightCorner: { x: number; y: number };
    };
    extractPaper(canvas: HTMLCanvasElement, width: number, height: number, points?: unknown): HTMLCanvasElement;
  }
  export function loadScanner(): Promise<{ cv: unknown; scanner: JscanifyLike }>;
  export function resetScannerLoaderForTests(): void;
  ```
  Task 11's `scan.ts` calls `loadScanner()`; Task 11's uploader test stubs the whole module.

### Steps

- [ ] **Step 1: Write `scripts/vendor-scanner-assets.mjs` (MUST-8.4, MUST-8.5, MUST-8.6).**

  ```js
  /**
   * Copies the browser scanner's runtime files out of node_modules into public/scanner/.
   * Performs NO network access: it only copies files npm already installed. Run by
   * `npm run vendor-scanner-assets`, by the Dockerfile's builder stage before `npm run build`,
   * and by the release workflow's guard job.
   *
   * public/scanner/ is generated and gitignored, unlike the models under vendor/, which are
   * committed. The models come from ModelScope, which the build must not depend on; these
   * come from npm, which it already does.
   */
  import fs from 'node:fs';
  import path from 'node:path';

  const ROOT = path.resolve(import.meta.dirname, '..');
  const OPENCV_DIST = path.join(ROOT, 'node_modules', '@techstark', 'opencv-js', 'dist');
  const JSCANIFY = path.join(ROOT, 'node_modules', 'jscanify', 'dist', 'jscanify.min.js');
  const OUT = path.join(ROOT, 'public', 'scanner');
  const INLINED_GLUE_MIN_BYTES = 8_000_000;

  function fail(message, listing) {
    console.error(message);
    if (listing) {
      console.error(`\nWhat is actually in ${OPENCV_DIST}:`);
      for (const entry of listing) console.error(`  ${entry}`);
    }
    console.error(
      '\nTwo shapes are accepted:\n' +
        '  1. dist/opencv.js plus exactly one sibling .wasm file\n' +
        `  2. dist/opencv.js alone, at least ${INLINED_GLUE_MIN_BYTES} bytes, meaning the wasm is base64-inlined\n` +
        'Anything else is an upstream layout change and needs a look before it ships.',
    );
    process.exit(1);
  }

  if (!fs.existsSync(OPENCV_DIST)) fail(`${OPENCV_DIST} does not exist. Run npm ci first.`);
  const listing = fs.readdirSync(OPENCV_DIST);
  const glue = path.join(OPENCV_DIST, 'opencv.js');
  if (!listing.includes('opencv.js')) fail('opencv.js is missing from the opencv-js dist directory.', listing);

  const wasmFiles = listing.filter((entry) => entry.endsWith('.wasm'));
  const glueBytes = fs.statSync(glue).size;
  if (wasmFiles.length > 1) fail(`Found ${wasmFiles.length} .wasm files; exactly one is expected.`, listing);
  if (wasmFiles.length === 0 && glueBytes < INLINED_GLUE_MIN_BYTES) {
    fail(`No .wasm file, and opencv.js is only ${glueBytes} bytes, which is too small to be an inlined build.`, listing);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const copied = [];
  function copy(from, to) {
    fs.copyFileSync(from, to);
    copied.push(`${to} (${fs.statSync(to).size} bytes)`);
  }

  copy(glue, path.join(OUT, 'opencv.js'));
  // Keep the upstream filename: the glue resolves its wasm by that name through locateFile.
  for (const entry of wasmFiles) copy(path.join(OPENCV_DIST, entry), path.join(OUT, entry));
  if (!fs.existsSync(JSCANIFY)) fail(`${JSCANIFY} does not exist. Run npm ci first.`);
  copy(JSCANIFY, path.join(OUT, 'jscanify.min.js'));

  for (const line of copied) console.log(`wrote ${line}`);
  console.log(`scanner assets ok (${copied.length} files)`);
  ```

- [ ] **Step 2: Run it and see what upstream actually ships (§17.7's assumption, checked).**

  ```powershell
  npm run vendor-scanner-assets
  Get-ChildItem public/scanner | Select-Object Name,Length
  ```
  Expected: `opencv.js`, one `.wasm` and `jscanify.min.js`, roughly 9 MB in total. **If it exits nonzero, the directory listing it prints is the answer; adjust the script to the shape that is actually there and note the real layout in the task report.** That is the script working as designed, not a failure of the plan.

- [ ] **Step 3: Add the gitignore entry (MUST-8.7).** Append to `.gitignore`, beside the other generated paths:

  ```
  /public/scanner/
  ```

- [ ] **Step 4: Write the failing tests.**

  Create `tests/ops/csp.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { securityHeaders } from '@/lib/auth/security-headers';

  const csp = (nonce?: string) => securityHeaders(nonce)['Content-Security-Policy'];

  describe("MUST-8.9 / AC11: script-src gains 'wasm-unsafe-eval' and nothing else", () => {
    it("contains 'wasm-unsafe-eval' with and without a nonce", () => {
      expect(csp()).toContain("'wasm-unsafe-eval'");
      expect(csp('abc123')).toContain("'wasm-unsafe-eval'");
    });

    it("never contains the far broader 'unsafe-eval'", () => {
      for (const policy of [csp(), csp('abc123')]) {
        expect(policy).not.toMatch(/(?<!wasm-)'unsafe-eval'/);
      }
    });

    it('adds the token to script-src, not to some other directive', () => {
      const scriptSrc = csp('abc123')
        .split('; ')
        .find((directive) => directive.startsWith('script-src '));
      expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    });

    it('the nonce branch still works', () => {
      expect(csp('abc123')).toContain("'nonce-abc123'");
      expect(csp()).not.toContain('nonce-');
    });

    it('every other directive is untouched', () => {
      const policy = csp('abc123');
      for (const directive of [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ]) {
        expect(policy).toContain(directive);
      }
    });

    it('the reason the token is there is written down beside it', () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/security-headers.ts'), 'utf8');
      expect(source).toMatch(/WebAssembly/);
      expect(source).toMatch(/does not re-enable/);
    });
  });
  ```

  Create `tests/ops/no-viewfinder.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';
  import { securityHeaders } from '@/lib/auth/security-headers';

  const ROOT = process.cwd();

  function walk(dir: string): string[] {
    const full = path.join(ROOT, dir);
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return walk(relative);
      return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
    });
  }

  describe('MUST-8.1 / MUST-8.3 / AC11 / risk R14: there is no viewfinder', () => {
    it('getUserMedia and mediaDevices appear nowhere under src/', () => {
      const offenders = walk('src').filter((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        return source.includes('getUserMedia') || source.includes('mediaDevices');
      });
      expect(offenders).toEqual([]);
    });

    it('Permissions-Policy still denies the camera', () => {
      expect(securityHeaders()['Permissions-Policy']).toContain('camera=()');
    });

    it('the file input still hands off to the phone camera app', () => {
      const source = fs.readFileSync(path.join(ROOT, 'src/components/warranty/ReceiptUploader.tsx'), 'utf8');
      expect(source).toContain('capture="environment"');
      expect(source).toContain('accept="image/*,application/pdf"');
    });
  });
  ```

  Create `tests/ops/scanner-assets.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import path from 'node:path';

  const ROOT = process.cwd();
  const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

  describe('MUST-8.4 / MUST-8.7: the vendoring script', () => {
    const source = read('scripts/vendor-scanner-assets.mjs');

    it('performs no network access', () => {
      expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
      expect(source).not.toMatch(/https?:\/\//);
    });

    it('accepts exactly the two documented dist shapes and prints the listing on anything else', () => {
      expect(source).toContain('INLINED_GLUE_MIN_BYTES');
      expect(source).toContain("entry.endsWith('.wasm')");
      expect(source).toContain('Two shapes are accepted');
      expect(source).toMatch(/wasmFiles\.length > 1/);
    });

    it('is wired to an npm script and to nothing that runs on install', () => {
      const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
      expect(pkg.scripts['vendor-scanner-assets']).toBe('node scripts/vendor-scanner-assets.mjs');
      for (const hook of ['postinstall', 'prepare']) {
        expect(pkg.scripts[hook] ?? '').not.toContain('vendor-scanner-assets');
      }
    });
  });

  describe('MUST-8.7: public/scanner is generated, not committed', () => {
    it('is listed in .gitignore', () => {
      expect(read('.gitignore').split(/\r?\n/).map((line) => line.trim())).toContain('/public/scanner/');
    });
  });

  describe('MUST-11.5: the scanner loads nothing off-origin', () => {
    it('src/lib/scanner names no CDN host', () => {
      for (const entry of fs.readdirSync(path.join(ROOT, 'src/lib/scanner'))) {
        const source = read(path.posix.join('src/lib/scanner', entry));
        for (const host of ['docs.opencv.org', 'cdn.jsdelivr.net', 'unpkg.com']) {
          expect(source).not.toContain(host);
        }
      }
    });

    it('every script the loader injects is a same-origin /scanner/ path', () => {
      const source = read('src/lib/scanner/load.ts');
      expect(source).toContain("'/scanner/opencv.js'");
      expect(source).toContain("'/scanner/jscanify.min.js'");
      expect(source).not.toMatch(/src\s*=\s*['"`]https?:/);
    });
  });
  ```

- [ ] **Step 5: Run to verify they fail.**

  ```powershell
  npx vitest run tests/ops/csp.test.ts tests/ops/no-viewfinder.test.ts tests/ops/scanner-assets.test.ts
  ```
  Expected: the CSP token assertions fail; `scanner-assets.test.ts` fails on the missing `src/lib/scanner/load.ts`; `no-viewfinder.test.ts` passes already, which is the point of writing it now rather than later.

- [ ] **Step 6: Amend `src/lib/auth/security-headers.ts` (MUST-8.9).**

  ```ts
  /**
   * script-src carries a per-request nonce (set by src/middleware.ts) so modern browsers
   * run only nonce-tagged scripts. 'unsafe-inline' stays alongside it purely as a legacy
   * fallback: CSP2+ browsers ignore 'unsafe-inline' whenever a nonce is present in the
   * same directive, so this only weakens the policy for browsers old enough to not
   * understand nonces at all.
   *
   * 'wasm-unsafe-eval' is required by the receipt scanner. Chromium enforces CSP on
   * WebAssembly compilation, so without it WebAssembly.instantiate throws and the scanner
   * never initialises on Android Chrome, which is its primary device. The token permits
   * WebAssembly compilation and nothing else: it does not re-enable eval or new Function,
   * which is exactly why it exists separately from 'unsafe-eval'.
   */
  function buildCsp(nonce?: string): string {
    const scriptSrc = nonce
      ? `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' 'wasm-unsafe-eval'`
      : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";
    // ... the rest of the array is unchanged ...
  }
  ```

  `Permissions-Policy` keeps `camera=()`. It costs nothing, because the file input's capture handoff is not governed by it, and it mechanically stops a future contributor adding a viewfinder without noticing why there is not one.

- [ ] **Step 7: Write `src/lib/scanner/load.ts` (MUST-8.8, MUST-8.10).**

  ```ts
  import { SCANNER_LOAD_TIMEOUT_MS } from '@/lib/warranty/ocr/onnx/constants';

  /**
   * jscanify 1.4.3's surface, as much of it as the scanner uses. The names are documented but
   * were not verified against the published bundle during design, so scan.ts wraps every call
   * in the catch-all that turns a wrong-name TypeError into an original-file upload.
   */
  export interface JscanifyLike {
    findPaperContour(image: unknown): unknown;
    getCornerPoints(contour: unknown): {
      topLeftCorner: { x: number; y: number };
      topRightCorner: { x: number; y: number };
      bottomLeftCorner: { x: number; y: number };
      bottomRightCorner: { x: number; y: number };
    };
    extractPaper(canvas: HTMLCanvasElement, width: number, height: number, points?: unknown): HTMLCanvasElement;
  }

  interface CvLike {
    onRuntimeInitialized?: () => void;
  }

  interface ScannerWindow extends Window {
    Module?: { locateFile: (file: string) => string };
    cv?: CvLike;
    jscanify?: new () => JscanifyLike;
  }

  let cached: Promise<{ cv: unknown; scanner: JscanifyLike }> | null = null;

  export function resetScannerLoaderForTests(): void {
    cached = null;
  }

  function injectScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const element = document.createElement('script');
      element.src = src;
      element.async = true;
      element.onload = () => resolve();
      element.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(element);
    });
  }

  async function load(): Promise<{ cv: unknown; scanner: JscanifyLike }> {
    const scope = window as ScannerWindow;
    // Set BEFORE injecting the glue: it resolves its .wasm relative to this hook, and without
    // it the fetch goes to the page's own path and 404s.
    scope.Module = { locateFile: (file: string) => `/scanner/${file}` };
    await injectScript('/scanner/opencv.js');
    const cv = scope.cv;
    if (cv === undefined) throw new Error('opencv.js loaded without defining cv');
    await new Promise<void>((resolve) => {
      if (typeof cv.onRuntimeInitialized === 'undefined') {
        resolve();
        return;
      }
      cv.onRuntimeInitialized = () => resolve();
    });
    await injectScript('/scanner/jscanify.min.js');
    const Jscanify = scope.jscanify;
    if (Jscanify === undefined) throw new Error('jscanify.min.js loaded without defining jscanify');
    return { cv, scanner: new Jscanify() };
  }

  /**
   * One module-level cached promise. Called ONLY from the uploader's first image pick, never
   * at module scope and never on page load, so a household member who never uploads a photo
   * never downloads 9 MB.
   */
  export function loadScanner(): Promise<{ cv: unknown; scanner: JscanifyLike }> {
    if (cached !== null) return cached;
    cached = Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('scanner load timed out')), SCANNER_LOAD_TIMEOUT_MS);
      }),
    ]).catch((error: unknown) => {
      // A failed load must not poison every later pick with a cached rejection: the next pick
      // gets a fresh attempt, and MUST-8.15 means a failure costs nothing but a plain upload.
      cached = null;
      throw error;
    });
    return cached;
  }
  ```

- [ ] **Step 8: Run until green.**

  ```powershell
  npx vitest run tests/ops/csp.test.ts tests/ops/no-viewfinder.test.ts tests/ops/scanner-assets.test.ts tests/middleware.test.ts tests/lib/auth/csrf.test.ts
  npx tsc --noEmit
  ```
  Expected: green, including the two existing suites that read the security headers.

- [ ] **Step 9: Commit.**

  ```powershell
  git add scripts/vendor-scanner-assets.mjs src/lib/scanner/load.ts src/lib/auth/security-headers.ts .gitignore tests/ops/csp.test.ts tests/ops/no-viewfinder.test.ts tests/ops/scanner-assets.test.ts
  git commit -m "feat(scanner): self-host OpenCV and jscanify, and let the browser compile wasm

script-src gains 'wasm-unsafe-eval'. Chromium enforces the policy on
WebAssembly compilation, so without it the scanner never starts on Android
Chrome, which is the device this feature is for. The token permits compilation
and nothing else; it does not re-enable eval. A test pins that it is present
and that the broad token is not, because the scanner's failure is silent by
design and a CSP that quietly blocked wasm would look identical to a scanner
that found no paper.

The two bundles are copied out of node_modules into public/scanner/ by a script
that touches no network, fails the build with the actual directory listing if
the upstream layout changes, and is gitignored rather than committed: these
come from npm, which the build already depends on, unlike the models.

The loader sets locateFile before injecting the glue, because otherwise the
wasm fetch goes to the page's own path and 404s, and it is called only on the
first image pick, so anyone who never uploads a photo never downloads 9 MB.
No getUserMedia anywhere, camera=() stays, and a test enforces both."
  ```

---

## Task 11: `src/lib/scanner/scan.ts`, `ReceiptScanPreview.tsx` and the uploader state machine

**Context:** Spec §8.3 in full, §13.5's `receipt-scanner.test.tsx` bullet, §13.7 item 3, §15 items 16 to 20, R5. Implements **MUST-8.11 … MUST-8.17**.

**The rule above all the others: an upload is never blocked by the scanner.** Every failure path uploads the original file, unchanged, with no error shown and one `console.debug` line. The failure of an assistive crop is not a failure the owner needs to hear about, and the server-side preprocessing then does what it would have done in a world without a scanner.

jsdom has no WebAssembly, no canvas rasteriser and no `OffscreenCanvas`, so every test here stubs `loadScanner`. The tests prove the state machine and every fallback path and prove nothing about whether jscanify finds a receipt on a countertop. That is acceptance step A5's job and §13.7 says so rather than pretending otherwise.

**Files:**
- Create: `src/lib/scanner/scan.ts`
- Create: `src/components/warranty/ReceiptScanPreview.tsx`
- Modify: `src/components/warranty/ReceiptUploader.tsx`
- Create: `tests/app/receipt-scanner.test.tsx`

**Interfaces:**
- Consumes: `loadScanner`, `JscanifyLike` from `@/lib/scanner/load` (Task 10); the `SCANNER_*` constants from `@/lib/warranty/ocr/onnx/constants` (Task 2); `MAX_RECEIPT_BYTES` from `@/lib/warranty/receipts`.
- Produces:
  ```ts
  // src/lib/scanner/scan.ts
  export interface ScanQuad {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
  }
  export interface ScanResult {
    /** The file to upload. Either the corrected JPEG or, on any failure, the original. */
    file: File;
    /** Present only when a crop actually happened. */
    corrected?: { url: string; quad: ScanQuad; sourceWidth: number; sourceHeight: number };
  }
  /** PURE: MUST-8.13's five conditions. */
  export function isUsableQuad(quad: ScanQuad, workWidth: number, workHeight: number): boolean;
  /** Never throws and never rejects. */
  export function scanReceiptFile(file: File): Promise<ScanResult>;
  ```
  ```tsx
  // src/components/warranty/ReceiptScanPreview.tsx
  export function ReceiptScanPreview(props: {
    originalUrl: string;
    correctedUrl: string;
    quad: ScanQuad;
    sourceWidth: number;
    sourceHeight: number;
    secondsLeft: number;
    onUseThis: () => void;
    onUseOriginal: () => void;
  }): React.ReactElement;
  ```
  `ReceiptUploader`'s exported props, `StagedFile`, `SuggestedFieldsDto`, `POLL_INTERVAL_MS`, `POLL_GIVE_UP_MS`, `POLL_GIVE_UP_MESSAGE` and `READING_MESSAGE` are all **unchanged**.

### Steps

- [ ] **Step 1: Write the failing test.**

  Create `tests/app/receipt-scanner.test.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
  import { cleanup, fireEvent, render, screen } from '@testing-library/react';
  import { SCANNER_AUTO_ACCEPT_MS } from '@/lib/warranty/ocr/onnx/constants';
  import { ReceiptUploader } from '@/components/warranty/ReceiptUploader';
  import * as scanModule from '@/lib/scanner/scan';

  const CORRECTED = new File(['corrected-bytes'], 'receipt.jpg', { type: 'image/jpeg' });

  function stageResponse(mime = 'image/jpeg', name = 'receipt.jpg') {
    return {
      ok: true,
      json: async () => ({
        staged: [{ stagingId: 's1', originalFilename: name, mime, sizeBytes: 12, sha256: 'a'.repeat(64) }],
      }),
    } as Response;
  }

  function quad() {
    return {
      topLeft: { x: 10, y: 10 },
      topRight: { x: 90, y: 12 },
      bottomRight: { x: 92, y: 90 },
      bottomLeft: { x: 8, y: 88 },
    };
  }

  let urls = 0;
  const revoked: string[] = [];

  beforeEach(() => {
    urls = 0;
    revoked.length = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => {
      urls += 1;
      return `blob:mock-${urls}`;
    });
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function pick(container: HTMLElement, files: File[]): void {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  }

  describe('MUST-8.11: the state machine between the pick and the upload', () => {
    it('sends a PDF straight to upload with the original file and never calls the scanner', async () => {
      const spy = vi.spyOn(scanModule, 'scanReceiptFile');
      const fetchMock = vi.fn().mockResolvedValue(stageResponse('application/pdf', 'manual.pdf'));
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      const pdf = new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' });
      pick(container, [pdf]);
      await screen.findByText('manual.pdf');
      expect(spy).not.toHaveBeenCalled();
      const body = fetchMock.mock.calls[0][1].body as FormData;
      expect(body.getAll('file')[0]).toBe(pdf);
    });

    it('renders both panes and a countdown for an image with a valid quad', async () => {
      vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
        file: CORRECTED,
        corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stageResponse()));
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
      expect(await screen.findByTestId('scan-preview-original')).toBeTruthy();
      expect(screen.getByTestId('scan-preview-corrected')).toBeTruthy();
      expect(screen.getByText(/Using the straightened photo in \d seconds?/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Use this' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Use the original' })).toBeTruthy();
    });

    it('uploads the corrected blob when the countdown expires', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
        file: CORRECTED,
        corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
      });
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
      await vi.waitFor(() => expect(screen.queryByTestId('scan-preview-original')).toBeTruthy());
      await vi.advanceTimersByTimeAsync(SCANNER_AUTO_ACCEPT_MS + 50);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(CORRECTED);
    });

    it('Use this uploads immediately and cancels the timer', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
        file: CORRECTED,
        corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
      });
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
      fireEvent.click(await screen.findByRole('button', { name: 'Use this' }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(SCANNER_AUTO_ACCEPT_MS * 2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Use the original uploads the untouched File by identity', async () => {
      vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
        file: CORRECTED,
        corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
      });
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);
      const original = new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' });
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [original]);
      fireEvent.click(await screen.findByRole('button', { name: 'Use the original' }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(original);
    });
  });

  describe('MUST-8.15: an upload is never blocked by the scanner', () => {
    it('a scan that returns the original uploads it with NO error rendered', async () => {
      const original = new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' });
      vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({ file: original });
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [original]);
      await screen.findByText('receipt.jpg');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByTestId('scan-preview-original')).toBeNull();
      expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(original);
    });

    it('a scan that rejects still uploads the original with no error rendered', async () => {
      const original = new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' });
      vi.spyOn(scanModule, 'scanReceiptFile').mockRejectedValue(new Error('wasm refused to compile'));
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [original]);
      await screen.findByText('receipt.jpg');
      expect(screen.queryByRole('alert')).toBeNull();
      expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(original);
    });
  });

  describe('MUST-8.16 / MUST-8.17: several files, and cleanup', () => {
    it('scans three images one after another and never concurrently', async () => {
      let live = 0;
      let peak = 0;
      vi.spyOn(scanModule, 'scanReceiptFile').mockImplementation(async (file) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 5));
        live -= 1;
        return { file };
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stageResponse()));
      const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(container, [
        new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
        new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
        new File(['c'], 'c.jpg', { type: 'image/jpeg' }),
      ]);
      await vi.waitFor(() => expect(scanModule.scanReceiptFile).toHaveBeenCalledTimes(3));
      expect(peak).toBe(1);
    });

    it('unmounting mid-preview revokes every preview URL and clears the countdown', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.spyOn(scanModule, 'scanReceiptFile').mockResolvedValue({
        file: CORRECTED,
        corrected: { url: 'blob:corrected', quad: quad(), sourceWidth: 100, sourceHeight: 100 },
      });
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);
      const view = render(<ReceiptUploader onStagedChange={vi.fn()} />);
      pick(view.container, [new File(['jpeg'], 'receipt.jpg', { type: 'image/jpeg' })]);
      await vi.waitFor(() => expect(screen.queryByTestId('scan-preview-original')).toBeTruthy());
      view.unmount();
      await vi.advanceTimersByTimeAsync(SCANNER_AUTO_ACCEPT_MS * 2);
      expect(revoked).toContain('blob:corrected');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('MUST-8.13: quad validation', () => {
    const work = { width: 100, height: 100 };

    it('accepts a plausible quad', () => {
      expect(scanModule.isUsableQuad(quad(), work.width, work.height)).toBe(true);
    });

    it('rejects a quad whose area is under a quarter of the frame', () => {
      expect(
        scanModule.isUsableQuad(
          {
            topLeft: { x: 10, y: 10 },
            topRight: { x: 40, y: 10 },
            bottomRight: { x: 40, y: 40 },
            bottomLeft: { x: 10, y: 40 },
          },
          work.width,
          work.height,
        ),
      ).toBe(false);
    });

    it('rejects a sliver whose short side is under 5 percent of the long side', () => {
      expect(
        scanModule.isUsableQuad(
          {
            topLeft: { x: 0, y: 0 },
            topRight: { x: 100, y: 0 },
            bottomRight: { x: 100, y: 3 },
            bottomLeft: { x: 0, y: 3 },
          },
          work.width,
          work.height,
        ),
      ).toBe(false);
    });

    it('rejects a non-convex quad', () => {
      expect(
        scanModule.isUsableQuad(
          {
            topLeft: { x: 0, y: 0 },
            topRight: { x: 100, y: 0 },
            bottomRight: { x: 40, y: 40 },
            bottomLeft: { x: 0, y: 100 },
          },
          work.width,
          work.height,
        ),
      ).toBe(false);
    });

    it('rejects a quad with a NaN corner', () => {
      expect(
        scanModule.isUsableQuad({ ...quad(), topRight: { x: Number.NaN, y: 10 } }, work.width, work.height),
      ).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  ```powershell
  npx vitest run tests/app/receipt-scanner.test.tsx
  ```
  Expected: `Failed to resolve import "@/lib/scanner/scan"`.

- [ ] **Step 3: Write `src/lib/scanner/scan.ts` (MUST-8.12, MUST-8.13, MUST-8.15).**

  ```ts
  import {
    SCANNER_JPEG_QUALITY,
    SCANNER_MIN_QUAD_AREA_RATIO,
    SCANNER_MIN_SIDE_RATIO,
    SCANNER_OUTPUT_MAX_PX,
    SCANNER_WORK_MAX_PX,
  } from '@/lib/warranty/ocr/onnx/constants';
  import { MAX_RECEIPT_BYTES } from '@/lib/warranty/receipts';
  import { loadScanner } from '@/lib/scanner/load';

  export interface ScanQuad {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
  }

  export interface ScanResult {
    file: File;
    corrected?: { url: string; quad: ScanQuad; sourceWidth: number; sourceHeight: number };
  }

  const corners = (quad: ScanQuad) => [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];

  /** MUST-8.13's five conditions, all of which must hold. A quad hugging the whole frame is
   *  the detector finding the photo's border; a sliver is a countertop edge. */
  export function isUsableQuad(quad: ScanQuad, workWidth: number, workHeight: number): boolean {
    const points = corners(quad);
    if (points.length !== 4) return false;
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;

    let cross = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % 4];
      const c = points[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (z === 0) continue;
      if (cross === 0) cross = Math.sign(z);
      else if (Math.sign(z) !== cross) return false;
    }

    let area = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % 4];
      area += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area) / 2 < workWidth * workHeight * SCANNER_MIN_QUAD_AREA_RATIO) return false;

    const minSide = Math.max(workWidth, workHeight) * SCANNER_MIN_SIDE_RATIO;
    for (let i = 0; i < 4; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % 4];
      if (Math.hypot(b.x - a.x, b.y - a.y) < minSide) return false;
    }
    return true;
  }

  function canvasOf(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', SCANNER_JPEG_QUALITY));
  }

  function jpegName(original: string): string {
    const stem = original.replace(/\.[^.]+$/, '');
    return `${stem.length > 0 ? stem : 'receipt'}.jpg`;
  }

  async function run(file: File): Promise<ScanResult> {
    if (!file.type.startsWith('image/')) return { file };
    const { scanner } = await loadScanner();

    const bitmap = await createImageBitmap(file);
    try {
      const workScale = Math.min(1, SCANNER_WORK_MAX_PX / Math.max(bitmap.width, bitmap.height));
      const workWidth = Math.max(1, Math.round(bitmap.width * workScale));
      const workHeight = Math.max(1, Math.round(bitmap.height * workScale));
      const work = canvasOf(workWidth, workHeight);
      work.getContext('2d')?.drawImage(bitmap, 0, 0, workWidth, workHeight);

      const contour = scanner.findPaperContour(work);
      if (contour === null || contour === undefined) return { file };
      const points = scanner.getCornerPoints(contour);
      const workQuad: ScanQuad = {
        topLeft: points.topLeftCorner,
        topRight: points.topRightCorner,
        bottomRight: points.bottomRightCorner,
        bottomLeft: points.bottomLeftCorner,
      };
      if (!isUsableQuad(workQuad, workWidth, workHeight)) return { file };

      const back = (point: { x: number; y: number }) => ({ x: point.x / workScale, y: point.y / workScale });
      const fullQuad: ScanQuad = {
        topLeft: back(workQuad.topLeft),
        topRight: back(workQuad.topRight),
        bottomRight: back(workQuad.bottomRight),
        bottomLeft: back(workQuad.bottomLeft),
      };
      const side = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
      const meanWidth = (side(fullQuad.topLeft, fullQuad.topRight) + side(fullQuad.bottomLeft, fullQuad.bottomRight)) / 2;
      const meanHeight = (side(fullQuad.topLeft, fullQuad.bottomLeft) + side(fullQuad.topRight, fullQuad.bottomRight)) / 2;
      const outScale = Math.min(1, SCANNER_OUTPUT_MAX_PX / Math.max(meanWidth, meanHeight));
      const outWidth = Math.max(1, Math.round(meanWidth * outScale));
      const outHeight = Math.max(1, Math.round(meanHeight * outScale));

      const full = canvasOf(bitmap.width, bitmap.height);
      full.getContext('2d')?.drawImage(bitmap, 0, 0);
      const extracted = scanner.extractPaper(full, outWidth, outHeight);
      const blob = await toBlob(extracted);
      if (blob === null) return { file };
      // A crop that fails the size limit is not a crop, it is a rejected upload.
      if (blob.size > MAX_RECEIPT_BYTES) return { file };

      const corrected = new File([blob], jpegName(file.name), { type: 'image/jpeg' });
      return {
        file: corrected,
        corrected: {
          url: URL.createObjectURL(blob),
          quad: fullQuad,
          sourceWidth: bitmap.width,
          sourceHeight: bitmap.height,
        },
      };
    } finally {
      bitmap.close();
    }
  }

  /**
   * MUST-8.15: never throws, never rejects, and never blocks an upload. Every failure returns
   * the original file with one console.debug line. The failure of an assistive crop is not a
   * failure the owner needs to hear about, and the server-side pipeline then does exactly
   * what it would have done without a scanner.
   */
  export async function scanReceiptFile(file: File): Promise<ScanResult> {
    try {
      if (typeof WebAssembly === 'undefined') return { file };
      return await run(file);
    } catch (error) {
      console.debug('[scanner] falling back to the original file', error);
      return { file };
    }
  }
  ```

- [ ] **Step 4: Write `src/components/warranty/ReceiptScanPreview.tsx` (MUST-8.14).**

  ```tsx
  'use client';

  import type { ScanQuad } from '@/lib/scanner/scan';

  /**
   * The before and after pane. Each image is at most 160 pixels tall, matching the existing
   * receipt tiles. The countdown is visible for the whole four seconds, so nothing happens
   * without the owner having had the chance to see it; Use the original is framed as an undo
   * of something already decided rather than a step in a manual pipeline.
   */
  export function ReceiptScanPreview({
    originalUrl,
    correctedUrl,
    quad,
    sourceWidth,
    sourceHeight,
    secondsLeft,
    onUseThis,
    onUseOriginal,
  }: {
    originalUrl: string;
    correctedUrl: string;
    quad: ScanQuad;
    sourceWidth: number;
    sourceHeight: number;
    secondsLeft: number;
    onUseThis: () => void;
    onUseOriginal: () => void;
  }) {
    const outline = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
      .map((point) => `${point.x},${point.y}`)
      .join(' ');

    return (
      <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2/50 p-3">
        <div className="flex flex-wrap gap-3">
          <span className="relative inline-block" data-testid="scan-preview-original">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={originalUrl} alt="The photo you took" className="max-h-40 w-auto rounded-xs" />
            <svg
              viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              <polygon points={outline} fill="none" stroke="currentColor" strokeWidth={sourceWidth / 120} />
            </svg>
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={correctedUrl}
            alt="The straightened receipt"
            data-testid="scan-preview-corrected"
            className="max-h-40 w-auto rounded-xs"
          />
        </div>
        <p className="text-sm text-muted" role="status">
          Using the straightened photo in {secondsLeft} {secondsLeft === 1 ? 'second' : 'seconds'}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={onUseThis} className="btn btn--primary btn--sm">
            Use this
          </button>
          <button type="button" onClick={onUseOriginal} className="btn btn--secondary btn--sm">
            Use the original
          </button>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 5: Add the state machine to `src/components/warranty/ReceiptUploader.tsx`.**

  The whole machine lives between the input's `onChange` and the existing `upload()` call. **Nothing about staging, polling, suggestions or the Save button changes**, and `upload()` itself is not modified.

  ```tsx
  import { ReceiptScanPreview } from '@/components/warranty/ReceiptScanPreview';
  import { scanReceiptFile, type ScanQuad } from '@/lib/scanner/scan';
  import { SCANNER_AUTO_ACCEPT_MS } from '@/lib/warranty/ocr/onnx/constants';

  interface Pending {
    original: File;
    corrected: File;
    originalUrl: string;
    correctedUrl: string;
    quad: ScanQuad;
    sourceWidth: number;
    sourceHeight: number;
  }

  const COUNTDOWN_TICK_MS = 1000;
  ```

  Inside the component, beside the existing state:

  ```tsx
    const [scanning, setScanning] = useState(false);
    const [pending, setPending] = useState<Pending | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(0);
    // IMPORTANT 4's stale-closure reason applies here too: the unmount effect runs once with
    // empty deps, so it needs a ref to see whatever preview URLs exist AT UNMOUNT TIME.
    const previewUrlsRef = useRef<string[]>([]);
    const resolvePendingRef = useRef<((file: File) => void) | null>(null);
  ```

  Extend the existing unmount effect rather than adding a second one:

  ```tsx
    useEffect(
      () => () => {
        for (const timer of timers.current) clearInterval(timer);
        for (const file of filesRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
        resolvePendingRef.current = null;
      },
      // Cleanup on unmount only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );
  ```

  The countdown, which is also what auto-accepts:

  ```tsx
    useEffect(() => {
      if (pending === null) return;
      setSecondsLeft(Math.ceil(SCANNER_AUTO_ACCEPT_MS / COUNTDOWN_TICK_MS));
      const tick = setInterval(() => setSecondsLeft((left) => Math.max(0, left - 1)), COUNTDOWN_TICK_MS);
      const accept = setTimeout(() => resolvePendingRef.current?.(pending.corrected), SCANNER_AUTO_ACCEPT_MS);
      return () => {
        clearInterval(tick);
        clearTimeout(accept);
      };
    }, [pending]);
  ```

  The per-file decision, and the sequential loop:

  ```tsx
    function releasePreview(entry: Pending): void {
      for (const url of [entry.originalUrl, entry.correctedUrl]) {
        URL.revokeObjectURL(url);
        previewUrlsRef.current = previewUrlsRef.current.filter((value) => value !== url);
      }
    }

    async function decide(original: File): Promise<File> {
      if (!original.type.startsWith('image/')) return original;
      setScanning(true);
      let result;
      try {
        result = await scanReceiptFile(original);
      } catch {
        // scanReceiptFile is documented never to reject, and this is the belt for that brace:
        // an upload is never blocked by the scanner.
        return original;
      } finally {
        setScanning(false);
      }
      if (result.corrected === undefined) return result.file;

      const originalUrl = URL.createObjectURL(original);
      previewUrlsRef.current = [...previewUrlsRef.current, originalUrl, result.corrected.url];
      const entry: Pending = {
        original,
        corrected: result.file,
        originalUrl,
        correctedUrl: result.corrected.url,
        quad: result.corrected.quad,
        sourceWidth: result.corrected.sourceWidth,
        sourceHeight: result.corrected.sourceHeight,
      };
      const chosen = await new Promise<File>((resolve) => {
        resolvePendingRef.current = resolve;
        setPending(entry);
      });
      resolvePendingRef.current = null;
      setPending(null);
      releasePreview(entry);
      return chosen;
    }

    async function handlePicked(chosen: File[]): Promise<void> {
      // Sequentially, never in parallel: three simultaneous warps is how a mid-range Android
      // tab crashes.
      for (const original of chosen) {
        const file = await decide(original);
        await upload([file]);
      }
    }
  ```

  The input's `onChange` calls `void handlePicked(chosen)` in place of `void upload(chosen)`; everything else about that handler, including the `event.target.value = ''` reset and its CRITICAL-fix comment, is unchanged.

  Render the two new pieces above the existing tile list:

  ```tsx
        {scanning ? (
          <p className="text-sm text-muted" role="status">
            Finding the receipt…
          </p>
        ) : null}
        {pending !== null ? (
          <ReceiptScanPreview
            originalUrl={pending.originalUrl}
            correctedUrl={pending.correctedUrl}
            quad={pending.quad}
            sourceWidth={pending.sourceWidth}
            sourceHeight={pending.sourceHeight}
            secondsLeft={secondsLeft}
            onUseThis={() => resolvePendingRef.current?.(pending.corrected)}
            onUseOriginal={() => resolvePendingRef.current?.(pending.original)}
          />
        ) : null}
  ```

  **Note the behaviour change this introduces on multi-file picks:** today all files go in one `upload()` call and therefore one stage POST; with the scanner they go one at a time. That is required by MUST-8.16's sequential rule and by the preview showing one file at a time in pick order. The stage route accepts one file per request perfectly well, `MAX_FILES_PER_UPLOAD` still bounds the pick, and `tests/components/ReceiptUploader.test.tsx`'s existing single-file tests are unaffected. Run that file and confirm.

- [ ] **Step 6: Run until green.**

  ```powershell
  npx vitest run tests/app/receipt-scanner.test.tsx tests/components/ReceiptUploader.test.tsx tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx
  npx vitest run tests/ops/scanner-assets.test.ts tests/ops/no-viewfinder.test.ts tests/ops/ocr-egress.test.ts
  npx tsc --noEmit
  ```
  Expected: green. `ocr-egress.test.ts` now scans `src/lib/scanner/` as well and its MUST-2.2 assertion covers the two new client files.

- [ ] **Step 7: Commit.**

  ```powershell
  git add src/lib/scanner/scan.ts src/components/warranty/ReceiptScanPreview.tsx src/components/warranty/ReceiptUploader.tsx tests/app/receipt-scanner.test.tsx
  git commit -m "feat(scanner): find the paper, straighten it, and never block the upload

After the phone's camera hands back a still, the browser finds the receipt,
straightens it and shows it beside the original with the outline drawn on. It
uploads on its own after four seconds with the countdown visible the whole
time, because the crop is right in the overwhelming majority of cases and a
mandatory tap taxes the common path. Use the original is an undo of something
already decided.

Every failure path uploads the untouched file with no error shown: a scanner
that could not load, wasm that would not compile, a quad that hugs the frame or
is a sliver, a crop over the size limit, or anything at all thrown anywhere
inside scan.ts. An assistive crop that did not happen is not news, and the
server-side pipeline then does what it would have done without a scanner.

Files are scanned one at a time. Three concurrent warps is how a mid-range
phone tab dies. jsdom has no wasm and no canvas rasteriser, so these tests
prove the state machine and every fallback and prove nothing about whether the
detector finds a receipt on a countertop; that is the manual pass."
  ```

---

# Phase 4: Ops and release

## Task 12: The Dockerfile, the asset guard, the release workflow and the ops assertions

**Context:** Spec §10 in full, §13.4's `docker.test.ts` and `check-ocr-assets.test.ts` bullets, §15 items 24, 25, R8. Implements **MUST-10.1 … MUST-10.11, MUST-10.14 … MUST-10.19**.

MUST-10.1's `rm -rf` is worth 204 MB. `onnxruntime-node` does not use per-platform optional dependencies the way `sharp` does; the single tarball carries native binaries for all five supported platforms and `npm ci` unpacks all of them regardless of target. Stripping in the **deps** stage means the builder and the runner both inherit the pruned tree. MUST-10.9 asserts the strip happened, because an un-stripped image is 204 MB heavier and nothing else tells anyone.

**Files:**
- Modify: `Dockerfile`
- Modify: `scripts/check-ocr-assets.mjs`
- Modify: `.github/workflows/release-image.yml`
- Modify: `tests/ops/docker.test.ts`
- Modify: `tests/scripts/check-ocr-assets.test.ts`
- Modify: `tests/ops/release-image.test.ts`

**Interfaces:**
- Consumes: the four filenames and four SHA256 constants from `@/lib/warranty/ocr/onnx/models` (Task 1), used by the **tests** to pin the script's duplicated literals. The script itself stays alias-free.
- Produces: no new code exports.

### Steps

- [ ] **Step 1: Amend the Dockerfile's deps stage (MUST-10.1, MUST-10.2).**

  ```dockerfile
  COPY package.json package-lock.json* ./
  # onnxruntime-node ships one tarball carrying native binaries for all five supported
  # platforms and npm ci unpacks all of them regardless of target: darwin/arm64 75 MB,
  # win32/arm64 67 MB, win32/x64 62 MB, none of which this container can execute. Stripping
  # here means the builder and the runner both inherit the pruned tree. Both linux binaries
  # stay in both architectures' images; dropping the non-target one needs TARGETARCH plumbing
  # for another 20 to 37 MB and is not worth a new failure mode in this release.
  RUN npm ci \
      && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
                node_modules/onnxruntime-node/bin/napi-v6/win32
  ```

- [ ] **Step 2: Amend the builder stage (MUST-10.3).**

  ```dockerfile
  COPY --from=deps /app/node_modules ./node_modules
  COPY . .
  # public/scanner/ is generated and gitignored, so it must exist before Next collects public/.
  RUN node scripts/vendor-scanner-assets.mjs
  RUN npm run build
  ```

- [ ] **Step 3: Add the four runner COPY lines (MUST-10.4), inside the existing OCR asset block and before the guard.**

  ```dockerfile
  # The ONNX runtime, its shared types package and sharp all load native binaries by path,
  # which Next's output tracing cannot know about, same reason as better-sqlite3 above.
  # vendor/ is already copied wholesale, so vendor/ocr-models/ arrives with no new line;
  # public/ is already copied, so public/scanner/ does; scripts/ is already copied, so
  # scripts/ocr-probe.mjs does. tests/ops/docker.test.ts asserts those three rather than
  # assuming them, because "it is already covered" is exactly the belief that produces a
  # missing asset in production.
  COPY --from=builder --chown=node:node /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
  COPY --from=builder --chown=node:node /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
  COPY --from=builder --chown=node:node /app/node_modules/sharp ./node_modules/sharp
  COPY --from=builder --chown=node:node /app/node_modules/@img ./node_modules/@img
  ```

  The guard line stays exactly where it is, after every COPY line it checks, and gains only the environment prefix Step 4's `IN_IMAGE` gate reads:

  ```dockerfile
  # A tracing miss must break `docker build`, not production (MUST-7.9, acceptance A3).
  # OCR_ASSETS_IN_IMAGE turns on the platform-strip assertion, which is only meaningful here.
  RUN OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs
  ```

  No change to the base image, the stage count, `USER node`, `VOLUME ["/data"]`, the healthcheck or the compiler toolchain's exclusion from the runner.

- [ ] **Step 4: Extend `scripts/check-ocr-assets.mjs` with three phases (MUST-10.7 … MUST-10.11).**

  Keep the existing four `REQUIRED` entries and its output shape (`ok   <path>` / `MISS <path>`), keep it alias-free, and keep every failure exiting nonzero with a message naming the Dockerfile block to look at.

  ```js
  const REQUIRED = [
    'vendor/tessdata/eng.traineddata.gz',
    'node_modules/tesseract.js-core',
    'node_modules/tesseract.js/src/worker-script/node/index.js',
    'node_modules/pdfjs-dist',
    'vendor/ocr-models/ch_PP-OCRv5_det_mobile.onnx',
    'vendor/ocr-models/en_PP-OCRv5_rec_mobile.onnx',
    'vendor/ocr-models/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
    'vendor/ocr-models/en_dict.txt',
    'node_modules/onnxruntime-node/bin/napi-v6',
    'scripts/ocr-probe.mjs',
  ];

  // Ruling P10a: duplicated from src/lib/warranty/ocr/onnx/models.ts on purpose, because this
  // script runs inside the runtime image where '@/...' does not resolve and src/ is not
  // present. tests/scripts/check-ocr-assets.test.ts pins these against the real constants, so
  // a drift fails the test suite rather than only failing a docker build weeks later.
  const MODEL_HASHES = {
    'vendor/ocr-models/ch_PP-OCRv5_det_mobile.onnx':
      '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
    'vendor/ocr-models/en_PP-OCRv5_rec_mobile.onnx':
      'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8',
    'vendor/ocr-models/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx':
      '54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7',
    // The same 64-hex literal as OCR_DICT_SHA256 in models.ts. Step 6's test pins them equal.
    'vendor/ocr-models/en_dict.txt': 'the-same-digest-as-OCR_DICT_SHA256',
  };

  // An un-stripped image is 204 MB heavier and nothing else tells anyone (MUST-10.1).
  const MUST_NOT_EXIST = [
    'node_modules/onnxruntime-node/bin/napi-v6/darwin',
    'node_modules/onnxruntime-node/bin/napi-v6/win32',
  ];

  const SCANNER_GLUE = 'public/scanner/opencv.js';
  const SCANNER_JSCANIFY = 'public/scanner/jscanify.min.js';
  const INLINED_GLUE_MIN_BYTES = 8_000_000;

  // A local `npm ci` leaves the darwin and win32 directories in place, so the strip assertion
  // is an image-build check only. The Dockerfile and the release workflow set this; a
  // developer running `npm run check-ocr-assets` still gets the other three phases.
  const IN_IMAGE = process.env.OCR_ASSETS_IN_IMAGE === '1';
  ```

  After the existing existence loop, add, in this order:

  1. **SHA256 verification** of the four model paths against `MODEL_HASHES`, printing `ok   <path> sha256` per file and failing with both hashes on a mismatch.
  2. **The strip assertion**, wrapped in `if (IN_IMAGE) { ... }`: each path in `MUST_NOT_EXIST` must not exist. The failure message says `the deps stage's rm -rf did not run (MUST-10.1); this image is about 204 MB heavier than it should be`.
  3. **The scanner assets**: `SCANNER_GLUE` and `SCANNER_JSCANIFY` exist, and either exactly one `.wasm` sits in `public/scanner/` or the glue is at least `INLINED_GLUE_MIN_BYTES`. One `ok` line per checked path.

  Keep the final summary line in the same shape, updated for the new count.

- [ ] **Step 5: Amend the release workflow (MUST-10.14, MUST-10.15, MUST-10.16).**

  In the `guard` job, between `npm ci` and the asset check:

  ```yaml
        # public/scanner/ is generated and gitignored, so the asset check below has nothing to
        # check until this runs.
        - name: Vendor the scanner assets
          run: node scripts/vendor-scanner-assets.mjs
  ```

  The `Check OCR assets are present` step keeps its name and its command; it now covers ten paths and three extra phases.

  In the `build` job, replace the comment above `Build and push` (MUST-10.16). The claim it makes is no longer true:

  ```yaml
        # better-sqlite3's native addon is compiled inside each target platform's image (the
        # deps stage already does this on amd64 and arm64 alike). onnxruntime-node is
        # different: it ships an architecture-specific native binary, and both architectures'
        # images now carry both linux ORT binaries while the darwin and win32 payloads are
        # stripped in the deps stage. Whether a given arm64 CPU can actually execute those
        # kernels is decided at run time by the compatibility probe and cannot be decided
        # here, which is why there is no emulated smoke test in this workflow.
  ```

  The platform list stays `linux/amd64,linux/arm64`. No new job.

- [ ] **Step 6: Amend the three ops tests.**

  In `tests/ops/docker.test.ts`, add to the existing `describe('Dockerfile', ...)` block. It already locates the runtime stage with `dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner')`; reuse that same slice.

  ```ts
    it('MUST-10.1 / MUST-10.2: the deps stage strips the darwin and win32 ORT binaries', () => {
      const depsStage = dockerfile.slice(
        dockerfile.indexOf('AS deps'),
        dockerfile.indexOf('AS builder'),
      );
      expect(depsStage).toMatch(/rm -rf[\s\S]*onnxruntime-node\/bin\/napi-v6\/darwin/);
      expect(depsStage).toMatch(/onnxruntime-node\/bin\/napi-v6\/win32/);
      // linux/x64 and linux/arm64 both stay, in both architectures' images.
      expect(depsStage).not.toMatch(/napi-v6\/linux/);
    });

    it('MUST-10.3: the builder vendors the scanner assets before it builds', () => {
      const builderStage = dockerfile.slice(
        dockerfile.indexOf('AS builder'),
        dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'),
      );
      expect(builderStage).toContain('scripts/vendor-scanner-assets.mjs');
      expect(builderStage.indexOf('vendor-scanner-assets.mjs')).toBeLessThan(
        builderStage.indexOf('npm run build'),
      );
    });

    it('MUST-10.4: the runner copies the ONNX runtime and sharp', () => {
      for (const needle of [
        'node_modules/onnxruntime-node ',
        'node_modules/onnxruntime-common ',
        'node_modules/sharp ',
        'node_modules/@img ',
      ]) {
        expect(runtimeStage).toContain(needle);
      }
    });

    it('MUST-10.4: vendor/, public/ and scripts/ are copied wholesale, so the models, the scanner and the probe arrive', () => {
      expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
      expect(runtimeStage).toMatch(/COPY .*\/app\/public \.\/public/);
      expect(runtimeStage).toMatch(/COPY .*\/app\/scripts \.\/scripts/);
    });

    it('MUST-10.5 / MUST-10.9: the asset guard runs after every COPY it checks, with the strip assertion on', () => {
      const guard = runtimeStage.indexOf('node scripts/check-ocr-assets.mjs');
      expect(runtimeStage).toContain('OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs');
      for (const needle of ['node_modules/tesseract.js-core', 'node_modules/onnxruntime-node ', 'node_modules/sharp ']) {
        expect(runtimeStage.indexOf(needle)).toBeLessThan(guard);
      }
    });

  ```

  The file's existing `it('...', ...)` that asserts `runtimeStage` contains the literal `RUN node scripts/check-ocr-assets.mjs` must be updated to `RUN OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs` in the same edit, or it fails. Keep its index comparison against `node_modules/tesseract.js-core` exactly as it is.

  ```ts

    it('MUST-5.14: the tesseract fallback is still in the image', () => {
      expect(runtimeStage).toContain('node_modules/tesseract.js ');
      expect(runtimeStage).toContain('node_modules/tesseract.js-core');
      expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
    });
  ```

  If the file names its runtime slice something other than `runtimeStage`, use whatever the existing tests use rather than introducing a second name.

  In `tests/scripts/check-ocr-assets.test.ts`, extend the existing "checks exactly the four paths" test to the ten paths, and add the pin against the real constants:

  ```ts
    it('MUST-10.8: its duplicated model hashes equal the ones models.ts pins (Ruling P10a)', () => {
      const source = fs.readFileSync(script, 'utf8');
      for (const hash of [DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256, OCR_DICT_SHA256]) {
        expect(source).toContain(hash);
      }
      const assets = resolveOnnxOcrAssets();
      for (const value of Object.values(assets)) {
        expect(source).toContain(path.relative(root, value).split(path.sep).join('/'));
      }
    });

    it('MUST-10.9: it asserts the darwin and win32 platform directories are gone', () => {
      const source = fs.readFileSync(script, 'utf8');
      expect(source).toContain('node_modules/onnxruntime-node/bin/napi-v6/darwin');
      expect(source).toContain('node_modules/onnxruntime-node/bin/napi-v6/win32');
      expect(source).toContain('MUST-10.1');
    });

    it('MUST-10.10: it checks the scanner assets and the two accepted wasm shapes', () => {
      const source = fs.readFileSync(script, 'utf8');
      expect(source).toContain('public/scanner/opencv.js');
      expect(source).toContain('public/scanner/jscanify.min.js');
      expect(source).toContain('INLINED_GLUE_MIN_BYTES');
    });

    it('exits 0 in a healthy checkout, covering all ten paths', () => {
      const result = run(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('en_dict.txt');
      expect(result.stdout).toContain('opencv.js');
    });
  ```

  Add the imports it needs: `DET_MODEL_SHA256, REC_MODEL_SHA256, CLS_MODEL_SHA256, OCR_DICT_SHA256, resolveOnnxOcrAssets` from `@/lib/warranty/ocr/onnx/models`. Its existing "exits non-zero and names the missing path when an asset is absent" test still passes, because the existence phase runs first and exits before the hashing phase.

  In `tests/ops/release-image.test.ts`, add:

  ```ts
    it('MUST-10.14: the guard vendors the scanner assets before it checks them', () => {
      const guardJob = workflow.slice(workflow.indexOf('  guard:'), workflow.indexOf('  build:'));
      expect(guardJob).toContain('node scripts/vendor-scanner-assets.mjs');
      expect(guardJob.indexOf('vendor-scanner-assets.mjs')).toBeLessThan(
        guardJob.indexOf('node scripts/check-ocr-assets.mjs'),
      );
    });

    it('MUST-10.16: the architecture comment tells the truth about onnxruntime-node', () => {
      expect(workflow).not.toContain('is architecture-neutral');
      expect(workflow).toMatch(/architecture-specific native binary/);
      expect(workflow).toMatch(/darwin and win32 payloads are\s*#?\s*stripped/);
      expect(workflow).toMatch(/decided at run time/);
    });

    it('MUST-10.17: still exactly two platforms and no emulated smoke-test job', () => {
      expect(workflow).toContain('linux/amd64,linux/arm64');
      expect(workflow).not.toContain('cortex-a53');
    });
  ```

- [ ] **Step 7: Run the ops suite and the guard for real.**

  ```powershell
  node scripts/vendor-scanner-assets.mjs
  node scripts/check-ocr-assets.mjs
  npx vitest run tests/ops/docker.test.ts tests/scripts/check-ocr-assets.test.ts tests/ops/release-image.test.ts
  npx tsc --noEmit
  ```
  Expected: the guard prints `ok` for all ten paths plus the hash and scanner phases, skips the strip phase locally (Step 4's `IN_IMAGE` gate), and exits 0. The three test files are green, including every assertion that was already in them.

  Change the Dockerfile's guard line so the strip phase does run inside the image:

  ```dockerfile
  RUN OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs
  ```

  and update `tests/ops/docker.test.ts`'s existing guard-position assertion, which currently matches the exact string `RUN node scripts/check-ocr-assets.mjs`, to the new command text. The release workflow's step keeps its plain command, because a CI runner's `node_modules` is not the image's.

- [ ] **Step 8: Build both architectures and record the sizes (MUST-10.18, AC7).**

  ```powershell
  docker buildx build --platform linux/amd64 -t budget-tracker:ocr-amd64 --load .
  docker buildx build --platform linux/arm64 -t budget-tracker:ocr-arm64 --load .
  docker image ls budget-tracker
  ```

  Compare against the previous release's figures and against §10.5's arithmetic: about 57 MB of ORT after the strip, 12.7 MB of models, about 12 MB of sharp plus `@img`, about 9 MB of `public/scanner/`, so **about 91 MB added per architecture**. AC7 allows 10 MB of slack. **Write both measured numbers into the task report**; Task 13 puts them in the release notes. If the delta is near 295 MB rather than 91 MB, the strip did not happen and MUST-10.9's guard is what should have caught it, so find out why it did not before going further.

  If Docker is unavailable in this environment, say so plainly in the task report and mark AC7 as owed rather than passed. Do not report an unmeasured number.

- [ ] **Step 9: Commit.**

  ```powershell
  git add Dockerfile scripts/check-ocr-assets.mjs .github/workflows/release-image.yml tests/ops/docker.test.ts tests/scripts/check-ocr-assets.test.ts tests/ops/release-image.test.ts
  git commit -m "build(ocr): strip 204 MB of unusable platform binaries and guard the rest

onnxruntime-node ships one tarball with native binaries for five platforms and
npm ci unpacks all of them. Three of those, 204 MB worth, can never run in this
container, so the deps stage removes them and both later stages inherit the
pruned tree. The asset guard then asserts inside the image that the removal
actually happened, because an un-stripped image is 204 MB heavier and silent.

The guard also SHA256-verifies the four vendored model files at image-build
time, which is the second of three checkpoints on a file whose corruption is
undetectable from its output, and checks that the generated scanner assets are
present in one of the two shapes upstream can ship.

The workflow comment claiming the OCR assets are architecture-neutral is
corrected. It was true of tesseract's wasm and language data and is not true of
a native ORT binary, which is the whole reason the run-time probe exists."
  ```

---

## Task 13: Release v1.5.0, the CHANGELOG, the documentation and the full gate

**Context:** Spec §14 in full, §3.4's README requirement, §10.5's size figures, R10's INSTALL note. **This is the only task that runs the full suite and the production build.**

**Files:**
- Modify: `package.json` (`version`)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `INSTALL.md`
- Modify: `tests/ops/docker.test.ts` (its existing version census)

**Interfaces:**
- Consumes: `src/lib/version.ts`, which imports `package.json`'s `version` at build time, and `src/lib/changelog.ts`, which reads `CHANGELOG.md` at request time. Settings, About needs **no** code change to render the new entry.
- Produces: no new code exports.

### Steps

- [ ] **Step 1: Rebase on the current version before changing anything.**

  ```powershell
  node -e "console.log('package.json version:', require('./package.json').version)"
  Select-String -Path .\CHANGELOG.md -Pattern '^## \[' | Select-Object -First 3
  git log --oneline -15
  ```

  **v1.4.0 is being built in parallel on this branch, so do not assume what you will find.** The task is **"ensure `package.json` reads `1.5.0` and `CHANGELOG.md` carries a dated `1.5.0` section above whatever the previous newest section is"**, not "bump from a particular number.

  - If the newest section is `## [1.4.0]`, this is a normal minor bump and the `1.5.0` section goes above it.
  - If v1.4.0 has not landed, `1.5.0` still ships as written, and the changelog's previous section is whatever is actually there. Do not renumber this release; the spec fixes it at 1.5.0 and §17.10 already considered the alternative.
  - Whatever the previous section number turns out to be, **use that number, not `1.4.0`, in the `changelog.slice(...)` bounds** of the census assertion in Step 5.

- [ ] **Step 2: Set `package.json`'s `version` to `1.5.0`.** It stays the single source of truth: `src/lib/version.ts` imports it at build time, the footer and Settings, About render it, `/api/health` reports it, the update check compares against it, and the OCR probe caches its verdict against it plus `process.arch`.

  **This changes the probe cache key**, which is the intended behaviour: every install re-probes exactly once on upgrade to 1.5.0, because there is no earlier verdict to inherit.

- [ ] **Step 3: Add the CHANGELOG section**, Keep-a-Changelog style, with a fresh empty `## Unreleased` left above it. Match the file's conventions exactly: `## [x.y.z] - YYYY-MM-DD` with a plain hyphen, `->` rather than an arrow glyph, and **no em dashes anywhere in this file**.

  ```markdown
  ## Unreleased

  ## [1.5.0] - 2026-08-18

  ### Changed

  - **Receipts are read by a new engine.** Photographs of receipts, which is what most
    receipts are, come back with far more of the text intact: the vendor, the date and the
    total are found where they were being missed before. Nothing about uploading changes and
    nothing you have already saved is touched. If you want an old receipt read again, the
    Re-run OCR button on its item does exactly that.
  - **A few machines cannot run the new engine.** Budget Tracker checks once, the first time
    it reads a receipt after this update, and goes back to the older engine if the check does
    not survive. Receipts still upload and are still read. Settings -> About says so, with the
    reason, when that happens. There is nothing to configure either way.

  ### Added

  - **Your phone straightens the receipt before it uploads.** Take the photo the way you
    already do and the browser finds the paper, squares it up and crops the counter out. It
    shows you the before and after for four seconds and then sends the straightened one; a
    button sends the original instead. If any of that fails, the original uploads and you are
    not told about it, because there is nothing you would do differently.
  - **The image is about 91 MB larger.** That is the recognition models, which ship inside the
    image so an install with no internet works exactly the same as one with it, plus the
    scanner your browser downloads once and caches.

  ### Fixed

  - The release workflow no longer claims the OCR assets are the same on every processor. They
    were, and now one of them is not.
  ```

  Copy is checked against MUST-5.18 by `tests/app/about-panel.test.tsx`, but the CHANGELOG is not a UI surface and this entry deliberately says "engine" rather than a library name for the same reason.

- [ ] **Step 4: Extend `README.md` and `INSTALL.md`.**

  1. **`README.md`, the OCR paragraph around line 28**: it currently says receipts are read by an OCR engine. Extend it with the model provenance MUST-3.14 requires, naming **PP-OCRv5, RapidOCR, PaddleOCR, Baidu and Apache-2.0** in one paragraph. This is a repository fact, not a product feature; nothing in the UI renders it.
  2. **`README.md`, the no-runtime-network-calls statement**: it already carries three opt-in exceptions. Add one sentence stating that this release adds **no** fourth: the recognition models ship inside the image, the scanner is served from the container under `/scanner/`, and nothing is fetched at run time.
  3. **`INSTALL.md`**: add the R10 recovery note beside the existing egress paragraph. Word it for an admin, not a developer:

     > If you restore a backup from one machine onto a second machine with a different
     > processor of the same architecture, and receipt reading then stops working, delete the
     > row whose key is `ocr.engine` from the `settings` table and upload one receipt. The app
     > checks the new machine and records the right answer. This is the one case the automatic
     > check cannot see for itself.

- [ ] **Step 5: Update the version census in `tests/ops/docker.test.ts`.** Its existing "keeps package.json and the newest changelog section on the same version" test should pass unchanged. Add beside the existing 1.3.1 assertion, using the **actual** previous section number found in Step 1 in place of `1.4.0`:

  ```ts
    it('MUST-14: the 1.5.0 release', () => {
      const pkg = JSON.parse(read('package.json')) as { version: string };
      expect(pkg.version).toBe('1.5.0');
      const changelog = read('CHANGELOG.md');
      expect(changelog).toMatch(/^## \[1\.5\.0\] - 2026-08-18$/m);
      // An empty Unreleased section is left in place for the next session.
      expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.5.0]'));
      const section = changelog.slice(changelog.indexOf('## [1.5.0]'), changelog.indexOf('## [1.4.0]'));
      expect(section).toContain('Re-run OCR');
      expect(section).not.toMatch(/PP-OCR|ONNX|tesseract/i);
    });

    it('MUST-3.14: README names the model provenance and no fourth egress destination', () => {
      const readme = read('README.md');
      for (const needle of ['PP-OCRv5', 'RapidOCR', 'PaddleOCR', 'Baidu', 'Apache-2.0']) {
        expect(readme).toContain(needle);
      }
      expect(readme).not.toContain('modelscope');
    });

    it('risk R10: INSTALL documents the one recovery the automatic check cannot do', () => {
      expect(read('INSTALL.md')).toContain('ocr.engine');
    });
  ```

- [ ] **Step 6: Run the FULL gate. This is the only task that does so.**

  ```powershell
  npx tsc --noEmit
  npm run vendor-scanner-assets
  npm run build
  npm test
  ```
  Expected: all green, **no new route** in the route table, and `ƒ /settings` still present.

  **`npm run build` is the only thing in this plan that catches a `'use server'` file exporting a non-async const.** This release does not modify `src/app/(app)/warranties/actions.ts`, so there should be nothing to catch, but this is where it would surface.

- [ ] **Step 7: Walk the automated acceptance criteria by name, not by vibe (§14.1).**

  ```powershell
  npx vitest run tests/ops/ocr-egress.test.ts tests/ops/install.test.ts tests/ops/notify-egress.test.ts tests/ops/csp.test.ts tests/ops/no-viewfinder.test.ts tests/ops/notice.test.ts tests/ops/constants.test.ts tests/ops/scanner-assets.test.ts tests/ops/docker.test.ts tests/ops/release-image.test.ts tests/scripts/check-ocr-assets.test.ts tests/scripts/ocr-probe.test.ts tests/lib/warranty/ocr tests/app/receipt-scanner.test.tsx tests/app/about-panel.test.tsx tests/integration/ocr-engine.test.ts
  git diff --stat HEAD~12 -- drizzle/
  ```
  AC1 `npm test`; AC2 `tsc`; AC3 `ocr-egress.test.ts`; **AC4 `install.test.ts` must be green with its allowlist unamended**, which is the mechanical proof that the egress claim holds; **AC5 `notify-egress.test.ts` likewise unamended**; AC6 `check-ocr-assets.test.ts` plus the real guard run; AC7 Task 12's measured image sizes; AC8 `ocr-probe.test.ts`; AC9 the `git diff --stat` over `drizzle/` must be empty; AC10 `dict.test.ts`'s class-count assertion; AC11 `no-viewfinder.test.ts` and `csp.test.ts`.

  **If `install.test.ts` or `notify-egress.test.ts` needed even one line changed, stop.** Either the change is a real new egress destination, which contradicts the release's central claim, or the test is being weakened to fit. Neither is a thing to fix at release time.

- [ ] **Step 8: Commit.**

  ```powershell
  git add package.json CHANGELOG.md README.md INSTALL.md tests/ops/docker.test.ts
  git commit -m "chore(release): the new receipt reader and scanner capture ship as v1.5.0

package.json bumped and a Keep-a-Changelog 1.5.0 section added, leading with
the engine change because that is what the owner asked for and what the release
is judged on. The copy names no library: a household reading Settings has no
context to act on one.

README gains the model provenance the licences require, naming PP-OCRv5,
RapidOCR, PaddleOCR, Baidu and Apache-2.0, and states plainly that this release
adds no fourth outbound destination: the models ship inside the image and the
scanner is served from the container. INSTALL documents the single recovery the
automatic hardware check cannot perform for itself, which is a backup restored
onto a different processor of the same architecture.

Bumping the version also re-keys the compatibility probe, so every install
checks its own hardware exactly once on this upgrade."
  ```

- [ ] **Step 9: Push at the end of the session**, on the working branch, not directly to `main`.

  ```powershell
  git status --short
  git log --oneline -20
  git push
  ```

<!-- END TASK 13 -->

---

# Spec coverage map

Every section of `docs/superpowers/specs/2026-08-18-ocr-engine-swap-design.md` maps to at least one task.

| Spec section | Requirements | Task(s) |
|---|---|---|
| §1 Overview, what does not change | none | Global Constraints; proved in **9** (queue and re-run untouched), **12** (tesseract still in the image) |
| §2 Architecture delta, the `onnx/` layout | MUST-2.1, MUST-2.2, MUST-2.3 | **2** (purity at source and its test), **3** (the single ORT import), **8** (the egress and boundary test) |
| §2.3 Pinned dependencies | MUST-2.4, MUST-2.5 | **1** |
| §3.1 The four vendored files | MUST-3.1 … MUST-3.4 | **1** |
| §3.2 The fetch script | MUST-3.5 … MUST-3.9 | **1** |
| §3.3 `models.ts` and run-time verification | MUST-3.10 … MUST-3.13 | **1**; the throw path is exercised in **3** |
| §3.4 Licence provenance | MUST-3.14 | **1** (NOTICE and the header), **13** (README) |
| §3.5 The dictionary and the class-count guard | MUST-3.15, MUST-3.16 | **2**; enforced at session creation in **3** and at run time in **6** |
| §4.1 The engine seam and stage order | MUST-4.1, MUST-4.2, MUST-4.3 | **7**; the classifier exception in **5** |
| §4.2 sharp preprocessing and deskew | MUST-4.4, MUST-4.5, MUST-4.6 | **3** |
| §4.3 The detection tensor | MUST-4.7, MUST-4.8, MUST-4.9 | **4** |
| §4.4 DBNet post-processing | MUST-4.10 … MUST-4.18 | **4** |
| §4.5 Crop and rotate | MUST-4.19, MUST-4.20, MUST-4.21 | **5** |
| §4.6 The orientation classifier | MUST-4.22 … MUST-4.25 | **5**; the shape and class guards in **3** |
| §4.7 The recognition tensor | MUST-4.26 … MUST-4.29 | **6** |
| §4.8 CTC greedy decode | MUST-4.30, MUST-4.31, MUST-4.32 | **6** |
| §4.9 Assembly, and `suggest.ts`'s constraint | MUST-4.33, MUST-4.34, MUST-4.35 | **6**; the cap stays in the queue, proved in **7** |
| §4.10 Sessions, disposal, the event loop | MUST-4.36 … MUST-4.40 | **3** (options and disposal), **6** (the yield), **8** (the rename and the timeout path), **9** (the timeout walk) |
| §4.11 The pinned constant table | MUST-4.41, MUST-4.42 | **2** |
| §5.1, §5.2 Why a child process, and the script | MUST-5.1 … MUST-5.5 | **8** |
| §5.3 The probe protocol and verdict table | MUST-5.6 … MUST-5.11 | **8** |
| §5.4 The engine selector | MUST-5.12, MUST-5.13, MUST-5.14 | **8**; the ONNX test seam lands in **3** |
| §5.5 The warning surface | MUST-5.15 … MUST-5.18 | **9** |
| §6 Queue integration | MUST-6.1 … MUST-6.4 | **8** (the two lines), **9** (the walk) |
| §7 The PDF path, unchanged | MUST-7.1, MUST-7.2, MUST-7.3 | **7** (no inference for a PDF), **12** (pdfjs stays in the guard) |
| §8.1 No viewfinder | MUST-8.1, MUST-8.2, MUST-8.3 | **10** |
| §8.2 Vendoring and the loader | MUST-8.4 … MUST-8.8 | **10** |
| §8.6 The CSP token | MUST-8.9, MUST-8.10 | **10** |
| §8.3 The client state machine | MUST-8.11 … MUST-8.17 | **11** |
| §9 Re-running OCR | MUST-9.1 … MUST-9.4 | **9** (proved unmodified), **13** (the changelog line) |
| §10.1 Dockerfile | MUST-10.1 … MUST-10.6 | **12** |
| §10.2 The asset guard | MUST-10.7 … MUST-10.11 | **12** |
| §10.3 `next.config.ts` | MUST-10.12, MUST-10.13 | **1** (plan resolution 10) |
| §10.4 The release workflow | MUST-10.14 … MUST-10.17 | **12** |
| §10.5 Image size accounting | MUST-10.18, MUST-10.19 | **12** (measured), **13** (recorded) |
| §11 Egress | MUST-11.1 … MUST-11.6 | **8** (the new scanner test), **13** (AC4 and AC5 unamended) |
| §12 Settings state, no migration | MUST-12.1 … MUST-12.5 | **8**; asserted in **8**'s egress test and **13**'s AC9 |
| §13.1 Fixtures | MUST-13.2 | **3** (`ocr-images.ts`), **4** (`ocr-probmaps.ts`), **6** (`receipt-boxes.json`); plan resolution 9 |
| §13.2 Unit tests | none | **1** … **7**, one suite per module |
| §13.3 The probe tests | MUST-13.3 | **8** |
| §13.4 Ops tests | none | **1** (notice), **2** (constants), **8** (ocr-egress), **10** (scanner-assets, no-viewfinder, csp), **12** (docker, check-ocr-assets, release-image) |
| §13.5 Client tests | none | **9** (about-panel), **11** (receipt-scanner) |
| §13.6 Integration | MUST-13.4 | **9** |
| §13.7 What cannot be tested | MUST-13.5 | Stated in **8**, **11** and the manual checklist below |
| §14.1 Automated acceptance | AC1 … AC11 | **13** |
| §14.2 Manual acceptance | A1 … A14 | The manual checklist below |
| §15 Decisions taken on the owner's behalf | none | Each restated in the task that implements it |
| §16 Risks | R1 … R14 | R1 **8**; R2 **1**, **2**; R3 **4**, **6**; R4 **6**; R5 **11**; R6 **10**; R7 **1**, **12**; R8 **12**; R9 **6**; R10 **8**, **13**; R11 **2**; R12 **10**; R13 **1**; R14 **10** |
| §17 Research gaps | 17.1 … 17.10 | 17.1 **2**; 17.2 **1**, **2**; 17.3 **1**, **3**, **5**; 17.4 **1**; 17.5 **7**; 17.6 **12**; 17.7 **10**; 17.8 **11**; 17.9 **10**; 17.10 **13** |
| §18 Out of scope | none | Not implemented, by design |
| Warranty-spec requirements this release narrows or inherits | warranty MUST-7.2, MUST-7.4, MUST-7.6, MUST-7.10, MUST-7.14, MUST-7.16, MUST-7.17 | 7.2 narrowed to the tesseract path in **8**, with §4.39's honest replacement bounded in **4**, **6**; 7.4's path rule mirrored in **1**; 7.6's do-not-crash rule in **1**'s `requireVerifiedOnnxOcrAssets`; 7.10's idle teardown and concurrency in **8**; 7.14's no-rasterising in **7**; 7.16's re-run idempotence in **9**; 7.17's single seam in **7** |

**Requirements with no task, and why:** none. Every `MUST-n.m` in the spec maps to a task above. Four are satisfied by **not** doing something and are enforced by an assertion rather than by code: MUST-7.1 and MUST-7.3 (the PDF path, pinned by Task 7's no-inference test and Task 12's guard entry), MUST-9.2 (the re-run action, pinned by Task 9's integration walk), and MUST-11.3 with MUST-11.4 (the two existing egress suites, pinned by Task 13's requirement that they pass unamended).

---

# Final acceptance checklist

Run after Task 13. Automated items must be green in CI; manual items are the once-per-release pass on the owner's own NAS.

**Automated (§14.1)**
- [ ] **AC1** `npm test` green, including every suite named in §13.
- [ ] **AC2** `npm run typecheck` clean under `strict`.
- [ ] **AC3** `tests/ops/ocr-egress.test.ts` passes: zero `fetch(` sites and zero `://` literals under `src/lib/warranty/ocr/` and `src/lib/scanner/`, and `onnxruntime-node` imported in exactly two places.
- [ ] **AC4** `tests/ops/install.test.ts` passes **with no amendment**. An unchanged allowlist is the mechanical proof that the release adds no runtime destination.
- [ ] **AC5** `tests/ops/notify-egress.test.ts` passes **with no amendment**.
- [ ] **AC6** `node scripts/check-ocr-assets.mjs` passes in the repository and inside the built image, covering all ten paths, the four SHA256 values, the two absent platform directories and the scanner assets.
- [ ] **AC7** `docker build` succeeds for `linux/amd64` and `linux/arm64`, and `docker image ls` for each is within 10 MB of §10.5's roughly 91 MB. Both figures are in the release notes.
- [ ] **AC8** `tests/scripts/ocr-probe.test.ts` passes on the CI runner: the real script loads the three real models, runs three real inferences and exits 0.
- [ ] **AC9** `drizzle/` gained no file and `drizzle/meta/_journal.json` is byte-identical to the previous release's.
- [ ] **AC10** The dictionary class count equals the recognition model's declared output width. **If this fails, nothing else in the release matters.**
- [ ] **AC11** `tests/ops/no-viewfinder.test.ts` and `tests/ops/csp.test.ts` pass: no `getUserMedia` anywhere, `camera=()` retained, `'wasm-unsafe-eval'` present, `'unsafe-eval'` absent.

**Manual, once, on the owner's actual NAS (§14.2)**
- [ ] **A1** Fresh install of the new image. Upload one receipt photo from a desktop browser. It reads. Settings, About shows no warning.
- [ ] **A2** `docker logs` during A1 shows exactly one probe: one spawn, one verdict, and no repeat on the second, third or tenth receipt.
- [ ] **A3** Restart the container and upload another receipt. **No second probe.** A re-probe on every boot would be a 60 second stall on every restart.
- [ ] **A4** A network capture on the host during A1 to A3 shows **zero** packets to `modelscope.cn`, `github.com`, `docs.opencv.org`, jsdelivr or unpkg.
- [ ] **A5** From an Android phone on the LAN over plain `http://<nas-ip>:3000`, photograph a receipt. The scanner pane appears, shows the outline on the original and the straightened crop beside it, counts down and uploads on its own. Shutter to "Reading receipt" is under 15 seconds on the first use (which includes the 9 MB download) and under 5 seconds on the second.
- [ ] **A6** Repeat A5 from an iPhone. If OpenCV.js fails to initialise on iOS Safari, the original uploads with no error visible, which is the design working and an acceptable outcome as long as the upload completes.
- [ ] **A7** **The probe under adverse hardware.** On a Cortex-A53-class unit if the household has one, or under `docker run --platform linux/arm64` with QEMU pinned to `-cpu cortex-a53`: upload a receipt. Whatever happens to the child, **the app stays up**, the receipt still gets text, and Settings, About shows the warning with a reason naming the signal. A crashed container here is a release blocker.
- [ ] **A8** Rename `public/scanner/opencv.js` inside a running container and upload a photo from the phone. The upload completes with the original image, no error is shown, and the receipt is still read.
- [ ] **A9** **The measurement that decides `DET_LIMIT_SIDE_LEN`.** Five receipts of the kind that failed before, each uploaded twice (once with the crop, once with **Use the original**), suggested vendor, date and price compared against the paper. If small-print lines are systematically missing, rebuild with `DET_LIMIT_SIDE_LEN = 1536` and repeat once. Record which value shipped.
- [ ] **A10** Time one receipt end to end on the NAS, from stage POST to `ocr_status = 'done'`. Anything over 30 seconds is a finding to raise before release, not after.
- [ ] **A11** A text-layer PDF still reads from the text layer; a scanned PDF still fails with the existing photograph-the-receipt message. Neither spawned a probe or loaded a model.
- [ ] **A12** Press **Re-run OCR** on a receipt from before the upgrade. It re-reads, the stored text is replaced, and a search for a word only in the new text finds the item.
- [ ] **A13** Restore a pre-1.5.0 backup onto the new image. The app boots, no migration runs, existing receipts keep their old text, and the first new receipt triggers exactly one probe.
- [ ] **A14** **The owner re-scans the receipts that failed before.** Every receipt that produced useless text is photographed again through the scanner flow and the suggested vendor, date and price are checked against the paper. **This is the acceptance criterion the release exists for. If it does not pass, the release does not ship regardless of AC1 through AC11.**







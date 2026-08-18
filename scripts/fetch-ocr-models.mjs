/**
 * ONE-TIME maintainer tool. Run it by hand with internet access:
 *
 *   npm run fetch-ocr-models
 *
 * It is never run by `docker build`, never run by a test, never run by the app.
 * It is never wired into an npm lifecycle hook such as postinstall or prepare.
 * The four files it writes are COMMITTED to the repository, which is what lets a build on
 * a firewalled NAS, and a build on a day ModelScope is down, both work. Same pattern as
 * scripts/fetch-tessdata.mjs.
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
//
// This URL was NOT one of the four candidates the original plan guessed at (all four
// 404 or resolve to the wrong file, measured 2026-08-18). The correct pairing is
// published by RapidOCR itself in python/rapidocr/default_models.yaml at this tag,
// which lists a dict_url next to every model_dir. The entry for en_PP-OCRv5_rec_mobile
// under the paddle resource tree names exactly this file. Measured against the real
// en_PP-OCRv5_rec_mobile.onnx: the model's output last dimension is 438, and this
// dictionary has 436 entries, so 436 + 2 (blank plus appended space) equals 438. That
// is MUST-3.16 satisfied by measurement, not assumption.
const DICT_URL =
  `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/${RAPIDOCR_TAG}/paddle/PP-OCRv5/rec/en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt`;
const DICT_FILENAME = 'en_dict.txt';
const MIN_MODEL_BYTES = 400_000;
// The real en_PP-OCRv5_rec_mobile dictionary has 436 entries, not the 90 to 200 the
// original plan assumed for a short ASCII-only PaddleOCR dictionary. This one carries
// Latin-extended and punctuation characters beyond plain ASCII, which is why it is
// larger. Corrected 2026-08-18 against the real downloaded file. The bound still
// catches an HTML error page, a redirect stub, the unrelated 95-line ASCII-only
// PaddleOCR en_dict.txt, and the thousands-of-lines Chinese ppocr_keys_v1.txt.
const DICT_MIN_LINES = 400;
const DICT_MAX_LINES = 500;

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
    // Catches an HTML error page, a redirect stub, and the wrong dictionary being served
    // in place of the English PP-OCRv5 one (either the unrelated 95-line ASCII-only
    // PaddleOCR dictionary or the thousands-of-lines Chinese ppocr_keys_v1.txt).
    fail(`${DICT_URL}\n  refused: ${lines.length} lines is outside ${DICT_MIN_LINES}..${DICT_MAX_LINES}`);
  }
  const target = path.join(OUT_DIR, DICT_FILENAME);
  fs.writeFileSync(target, body);
  const digest = sha256(body);
  console.log(`wrote ${target}\n  ${body.length} bytes, ${lines.length} entries\n  sha256 ${digest}`);
  console.log(`\nPaste this into OCR_DICT_SHA256 in src/lib/warranty/ocr/onnx/models.ts:\n  ${digest}\n`);
  return body.length;
}

// The full Apache-2.0 text, pasted in as a literal while there is network access, from
// https://www.apache.org/licenses/LICENSE-2.0.txt. It is inlined rather than fetched so
// regenerating the NOTICE needs no network. Contains the line "Version 2.0, January 2004"
// and the "TERMS AND CONDITIONS" heading, which the test checks.
const APACHE_2_0_TEXT = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.`;

function writeNotice() {
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
    '    No published hash upstream; verified by shape and pinned by hand into OCR_DICT_SHA256.',
    '',
    'Licensing:',
    '  The models are distributed under the Apache License 2.0.',
    '  The conversion scripts are Copyright (c) 2021 RapidOCR Authors.',
    '  The underlying weights are copyright Baidu, released under the Apache License 2.0',
    '  by PaddlePaddle/PaddleOCR.',
    '',
    APACHE_2_0_TEXT,
    '',
  ];
  const target = path.join(OUT_DIR, 'NOTICE');
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  console.log(`wrote ${target}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  for (const model of MODELS) total += await fetchModel(model);
  total += await fetchDict();
  writeNotice();
  console.log(`total bytes written: ${total}`);
}

await main();

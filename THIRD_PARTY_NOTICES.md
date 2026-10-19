# Third-party notices

Quiz Practice uses the following components. Each retains its own license; the license for Quiz Practice's original source does not replace any component license.

| Component | Version | License / notice |
|---|---|---|
| Node.js | 24.19.0, Windows x64 | MIT plus third-party terms, reproduced in `licenses/Node-LICENSE.txt` |
| Microsoft WebView2 SDK | 1.0.4258.31 | See `licenses/WebView2/LICENSE.txt` and `licenses/WebView2/NOTICE.txt` |
| ONNX Runtime Node and common packages | 1.21.0 | MIT and third-party terms, reproduced in `licenses/ONNXRuntime-LICENSE.txt` and `licenses/ONNXRuntime-ThirdPartyNotices.txt` |
| Microsoft DirectML | 1.15.4 | Microsoft DirectML license and third-party terms, reproduced in `licenses/DirectML-LICENSE.txt`, `licenses/DirectML-LICENSE-CODE.txt`, and `licenses/DirectML-ThirdPartyNotices.txt` |
| Kokoro.js phonemization helper | Copied `neural/phonemize.mjs` | Apache-2.0, reproduced in `neural/Kokoro-LICENSE.txt` |
| Kokoro-82M v1.0 ONNX timestamped model, tokenizer and `af_heart` voice | `dd4401a9add81ac692d20e240d22ec9dda82cc29` | Apache-2.0; model card in `neural/model/README.md` and license in `neural/Kokoro-LICENSE.txt` |
| phonemizer.js wrapper, downloaded during initial voice setup | 1.2.1, `6835144b7ee9043129222549c1ed2f6a27216278` | Wrapper: Apache-2.0, reproduced in `licenses/Phonemizer-Apache-2.0.txt` |
| eSpeak NG engine embedded in the phonemizer download | Upstream npm package `phonemizer` 1.2.1 | GPL-3.0-or-later, reproduced in `licenses/eSpeak-NG-GPL-3.0.txt` |

The published portable package excludes the compiled phonemizer/eSpeak engine. Initial voice setup downloads the unmodified, pinned phonemizer 1.2.1 package from its upstream npm registry. The upstream package is checked against its published SHA512 integrity value. Once installed, pronunciation and neural voice generation run locally.

Sources:

- Node.js: https://github.com/nodejs/node/tree/v24.19.0
- WebView2 SDK: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31
- ONNX Runtime: https://github.com/microsoft/onnxruntime/tree/v1.21.0
- DirectML binary package and its license: https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4
- Kokoro.js helper: https://github.com/hexgrad/kokoro/tree/main/kokoro.js
- Timestamped model and voice assets: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/tree/dd4401a9add81ac692d20e240d22ec9dda82cc29
- phonemizer 1.2.1 package: https://registry.npmjs.org/phonemizer/-/phonemizer-1.2.1.tgz
- phonemizer source: https://github.com/xenova/phonemizer.js/tree/6835144b7ee9043129222549c1ed2f6a27216278
- eSpeak NG source: https://github.com/espeak-ng/espeak-ng
- eSpeak Emscripten build instructions: https://github.com/espeak-ng/espeak-ng/blob/master/emscripten/README.md

The phonemizer wrapper does not identify the eSpeak engine's compilation revision. All 328 embedded language/voice source files were independently verified against eSpeak NG revision `0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582`, with no differences. This identifies matching pronunciation source data; it does not establish that the optimized engine was built from exactly that C/C++ revision. The original package is therefore fetched directly rather than redistributed in this release.

Quiz-bowl questions are obtained on demand from QBReader. No question bank or user practice history is included in the download. Question rights remain with their authors and publishers; source, set and packet information are displayed with questions. QBReader API: https://www.qbreader.org/tools/api-docs/


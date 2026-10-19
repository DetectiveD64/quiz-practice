# Build Quiz Practice for Windows x64

The desktop application is a .NET Framework 4.8 Windows Forms launcher embedding WebView2. It starts the bundled Node HTTP server on loopback and bridges native audio playback to the page. The server uses Node built-ins, so the app root has no npm dependencies.

## Tools and tests

Use Windows x64 with Node 24 or newer. The release was built and tested using Node **24.19.0**, the Windows .NET Framework C# compiler, and the **Microsoft.Web.WebView2 1.0.4258.31** NuGet SDK.

```powershell
npm test
```

The suite uses disposable temporary folders and mock services. It does not need a downloaded model, a live archive connection, or an existing practice history.

## Portable folder layout

Prepare a new writable folder containing the repository's `src/`, `public/`, `windows/`, `assets/`, `licenses/`, `neural/` source helper files, and `package.json`. Add the following dependencies to that folder. Never copy a used app's `data/` or `logs/` into a release.

| Destination | Pinned dependency |
| --- | --- |
| `runtime/node.exe` | Node.js Windows x64 24.19.0 |
| `neural/node_modules/` | `onnxruntime-node@1.21.0` and matching `onnxruntime-common` |
| `neural/model/kokoro-q8-timed.onnx` | Timestamped Kokoro q8 ONNX model, revision below |
| `neural/model/tokenizer.json` | Tokenizer matching that model |
| `neural/model/af_heart.bin` | Kokoro Heart voice data |

Install the ONNX voice runtime from within `neural/`:

```powershell
npm install --no-save onnxruntime-node@1.21.0 onnxruntime-common@1.21.0
```

Use the [official Node downloads](https://nodejs.org/en/download/) for the runtime and retain its license. The native ONNX Runtime package must include its Windows x64 binaries. Other operating-system binaries are unnecessary in a Windows-only release. The ONNX Windows runtime also requires the Microsoft Visual C++ x64 Redistributable.

Do not include `neural/node_modules/phonemizer` in a distributed ZIP. On first startup, `src/voice-dependency.mjs` downloads the unmodified `phonemizer@1.2.1` archive directly from `registry.npmjs.org`, verifies its pinned SHA512 before extraction, and installs only its manifest, license, and self-contained ES module. Later launches reuse the installed copy. See `THIRD_PARTY_NOTICES.md` for upstream licenses and sources.

The timestamped model source is [onnx-community/Kokoro-82M-v1.0-ONNX-timestamped](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) at commit `dd4401a9add81ac692d20e240d22ec9dda82cc29`. The bundled `kokoro-q8-timed.onnx` SHA-256 is:

```text
c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c
```

Retain the model's Apache-2.0 license, tokenizer, Heart voice, and original model card, together with the notices and corresponding-source material for every redistributed voice component. The app's `phonemize.mjs` is derived from the official Kokoro JavaScript helper and retains its copyright and license header.

## Compile the launcher

Download and extract **Microsoft.Web.WebView2 1.0.4258.31** from [NuGet](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31). Pass the extracted SDK directory and new portable folder to the build script:

```powershell
.\windows\build-desktop.ps1 -SdkRoot 'C:\build\webview2-sdk' -AppRoot 'C:\build\QuizPractice'
```

The script compiles `QuizPractice.exe` for x64 and copies the required WebView2 assemblies, native loader, application configuration, and SDK notices. It uses the .NET compiler and System.Speech assembly under the current Windows directory. The compiler and assembly must be installed. The output EXE's file version is **1.2.0.0**.

The destination must also contain all application source and runtime dependencies listed above. Test a fresh extracted copy on another Windows x64 PC with WebView2 and .NET 4.8 installed. Do not launch or build against another person's existing app folder.

## Package a clean release

Include the complete portable `QuizPractice/` folder and third-party license/source materials in the release ZIP. Exclude `data/`, `logs/`, local configuration, credentials, browser profiles, preview images, caches, and old ZIPs. Leave the folder writable: first launch creates new local data and logs.

The source repository intentionally ignores executable dependencies, model binaries, and personal state. Publish the portable build as a GitHub Release asset rather than committing large binaries to Git.

# Quiz Practice

A minimal Windows quiz bowl practice app: choose topics and levels, listen to a question, and type an answer. The question appears word by word with the voice and freezes when you begin typing. Answers receive a green or red result, and statistics are saved on your own PC.

## Download and run

1. [Download Quiz Practice for Windows x64](https://github.com/DetectiveD64/quiz-practice/releases/download/v1.2.0/QuizPractice-Windows-x64-v1.2.0.zip) from the [Releases page](https://github.com/DetectiveD64/quiz-practice/releases).
2. Right-click the ZIP and choose **Extract All**. Put the extracted folder somewhere you can write, such as Documents.
3. Open the extracted **QuizPractice** folder and double-click **QuizPractice.exe**. Keep the entire folder together; the EXE alone is not the app.

Requirements: Windows 10 or 11 on an x64 PC, [.NET Framework 4.8](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net48), the [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), and the [Microsoft Visual C++ x64 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe). Use Microsoft's official installers if a component is missing.

The portable download includes the Node runtime, local Kokoro voice model, and ONNX voice runtime. First launch downloads a small, integrity-checked pronunciation helper directly from the official npm registry, along with the initial questions. After this one-time setup, the voice and previously cached questions work offline. New questions require internet access. No Ollama, account, password, voice subscription, or API key is needed.

## Practice

- Select topics and difficulty levels using the checkboxes at the top.
- Type an answer and press **Enter**. Reasonable spelling mistakes and answer-key alternatives are accepted; ambiguous answers may prompt for more detail.
- The first typed character stops the voice and freezes the question. Clearing the input keeps it paused. **Replay** starts the reading again.
- After a result, press **Enter** again for the next question. **Skip** does not change your score.
- The app prepares three upcoming questions and their opening audio while you practice. The first question, changed filters, or rapid skipping can still take a few seconds.
- Turning **Read aloud** off uses a silent word-by-word reveal.

## Local data and privacy

Every download starts with a clean practice history. The app creates `data/` and `logs/` beside the EXE when first run. Scores, filters, downloaded questions, prepared audio, and the embedded browser profile remain in that folder. No account or analytics service is used. The app contacts QBReader for question batches and archive metadata, and the npm registry once to set up the pronunciation helper. Answers, statistics, and voice text are not sent to either service; voice generation runs on the PC.

The app's server listens only on `127.0.0.1:43877` while the window is open. It does not start automatically at Windows login. Only one copy can use that local port at a time.

To share the app with another person, use the original release ZIP. Do not send a used folder containing `data/` or `logs/`. To reset your own history, close the app first and remove its `data/` folder; this also removes your cached questions and recordings.

## Question sources and grading

The app loads academic tossups from the publicly available [QBReader archive](https://www.qbreader.org/) using its [documented API](https://www.qbreader.org/tools/api-docs/). It downloads small batches rather than bundling an entire question bank. Original set, packet, and question information appears below each question. Question copyrights remain with the individual writers and rights holders. This project is not affiliated with QBReader or NAQT.

Grading uses the answer key, explicit accepted alternatives, established equivalent names, and conservative spelling tolerance. It does not ask an AI model to decide whether any arbitrary response is correct. Unlisted synonyms may still require the wording in the answer key.

## Source and build

The repository contains application source, tests, the Windows launcher, and component notices. Runtime binaries, neural weights, generated questions, recordings, browser profiles, and personal practice history are excluded from Git. See [BUILDING.md](BUILDING.md) for the build layout and pinned dependency versions.

Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the `licenses/` folder, and component license files. Question rights remain with their authors. Use the question service for personal, noncommercial practice.

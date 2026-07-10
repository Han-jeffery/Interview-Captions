# Interview Copilot

Local real-time interview support for a Mac video interview. It listens to a selected audio input, sends 16k PCM audio to realtime ASR, detects interviewer questions, and asks DeepSeek for concise answer support.

## Setup

```bash
cp .env.example .env
npm install
npm start
```

Open:

```text
http://localhost:3210
```

Desktop floating-caption mode:

```bash
npm run desktop
```

One-click Mac app:

```text
/Applications/Interview Captions.app
```

Open it from Finder, Launchpad, Spotlight, or the Applications folder. The app starts the local backend automatically.

Shortcuts in desktop mode:

- `Cmd+Shift+H`: hide/show the floating window.
- `Cmd+Shift+T`: toggle mouse click-through.

Material import:

- Click `资料` in the floating window to import `.txt`, `.md`, `.docx`, or `.pdf` interview material.
- Imported text is appended to `data/profile.md`.
- The next generated outline will use the imported material.

## Credentials

Edit `.env`:

```text
DEEPSEEK_API_KEY=...

ASR_PROVIDER=deepgram
DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=multi

# Optional iFlytek fallback
IFLYTEK_APP_ID=...
IFLYTEK_API_KEY=...
```

The default ASR path is Deepgram, matching the common open-source interview assistant architecture. If you want to try iFlytek later, set `ASR_PROVIDER=iflytek` and use credentials from 讯飞开放平台的“实时语音转写”, not only a normal 讯飞听见 consumer login.

For Chinese-English mixed interviews, keep:

```text
DEEPGRAM_LANGUAGE=multi
```

## Personal context

Edit:

- `data/profile.md`: your real resume, project experience, STAR examples, tendering/commercial/channel examples.
- `data/job.md`: job description and target interview role.

The prompt is configured to avoid inventing experience when the profile is incomplete.

## Mac audio routing

For Tencent Meeting or WeChat video interviews, the browser needs an audio input device. On Mac, system/app audio is not always exposed as a microphone input. Recommended route:

1. Install BlackHole 2ch or Loopback.
2. Route Tencent Meeting / WeChat output to that virtual device or a multi-output device.
3. In this app, choose the virtual audio input from the dropdown.
4. Keep your normal microphone available for speaking in Tencent Meeting / WeChat.

If you choose the built-in microphone, the app will only hear room audio and speaker leakage, which is less reliable.

## Floating caption notes

The desktop mode is a transparent always-on-top window similar to floating subtitles. If you share your whole screen in Tencent Meeting or WeChat, the floating window may be visible to the interviewer. Sharing only a specific app window is safer when screen sharing is required.

## Output style

The assistant returns:

1. 中文理解
2. Opening sentence
3. Answer points
4. Relevant example
5. Follow-up risk

It is designed as a cue sheet, not a full script.

const deviceSelect = document.querySelector("#deviceSelect");
const languageSelect = document.querySelector("#languageSelect");
const refreshBtn = document.querySelector("#refreshBtn");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const statusEl = document.querySelector("#status");
const captionHistory = document.querySelector("#captionHistory");
const captionText = document.querySelector("#captionText");
const questionEl = document.querySelector("#question");
const answerEl = document.querySelector("#answer");
const answerCard = document.querySelector("#answerCard");
const autoBtn = document.querySelector("#autoBtn");
const materialBtn = document.querySelector("#materialBtn");
const materialInput = document.querySelector("#materialInput");
const materialModal = document.querySelector("#materialModal");
const materialCloseBtn = document.querySelector("#materialCloseBtn");
const chooseMaterialBtn = document.querySelector("#chooseMaterialBtn");
const dropZone = document.querySelector("#dropZone");
const materialResult = document.querySelector("#materialResult");
const clearMaterialBtn = document.querySelector("#clearMaterialBtn");
const compactBtn = document.querySelector("#compactBtn");
const generateBtn = document.querySelector("#generateBtn");
const clickThroughBtn = document.querySelector("#clickThroughBtn");
const minimizeBtn = document.querySelector("#minimizeBtn");
const closeBtn = document.querySelector("#closeBtn");
const meterFill = document.querySelector("#meterFill");
const frameCount = document.querySelector("#frameCount");
const visibleStatus = document.querySelector("#visibleStatus");

let ws;
let audioContext;
let mediaStream;
let sourceNode;
let workletNode;
let currentAnswer = "";
let lastFinal = "";
let framesSent = 0;
let autoGenerate = true;
let autoTimer;
let lastAutoQuestion = "";
let lastAutoAt = 0;
let audioDiagnosticTimer;
let transcriptSeq = 0;
let lastHistoryText = "";
let lastHistoryAt = 0;

const AUTO_IDLE_MS = 0;
const AUTO_COOLDOWN_MS = 12000;

function normalizeCaption(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function wordCount(text) {
  const englishWords = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  const cjkChars = text.match(/[\u4e00-\u9fff]/g) || [];
  return englishWords.length + Math.floor(cjkChars.length / 2);
}

function looksLikeInterviewQuestion(text) {
  const t = normalizeCaption(text);
  if (t.length < 12 || wordCount(t) < 5) return false;
  if (/^(hello|hallo|hi|ok|okay|yes|no|thanks|thank you|嗯|啊|好的|你好)[.!。！ ]*$/i.test(t)) return false;
  if (/[?？]$/.test(t)) return true;
  return /(tell me|can you|could you|would you|how do you|why do you|what is|what are|describe|explain|please introduce|introduce yourself|project experience|work experience|介绍|说明|讲一下|说一下|为什么|怎么|如何|能不能|有没有|你认为|你的经验|你的项目|渠道|市场|投标|商务|管理|经历|项目)/i.test(t);
}

function requestOutline(text, force = false) {
  const question = normalizeCaption(text);
  if (!question) return false;
  if (!force && !looksLikeInterviewQuestion(question)) return false;
  if (!force) {
    const now = Date.now();
    if (question === lastAutoQuestion && now - lastAutoAt < AUTO_COOLDOWN_MS) return false;
    if (now - lastAutoAt < AUTO_COOLDOWN_MS) return false;
    lastAutoQuestion = question;
    lastAutoAt = now;
  }
  if (ws?.readyState !== WebSocket.OPEN) return false;
  answerCard.classList.remove("hidden");
  compactBtn.textContent = "隐藏";
  ws.send(JSON.stringify({ type: "generate_answer", text: question }));
  return true;
}

function scheduleAutoGenerate(text) {
  clearTimeout(autoTimer);
  if (!autoGenerate) return;
  autoTimer = setTimeout(() => {
    requestOutline(text, false);
  }, AUTO_IDLE_MS);
}

function appendCaptionHistory(text) {
  const normalized = normalizeCaption(text);
  if (!normalized) return;

  const now = Date.now();
  if (normalized === lastHistoryText && now - lastHistoryAt < 5000) return;
  lastHistoryText = normalized;
  lastHistoryAt = now;

  const id = `t-${++transcriptSeq}`;
  const row = document.createElement("div");
  row.className = "caption-line";
  row.dataset.id = id;

  const source = document.createElement("div");
  source.className = "source";
  source.textContent = normalized;

  row.append(source);
  captionHistory.appendChild(row);
  while (captionHistory.children.length > 30) {
    captionHistory.firstElementChild?.remove();
  }
  captionHistory.scrollTop = captionHistory.scrollHeight;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  visibleStatus.textContent = message;
  visibleStatus.classList.toggle("error", isError);
}

function isMaterialModalOpen() {
  return !materialModal.classList.contains("hidden");
}

function getFirstDroppedFile(event) {
  return event.dataTransfer?.files?.[0] || null;
}

function isSupportedMaterialFile(file) {
  return /\.(txt|md|markdown|json|docx|pdf)$/i.test(file.name);
}

async function loadDevices() {
  await navigator.mediaDevices.getUserMedia({ audio: true });
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  deviceSelect.innerHTML = "";

  for (const device of audioInputs) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Audio input ${deviceSelect.length + 1}`;
    deviceSelect.appendChild(option);
  }

  const preferred = audioInputs.find((device) => /blackhole|loopback|soundflower/i.test(device.label));
  if (preferred) {
    deviceSelect.value = preferred.deviceId;
  }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${location.port || 3210}/ws`);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "start", language: languageSelect?.value || "zh-CN" }));
      resolve();
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "status") {
        setStatus(message.message);
      }

      if (message.type === "error") {
        setStatus(message.message, true);
      }

      if (message.type === "transcript_partial") {
        const langTag = message.language === "zh" ? "中" : message.language === "en" ? "EN" : "";
        captionText.textContent = (langTag ? `[${langTag}] ` : "") + (message.text || lastFinal || "Listening...");
        setStatus(`字幕识别中 ${langTag}`);
      }

      if (message.type === "transcript_final") {
        lastFinal = message.text;
        const langTag = message.language === "zh" ? "中" : message.language === "en" ? "EN" : "";
        captionText.textContent = (langTag ? `[${langTag}] ` : "") + message.text;
        setStatus("字幕已更新");
        appendCaptionHistory((langTag ? `[${langTag}] ` : "") + message.text);
        scheduleAutoGenerate(message.text);
      }

      if (message.type === "answer_start") {
        currentAnswer = "";
        questionEl.textContent = message.question;
        const prefix = answerEl.textContent.trim() ? "\n\n---\n" : "";
        answerEl.textContent += `${prefix}Q: ${message.question}\n`;
        answerCard.classList.remove("hidden");
        answerEl.scrollTop = answerEl.scrollHeight;
      }

      if (message.type === "answer_delta") {
        currentAnswer += message.text;
        answerEl.textContent += message.text;
        answerEl.scrollTop = answerEl.scrollHeight;
      }

      if (message.type === "answer_done") {
        questionEl.textContent = message.question || questionEl.textContent;
        answerEl.scrollTop = answerEl.scrollHeight;
      }
    });

    ws.addEventListener("error", () => reject(new Error("Local websocket failed.")));
  });
}

async function startListening() {
  try {
    startBtn.disabled = true;
    setStatus("Starting...");
    await connectSocket();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceSelect.value ? { exact: deviceSelect.value } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("/audio-worklet.js");
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

    workletNode.port.onmessage = (event) => {
      if (event.data?.type === "level") {
        meterFill.style.width = `${Math.round(event.data.value * 100)}%`;
        return;
      }

      if (ws?.readyState === WebSocket.OPEN) {
        framesSent += 1;
        frameCount.textContent = `${framesSent} frames`;
        ws.send(event.data);
      }
    };

    sourceNode.connect(workletNode);
    captionText.textContent = "Listening...";
    setStatus("Listening");
    stopBtn.disabled = false;
    clearTimeout(audioDiagnosticTimer);
    audioDiagnosticTimer = setTimeout(() => {
      if (framesSent === 0) {
        captionText.textContent = "没有检测到输入音频。请检查麦克风权限，或换一个音频输入设备。";
        setStatus("无输入音频", true);
      }
    }, 3000);
  } catch (error) {
    setStatus(error.message, true);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopListening();
  }
}

function stopListening() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }
  workletNode?.disconnect();
  sourceNode?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();

  ws = null;
  workletNode = null;
  sourceNode = null;
  mediaStream = null;
  audioContext = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  framesSent = 0;
  frameCount.textContent = "0 frames";
  meterFill.style.width = "0%";
  clearTimeout(autoTimer);
  clearTimeout(audioDiagnosticTimer);
  setStatus("Stopped");
}

refreshBtn.addEventListener("click", () => {
  loadDevices().catch((error) => setStatus(error.message, true));
});
autoBtn.addEventListener("click", () => {
  autoGenerate = !autoGenerate;
  autoBtn.textContent = autoGenerate ? "自动开" : "自动关";
  autoBtn.classList.toggle("toggle-on", autoGenerate);
  setStatus(autoGenerate ? "自动生成已开启" : "自动生成已关闭");
});
materialBtn.addEventListener("click", () => {
  materialModal.classList.remove("hidden");
});
materialCloseBtn.addEventListener("click", () => {
  materialModal.classList.add("hidden");
});
chooseMaterialBtn.addEventListener("click", () => {
  materialInput.click();
});
async function importMaterialFile(file) {
  if (!isSupportedMaterialFile(file)) {
    const message = "只支持 .docx, .pdf, .txt, .md, .json";
    setStatus(message, true);
    materialResult.textContent = message;
    return;
  }

  try {
    setStatus(`Importing ${file.name}...`);
    materialResult.textContent = `正在导入 ${file.name}...`;
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    const response = await fetch("/api/profile/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        base64,
        mode: "append"
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Import failed.");
    }
    setStatus(`资料已导入: ${result.chars} chars`);
    materialResult.textContent = `已导入 ${file.name}: ${result.chars} chars`;
    answerEl.textContent = `已导入 ${file.name}。\n之后生成提纲会参考这份资料。`;
  } catch (error) {
    setStatus(error.message, true);
    materialResult.textContent = error.message;
  }
}
materialInput.addEventListener("change", async () => {
  const file = materialInput.files?.[0];
  if (file) await importMaterialFile(file);
  materialInput.value = "";
});

for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

for (const target of [dropZone, materialModal]) {
  for (const eventName of ["dragenter", "dragover"]) {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isMaterialModalOpen()) return;
      dropZone.classList.add("drag-over");
      document.querySelector(".material-card")?.classList.add("drag-over");
      materialResult.textContent = "松开鼠标即可导入资料。";
    });
  }

  for (const eventName of ["dragleave"]) {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("drag-over");
      document.querySelector(".material-card")?.classList.remove("drag-over");
    });
  }

  target.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("drag-over");
    document.querySelector(".material-card")?.classList.remove("drag-over");
    if (!isMaterialModalOpen()) return;
    const file = getFirstDroppedFile(event);
    if (!file) {
      materialResult.textContent = "没有读取到文件，请点“选择电脑资料”。";
      return;
    }
    await importMaterialFile(file);
  });
}
clearMaterialBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("确定清空所有已导入资料吗？这个操作会重置 profile.md。");
  if (!confirmed) return;

  try {
    const response = await fetch("/api/profile/clear", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Clear failed.");
    }
    materialResult.textContent = "已清空资料库。";
    answerEl.textContent = "已清空已导入资料。";
    setStatus("资料已清空");
  } catch (error) {
    materialResult.textContent = error.message;
    setStatus(error.message, true);
  }
});
startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);
compactBtn.addEventListener("click", () => {
  answerCard.classList.toggle("hidden");
  compactBtn.textContent = answerCard.classList.contains("hidden") ? "提纲" : "隐藏";
});
generateBtn.addEventListener("click", () => {
  const text = captionText.textContent?.trim();
  if (!text || text === "Listening..." || text.startsWith("选择音频输入")) {
    setStatus("No caption to generate from.", true);
    return;
  }
  if (ws?.readyState !== WebSocket.OPEN) {
    setStatus("Start listening before generating.", true);
    return;
  }
  answerCard.classList.remove("hidden");
  compactBtn.textContent = "隐藏";
  requestOutline(text, true);
});
clickThroughBtn.addEventListener("click", async () => {
  const enabled = await window.desktopApi?.toggleClickThrough();
  clickThroughBtn.textContent = enabled ? "已穿透" : "穿透";
});
minimizeBtn.addEventListener("click", () => window.desktopApi?.minimize());
closeBtn.addEventListener("click", () => window.desktopApi?.close());
window.desktopApi?.onClickThrough((enabled) => {
  clickThroughBtn.textContent = enabled ? "已穿透" : "穿透";
});

loadDevices().catch((error) => setStatus(error.message, true));

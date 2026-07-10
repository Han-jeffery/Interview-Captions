const deviceSelect = document.querySelector("#deviceSelect");
const languageSelect = document.querySelector("#languageSelect");
const refreshBtn = document.querySelector("#refreshBtn");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const clearTranscriptBtn = document.querySelector("#clearTranscriptBtn");
const clearAnswerBtn = document.querySelector("#clearAnswerBtn");
const statusEl = document.querySelector("#status");
const partialEl = document.querySelector("#partial");
const transcriptEl = document.querySelector("#transcript");
const questionEl = document.querySelector("#question");
const answerEl = document.querySelector("#answer");
const meterFill = document.querySelector("#meterFill");
const frameCount = document.querySelector("#frameCount");
const visibleStatus = document.querySelector("#visibleStatus");

let ws;
let audioContext;
let mediaStream;
let sourceNode;
let workletNode;
let currentAnswer = "";
let frameCounter = 0;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  if (visibleStatus) {
    visibleStatus.textContent = message;
    visibleStatus.classList.toggle("error", isError);
  }
}

async function loadDevices() {
  await navigator.mediaDevices.getUserMedia({ audio: true });
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  deviceSelect.innerHTML = "";

  for (const device of audioInputs) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `音频设备 ${deviceSelect.length + 1}`;
    deviceSelect.appendChild(option);
  }

  const preferred = audioInputs.find((device) => /blackhole|loopback|soundflower/i.test(device.label));
  if (preferred) {
    deviceSelect.value = preferred.deviceId;
  }
}

function appendTranscript(text) {
  const line = document.createElement("div");
  line.className = "final-line";
  line.textContent = text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
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
        const langTag = message.language === "zh" ? "[中]" : message.language === "en" ? "[EN]" : "";
        partialEl.textContent = (langTag ? langTag + " " : "") + message.text;
      }

      if (message.type === "transcript_final") {
        partialEl.textContent = "";
        const langTag = message.language === "zh" ? "[中]" : message.language === "en" ? "[EN]" : "";
        appendTranscript((langTag ? langTag + " " : "") + message.text);
      }

      if (message.type === "answer_start") {
        currentAnswer = "";
        questionEl.textContent = message.question;
        answerEl.textContent = "思考中...";
      }

      if (message.type === "answer_delta") {
        currentAnswer += message.text;
        answerEl.textContent = currentAnswer;
        answerEl.scrollTop = answerEl.scrollHeight;
      }

      if (message.type === "answer") {
        questionEl.textContent = message.question || "";
        answerEl.textContent = message.text;
      }
    });

    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")));
  });
}

async function startListening() {
  try {
    startBtn.disabled = true;
    setStatus("启动中...");
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
      if (event.data instanceof ArrayBuffer) {
        frameCounter++;
        if (frameCount) frameCount.textContent = frameCounter + " frames";
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      } else if (event.data?.type === "level" && meterFill) {
        meterFill.style.width = Math.round(event.data.value * 100) + "%";
      }
    };

    sourceNode.connect(workletNode);
    setStatus("监听中 · 请保持页面打开");
    stopBtn.disabled = false;
  } catch (error) {
    setStatus("错误: " + error.message, true);
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
  frameCounter = 0;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("已停止");
  if (meterFill) meterFill.style.width = "0%";
  if (frameCount) frameCount.textContent = "0 frames";
}

refreshBtn.addEventListener("click", () => {
  loadDevices().catch((error) => setStatus(error.message, true));
});

startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);
clearTranscriptBtn.addEventListener("click", () => {
  partialEl.textContent = "";
  transcriptEl.textContent = "";
});
clearAnswerBtn.addEventListener("click", () => {
  questionEl.textContent = "";
  answerEl.textContent = "";
});

loadDevices().catch((error) => setStatus(error.message, true));

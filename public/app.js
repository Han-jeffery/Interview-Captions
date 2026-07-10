const deviceSelect = document.querySelector("#deviceSelect");
const languageSelect = document.querySelector("#languageSelect");
const refreshBtn = document.querySelector("#refreshBtn");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const generateBtn = document.querySelector("#generateBtn");
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
const materialBtn = document.querySelector("#materialBtn");
const materialModal = document.querySelector("#materialModal");
const materialCloseBtn = document.querySelector("#materialCloseBtn");
const dropZone = document.querySelector("#dropZone");
const chooseMaterialBtn = document.querySelector("#chooseMaterialBtn");
const materialInput = document.querySelector("#materialInput");
const materialResult = document.querySelector("#materialResult");
const clearMaterialBtn = document.querySelector("#clearMaterialBtn");

let ws;
let userMaterial = localStorage.getItem("itcview_material") || "";
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
  try {
    // 请求麦克风权限，HTTP 非 localhost 会被浏览器拒绝
    await navigator.mediaDevices.getUserMedia({ audio: true });
    // 成功后立即释放，这只是为了获取权限和设备标签
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch (e) {
    // HTTP 环境或权限被拒绝 → 尝试直接枚举（可能没有标签）
    console.warn("麦克风权限获取失败:", e.message);
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  deviceSelect.innerHTML = "";

  if (audioInputs.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "未检测到设备 — 请允许麦克风权限";
    deviceSelect.appendChild(opt);

    // 如果是 HTTP 非 localhost，给提示
    if (location.protocol === "http:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      setStatus("⚠️ HTTP 下麦克风被浏览器阻止，请用 Chrome 开启 insecure origin 或使用 HTTPS", true);
    }
    return;
  }

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
      if (userMaterial) {
        ws.send(JSON.stringify({ type: "set_material", text: userMaterial }));
      }
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
        // 把之前的答案保留在历史中
        const history = transcriptEl.querySelectorAll(".answer-entry");
        if (history.length > 0 && answerEl.textContent && answerEl.textContent !== "思考中...") {
          const sep = document.createElement("div");
          sep.className = "answer-entry-sep";
          sep.textContent = "─".repeat(40);
          answerEl.appendChild(sep);
        }
      }

      if (message.type === "answer_delta") {
        currentAnswer += message.text;
        // 更新当前答案（追加模式，不清空历史）
        const existing = answerEl.querySelector(".answer-current");
        if (existing) {
          existing.textContent = currentAnswer;
        } else {
          const cur = document.createElement("div");
          cur.className = "answer-current";
          cur.textContent = currentAnswer;
          answerEl.appendChild(cur);
        }
        answerEl.scrollTop = answerEl.scrollHeight;
      }

      if (message.type === "answer") {
        // 移除临时元素，写入最终答案
        const cur = answerEl.querySelector(".answer-current");
        if (cur) cur.remove();
        const entry = document.createElement("div");
        entry.className = "answer-entry";
        entry.innerHTML = `<strong>Q:</strong> ${message.question || ""}<br><strong>A:</strong> ${message.text}`;
        answerEl.appendChild(entry);
        answerEl.scrollTop = answerEl.scrollHeight;
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
generateBtn?.addEventListener("click", () => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "generate_answer" }));
    setStatus("正在生成回答...");
  }
});
clearTranscriptBtn.addEventListener("click", () => {
  partialEl.textContent = "";
  transcriptEl.textContent = "";
});
clearAnswerBtn.addEventListener("click", () => {
  questionEl.textContent = "";
  answerEl.textContent = "";
});

// ---- 资料导入 ----
materialBtn?.addEventListener("click", () => {
  materialModal.classList.remove("hidden");
  if (userMaterial) {
    materialResult.textContent = `已导入 ${userMaterial.length} 字符的资料`;
  }
});
materialCloseBtn?.addEventListener("click", () => materialModal.classList.add("hidden"));
materialModal?.addEventListener("click", (e) => {
  if (e.target === materialModal) materialModal.classList.add("hidden");
});

chooseMaterialBtn?.addEventListener("click", () => materialInput.click());
materialInput?.addEventListener("change", () => {
  const file = materialInput.files[0];
  if (file) uploadMaterial(file);
});

dropZone?.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone?.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) uploadMaterial(file);
});

async function uploadMaterial(file) {
  materialResult.textContent = "解析中...";
  try {
    const reader = new FileReader();
    reader.onload = async function() {
      const base64 = reader.result.split(",")[1];
      const res = await fetch("/api/profile/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, base64, mode: "replace" })
      });
      const data = await res.json();
      if (data.ok) {
        userMaterial = "";
        // 从服务器拉取解析后的文本
        const getRes = await fetch("/api/profile/get");
        if (getRes.ok) {
          const getData = await getRes.json();
          userMaterial = getData.text || "";
        }
        localStorage.setItem("itcview_material", userMaterial);
        materialResult.textContent = `✅ 已导入 (${userMaterial.length} 字符) — 下次连接时生效`;
        // 如果已连接，立即发送
        if (ws?.readyState === WebSocket.OPEN && userMaterial) {
          ws.send(JSON.stringify({ type: "set_material", text: userMaterial }));
        }
      } else {
        // 纯文本文件直接读取
        userMaterial = atob(base64);
        localStorage.setItem("itcview_material", userMaterial);
        materialResult.textContent = `✅ 已导入纯文本 (${userMaterial.length} 字符)`;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "set_material", text: userMaterial }));
        }
      }
    };
    reader.readAsDataURL(file);
  } catch (e) {
    materialResult.textContent = "导入失败: " + e.message;
  }
}

clearMaterialBtn?.addEventListener("click", () => {
  userMaterial = "";
  localStorage.removeItem("itcview_material");
  materialResult.textContent = "资料已清空";
});

loadDevices().catch((error) => setStatus(error.message, true));

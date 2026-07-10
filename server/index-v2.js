import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");

const PORT = Number(process.env.PORT || 3211);
const QUESTION_IDLE_MS = Number(process.env.QUESTION_IDLE_MS || 1800);
const QUESTION_MIN_CHARS = Number(process.env.QUESTION_MIN_CHARS || 18);
const ASR_PROVIDER = (process.env.ASR_PROVIDER || "deepgram").toLowerCase();
const APP_VERSION = "1.1.0";
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

// ---- 激活码系统 ----
const ACTIVATION_FILE = path.join(dataDir, "activation-codes.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "itcview2026";

function loadActivationData() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVATION_FILE, "utf8"));
  } catch {
    const initial = { codes: {}, adminPassword: ADMIN_PASSWORD };
    fs.writeFileSync(ACTIVATION_FILE, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

function saveActivationData(data) {
  fs.writeFileSync(ACTIVATION_FILE, JSON.stringify(data, null, 2), "utf8");
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (i < 3) code += "-";
  }
  return code;
}

function createToken(code) {
  return crypto.createHmac("sha256", "itcview-secret").update(code + Date.now()).digest("hex").slice(0, 32);
}

const app = express();
app.use(express.json({ limit: "40mb" }));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "activate.html")));
app.use(express.static(publicDir));

// ---- 激活码 API ----
app.post("/api/activate", (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== "string") return res.status(400).json({ ok: false, error: "请输入激活码" });

  const data = loadActivationData();
  const record = data.codes[code.toUpperCase()];
  if (!record) return res.status(400).json({ ok: false, error: "激活码无效" });

  const now = Date.now();
  if (!record.activatedAt) {
    // 首次激活，开始计时
    record.activatedAt = now;
    record.expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30天
    saveActivationData(data);
  }

  if (now > record.expiresAt) return res.status(400).json({ ok: false, error: "激活码已过期" });

  const token = createToken(code);
  record.token = token;
  saveActivationData(data);

  res.json({ ok: true, token, expiresAt: record.expiresAt, daysLeft: Math.ceil((record.expiresAt - now) / (24 * 60 * 60 * 1000)) });
});

app.post("/api/verify-token", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ ok: false });

  const data = loadActivationData();
  const found = Object.entries(data.codes).find(([, v]) => v.token === token);
  if (!found) return res.json({ ok: false });

  const [, record] = found;
  if (Date.now() > record.expiresAt) return res.json({ ok: false, expired: true });

  res.json({ ok: true, daysLeft: Math.ceil((record.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)) });
});

// ---- 管理后台 API ----
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "密码错误" });
  const token = crypto.createHmac("sha256", "admin-secret").update(password + Date.now()).digest("hex").slice(0, 16);
  res.json({ ok: true, token });
});

app.post("/api/admin/generate", (req, res) => {
  const { password, count = 1 } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "密码错误" });

  const data = loadActivationData();
  const newCodes = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const code = generateCode();
    data.codes[code] = { createdAt: Date.now(), activatedAt: null, expiresAt: null, token: null };
    newCodes.push(code);
  }
  saveActivationData(data);
  res.json({ ok: true, codes: newCodes });
});

app.get("/api/admin/codes", (req, res) => {
  const password = req.query.password || "";
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "密码错误" });

  const data = loadActivationData();
  const list = Object.entries(data.codes).map(([code, info]) => ({
    code,
    createdAt: info.createdAt ? new Date(info.createdAt).toISOString().slice(0, 10) : "-",
    activatedAt: info.activatedAt ? new Date(info.activatedAt).toISOString().slice(0, 10) : "未激活",
    expiresAt: info.expiresAt ? new Date(info.expiresAt).toISOString().slice(0, 10) : "-",
    status: !info.activatedAt ? "未使用" : Date.now() > info.expiresAt ? "已过期" : `剩余${Math.ceil((info.expiresAt - Date.now()) / (24 * 60 * 60 * 1000))}天`
  }));
  res.json({ ok: true, codes: list });
});

app.get("/api/profile/get", (_req, res) => {
  try {
    const text = fs.readFileSync(path.join(dataDir, "temp_profile.md"), "utf8");
    res.json({ ok: true, text });
  } catch {
    res.json({ ok: true, text: "" });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    asrProvider: ASR_PROVIDER,
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    deepgram: Boolean(process.env.DEEPGRAM_API_KEY),
    iflytek: Boolean(process.env.IFLYTEK_APP_ID && process.env.IFLYTEK_API_KEY && process.env.IFLYTEK_API_SECRET)
  });
});
app.post("/api/profile/import", (req, res) => {
  const mode = req.body?.mode === "replace" ? "replace" : "append";
  let imported;

  try {
    imported = extractMaterialText({
      fileName: req.body?.fileName,
      text: req.body?.text,
      base64: req.body?.base64
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
    return;
  }

  if (!imported.text) {
    res.status(400).json({ ok: false, error: "No readable text found in this file." });
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const targetPath = path.join(dataDir, "profile.md");
  const importedBlock = [
    "",
    "",
    `## Imported Material - ${imported.fileName}`,
    "",
    `Source type: ${imported.sourceType}`,
    "",
    imported.text,
    ""
  ].join("\n");

  if (mode === "replace") {
    fs.writeFileSync(targetPath, `# Personal Interview Context\n${importedBlock}`, "utf8");
  } else {
    fs.appendFileSync(targetPath, importedBlock, "utf8");
  }

  res.json({
    ok: true,
    mode,
    fileName: imported.fileName,
    sourceType: imported.sourceType,
    chars: imported.text.length,
    path: targetPath
  });
});
app.post("/api/profile/clear", (_req, res) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const targetPath = path.join(dataDir, "profile.md");
  const template = [
    "# Personal Interview Context",
    "",
    "Add or import your real resume, project experience, interview scripts, STAR examples, tendering/commercial/channel examples here.",
    ""
  ].join("\n");
  fs.writeFileSync(targetPath, template, "utf8");
  res.json({ ok: true, path: targetPath });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// 同时启动 HTTPS（浏览器麦克风需要 HTTPS，Electron 桌面版用 HTTP 本地连接）
const SSL_DIR = path.join(rootDir, "ssl");
const SSL_KEY = path.join(SSL_DIR, "selfsigned.key");
const SSL_CERT = path.join(SSL_DIR, "selfsigned.crt");

try {
  if (!fs.existsSync(SSL_KEY)) {
    fs.mkdirSync(SSL_DIR, { recursive: true });
    spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", SSL_KEY, "-out", SSL_CERT,
      "-days", "365", "-nodes",
      "-subj", "/CN=InterviewGo"
    ], { stdio: "pipe" });
    console.log("Generated self-signed SSL certificate");
  }
  const ssl = { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) };
  const httpsServer = https.createServer(ssl, app);
  const wssHttps = new WebSocketServer({ server: httpsServer, path: "/ws" });
  wssHttps.on("connection", handleConnection);
  const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3444);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`HTTPS at https://localhost:${HTTPS_PORT} (browser microphone support)`);
  });
  httpsServer.on("error", () => {}); // 静默处理端口冲突
} catch (err) {
  console.warn("HTTPS optional (browser may block microphone on HTTP):", err.message);
}

function readContextFile(fileName) {
  try {
    return fs.readFileSync(path.join(dataDir, fileName), "utf8").trim();
  } catch {
    return "";
  }
}

function safeFileName(name) {
  return String(name || "Imported material")
    .replace(/[^\w.\-\u4e00-\u9fa5 ]/g, "")
    .slice(0, 120);
}

function extractMaterialText({ fileName, text, base64 }) {
  const cleanName = safeFileName(fileName);
  const sourceType = path.extname(cleanName).toLowerCase().replace(".", "") || "text";

  if (!base64) {
    return {
      fileName: cleanName,
      sourceType,
      text: String(text || "").trim()
    };
  }

  const buffer = Buffer.from(String(base64), "base64");
  if (!["docx", "pdf"].includes(sourceType)) {
    return {
      fileName: cleanName,
      sourceType,
      text: buffer.toString("utf8").trim()
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-material-"));
  const tempPath = path.join(tempDir, cleanName || `material.${sourceType}`);
  fs.writeFileSync(tempPath, buffer);

  try {
    const result = spawnSync(PYTHON_BIN, [path.join(rootDir, "scripts", "extract_material.py"), tempPath, sourceType], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
    const parsed = JSON.parse(result.stdout || "{}");
    if (!parsed.ok) {
      throw new Error(parsed.error || result.stderr || `Failed to parse ${sourceType}`);
    }

    return {
      fileName: cleanName,
      sourceType,
      text: String(parsed.text || "").trim()
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function buildIflytekUrl() {
  const apiKey = process.env.IFLYTEK_API_KEY;
  const apiSecret = process.env.IFLYTEK_API_SECRET;
  if (!process.env.IFLYTEK_APP_ID || !apiKey || !apiSecret) {
    throw new Error("Missing IFLYTEK_APP_ID, IFLYTEK_API_KEY, or IFLYTEK_API_SECRET in .env");
  }

  const host = "iat.cn-huabei-1.xf-yun.com";
  const requestPath = "/v1";
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${requestPath} HTTP/1.1`;
  const signature = crypto.createHmac("sha256", apiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  const params = new URLSearchParams({ authorization, date, host });
  return `wss://${host}${requestPath}?${params.toString()}`;
}

function buildIflytekAudioFrame(chunk, status, seq) {
  const payload = {
    header: {
      app_id: process.env.IFLYTEK_APP_ID,
      status
    },
    payload: {
      audio: {
        encoding: "raw",
        sample_rate: 16000,
        channels: 1,
        bit_depth: 16,
        seq,
        status,
        audio: Buffer.from(chunk || Buffer.alloc(0)).toString("base64")
      }
    }
  };

  if (status === 0) {
    payload.parameter = {
      iat: {
        domain: "slm",
        language: "mul_cn",
        accent: "mandarin",
        ln: "zh|en",
        eos: 6000,
        result: {
          encoding: "utf8",
          compress: "raw",
          format: "json"
        }
      }
    };
  }

  return JSON.stringify(payload);
}

function resolveDeepgramLanguage(language) {
  const value = String(language || process.env.DEEPGRAM_LANGUAGE || "zh-CN");
  // "multi" doesn't include Chinese — map to zh-CN for Chinese-English bilingual
  if (value === "multi") return "zh-CN";
  if (["zh-CN", "zh", "zh-Hans", "zh-TW", "zh-Hant", "en-US", "en"].includes(value)) return value;
  return "zh-CN";
}

function buildDeepgramUrl(language) {
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error("Missing DEEPGRAM_API_KEY in .env");
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    language: resolveDeepgramLanguage(language),
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING_MS || "1500"
  });

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

function extractIflytekText(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }

  if (message.header?.code && message.header.code !== 0) {
    return { type: "error", text: message.header.message || `iFlytek ASR error ${message.header.code}` };
  }

  if (message.payload?.result?.text) {
    try {
      const decoded = JSON.parse(Buffer.from(message.payload.result.text, "base64").toString("utf8"));
      const words = decoded?.ws
        ?.flatMap((ws) => ws.cw || [])
        ?.map((cw) => cw.w || "")
        ?.join("");

      if (!words) return null;
      return {
        type: decoded?.ls === true || message.payload.result.status === 2 ? "final" : "partial",
        text: words,
        raw: decoded
      };
    } catch {
      return null;
    }
  }

  if (message.action === "error" || message.msg_type === "error") {
    return { type: "error", text: message.desc || "iFlytek ASR error" };
  }

  if (message.action && message.action !== "result") return null;
  if (message.msg_type && message.msg_type !== "result") return null;
  if (!message.data) return null;

  try {
    const data = typeof message.data === "string" ? JSON.parse(message.data) : message.data;
    const cn = data?.cn;
    const st = cn?.st;
    const words = st?.rt
      ?.flatMap((rt) => rt.ws || [])
      ?.flatMap((ws) => ws.cw || [])
      ?.map((cw) => cw.w || "")
      ?.join("");

    if (!words) return null;

    return {
      type: st?.type === "0" || data?.ls === true ? "final" : "partial",
      text: words,
      raw: data
    };
  } catch {
    return null;
  }
}

function extractDeepgramText(raw, lang) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }

  if (message.type && message.type !== "Results") return null;

  const alternative = message.channel?.alternatives?.[0];
  const text = alternative?.transcript;
  if (!text) return null;

  return {
    type: message.is_final ? "final" : "partial",
    text,
    language: lang || "unknown",
    confidence: alternative?.confidence || 0,
    raw: message
  };
}

function normalizeTranscript(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/([。！？!?])\1+/g, "$1")
    .trim();
}

function isChineseEnglishOnly(text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;

  const allowedChars = normalized.match(/[A-Za-z0-9\u4e00-\u9fff\s.,!?;:'"()\-_/&%+@#，。！？；：“”‘’（）【】《》、]/g) || [];
  const meaningfulChars = normalized.match(/[^\s.,!?;:'"()\-_/&%+@#，。！？；：“”‘’（）【】《》、]/g) || [];
  if (meaningfulChars.length === 0) return false;

  return allowedChars.length / normalized.length >= 0.96;
}

// Filter garbled cross-language output: zh channel shouldn't return pure ASCII,
// en channel shouldn't return Chinese characters.
function isTextMatchingLanguage(text, lang) {
  if (lang === "zh") {
    // zh channel: reject if text is mostly ASCII with no CJK characters
    // (English speech mis-transcribed by the Chinese model as pinyin-like garbage)
    const letters = (text.match(/[a-zA-Z]/g) || []).length;
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    // 4+ English letters and zero Chinese chars → English speech in wrong channel
    if (letters >= 4 && cjk === 0) return false;
  }
  if (lang === "en") {
    // en channel: reject if text has CJK characters (Chinese speech in English channel)
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    if (cjk >= 2) return false;
  }
  return true;
}

function looksLikeQuestion(text) {
  const t = normalizeTranscript(text);
  if (!isChineseEnglishOnly(t)) return false;
  if (t.length < QUESTION_MIN_CHARS) return false;
  if (/[?？]$/.test(t)) return true;
  return /(tell me|can you|could you|would you|how do you|why do you|what is|what are|describe|explain|介绍|说明|讲一下|说一下|为什么|怎么|如何|能不能|有没有|你认为|你的经验|你的项目|渠道|市场|投标|商务|管理)/i.test(t);
}

function buildPrompt(question, material) {
  const profile = material || readContextFile("profile.md");
  const job = readContextFile("job.md");

  return [
    {
      role: "system",
      content: [
        "You are a real-time interview support assistant.",
        "The user is in a live Chinese-English mixed interview.",
        "Only use Chinese and English. Do not output any other language.",
        "Answer as the candidate in first person, not as an AI assistant or coach.",
        "Use the imported candidate profile and interview material as the primary source. Pull concrete facts from it when relevant.",
        "Do not invent experience. If the material lacks a specific fact, give a natural answer angle without fabricating numbers or names.",
        "Focus areas: engineering/technical, market development/channel expansion for Hengtong International, management/business, tendering/bidding.",
        "",
        "=== CANDIDATE PROFILE ===",
        profile || "(Profile file is empty.)",
        "",
        "=== TARGET ROLE / JD ===",
        job || "(Job file is empty.)",
        "",
        "=== OUTPUT FORMAT ===",
        "Return exactly this structure without markdown bold:",
        "Q: 中文问题。 English question.",
        "回答: 中文回答 1-2 句，直接像本人在面试中回答。English answer 1-2 spoken sentences with the same meaning.",
        "Rules: Chinese first, then English. Use profile facts. No coaching labels. No markdown."
      ].join("\n")
    },
    {
      role: "user",
      content: question
    }
  ];
}

async function translateText(text, id, clientWs) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !text) return;

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: "Translate between English and Chinese only. If input is English, output concise Chinese. If input is Chinese, output concise English. Output translation only."
        },
        { role: "user", content: text }
      ],
      temperature: 0,
      max_tokens: 160,
      stream: false
    })
  });

  if (!response.ok) return;
  const data = await response.json();
  const translated = data.choices?.[0]?.message?.content?.trim();
  if (translated) {
    sendJson(clientWs, { type: "translation", id, text: translated });
  }
}

async function askDeepSeek(question, clientWs, material) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    sendJson(clientWs, {
      type: "answer",
      question,
      text: "DeepSeek API key is missing. Add DEEPSEEK_API_KEY to .env and restart."
    });
    return;
  }

  sendJson(clientWs, { type: "answer_start", question });

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: buildPrompt(question, material),
      temperature: 0,
      max_tokens: 650,
      stream: true
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`DeepSeek error ${response.status}: ${body}`);
  }

  let fullText = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            sendJson(clientWs, { type: "answer_delta", text: content });
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }

  const finalText = fullText.trim();
  sendJson(clientWs, { type: "answer_done", text: finalText });
}

function handleConnection(clientWs) {
  // Dual Deepgram connections for Chinese-English bilingual support
  const asrConns = Object.create(null);
  let finalBuffer = "";
  let userMaterial = "";
  // Per-language state to avoid zh/en connections interfering with each other
  const partialText = { zh: "", en: "" };
  const lastPromotedFinal = { zh: "", en: "" };
  const lastPromotedFinalAt = { zh: 0, en: 0 };
  let questionTimer = null;
  let asking = false;
  let lastAnswerAt = 0;
  let iflytekSeq = 1;
  let iflytekNextStatus = 0;
  let iflytekBytesSent = 0;
  let iflytekHasSpeech = false;
  let iflytekSilenceFrames = 0;
  let iflytekCloseTimer = null;
  let listening = false;
  const iflytekMaxBytesPerSession = 16000 * 2 * 50;
  const iflytekSpeechThreshold = 180;
  const iflytekSilenceFramesToEnd = 10;

  async function generateAnswer(question, force = false) {
    const normalized = normalizeTranscript(question);
    if (!normalized || asking) return;
    if (!force && !looksLikeQuestion(normalized)) return;

    const now = Date.now();
    if (!force && now - lastAnswerAt < 10000) return;

    finalBuffer = "";
    partialText.zh = "";
    partialText.en = "";
    asking = true;
    lastAnswerAt = now;
    try {
      await askDeepSeek(normalized, clientWs, userMaterial);
    } catch (error) {
      sendJson(clientWs, { type: "error", message: error.message });
    } finally {
      asking = false;
    }
  }

  function scheduleQuestionCheck() {
    clearTimeout(questionTimer);
    questionTimer = setTimeout(async () => {
      await generateAnswer(finalBuffer || partialText.en || partialText.zh);
    }, QUESTION_IDLE_MS);
  }

  function connectAsr(language) {
    if (ASR_PROVIDER === "deepgram") {
      // Open dual connections: zh-CN for Chinese, en-US for English
      // Both receive the same audio; results are merged by confidence
      connectDeepgramAsr("zh-CN", "zh");
      connectDeepgramAsr("en-US", "en");
      return;
    }

    if (ASR_PROVIDER === "iflytek") {
      connectIflytekAsr();
      return;
    }

    sendJson(clientWs, {
      type: "error",
      message: `Unsupported ASR_PROVIDER "${ASR_PROVIDER}". Use "deepgram" or "iflytek".`
    });
  }

  function handleAsrResult(result) {
    if (!result) return;
    if (result.type === "error") {
      sendJson(clientWs, { type: "error", message: result.text });
      return;
    }

    // Skip very low confidence results (garbled output from wrong language connection)
    const confidence = typeof result.confidence === "number" ? result.confidence : 0;
    if (confidence > 0 && confidence < 0.5) return;

    const text = normalizeTranscript(result.text);
    if (!text) return;
    if (!isChineseEnglishOnly(text)) return;

    const lang = (result.language === "zh" || result.language === "en") ? result.language : "unknown";
    // Filter garbled cross-language output (e.g., zh channel producing "syc" for English speech)
    if (!isTextMatchingLanguage(text, lang)) return;
    const lk = lang === "unknown" ? "en" : lang;

    if (result.type === "final") {
      if (text === lastPromotedFinal[lk] && Date.now() - lastPromotedFinalAt[lk] < 3000) return;
      lastPromotedFinal[lk] = text;
      lastPromotedFinalAt[lk] = Date.now();
      finalBuffer = normalizeTranscript(`${finalBuffer} ${text}`);
      partialText[lk] = "";
      sendJson(clientWs, { type: "transcript_final", text, language: lang, buffer: finalBuffer });
      scheduleQuestionCheck();
    } else {
      partialText[lk] = text;
      sendJson(clientWs, { type: "transcript_partial", text, language: lang });
      if (ASR_PROVIDER === "iflytek" && iflytekNextStatus === 0) {
        promotePartialToFinal();
      }
    }
  }
  function connectAsr(language) {
    if (ASR_PROVIDER === "deepgram") {
      // Open dual connections: zh-CN for Chinese, en-US for English
      // Both receive the same audio; results are merged by confidence
      connectDeepgramAsr("zh-CN", "zh");
      connectDeepgramAsr("en-US", "en");
      return;
    }

    if (ASR_PROVIDER === "iflytek") {
      connectIflytekAsr();
      return;
    }

    sendJson(clientWs, {
      type: "error",
      message: `Unsupported ASR_PROVIDER "${ASR_PROVIDER}". Use "deepgram" or "iflytek".`
    });
  }


  function promotePartialToFinal() {
    // iFlytek only — use en key for single-connection mode
    const lk = "en";
    if (!partialText[lk]) return;
    const promoted = normalizeTranscript(partialText[lk]);
    if (!promoted) return;

    lastPromotedFinal[lk] = promoted;
    lastPromotedFinalAt[lk] = Date.now();
    finalBuffer = normalizeTranscript(`${finalBuffer} ${promoted}`);
    partialText[lk] = "";
    sendJson(clientWs, { type: "transcript_final", text: promoted, buffer: finalBuffer });
    scheduleQuestionCheck();
  }

  function connectDeepgramAsr(language, langKey) {
    const key = langKey || language;
    try {
      const resolvedLanguage = resolveDeepgramLanguage(language);
      const url = buildDeepgramUrl(resolvedLanguage);
      console.log(`[deepgram-${key}] connecting, language: ${resolvedLanguage}`);
      const conn = new WebSocket(url, {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
        }
      });
      asrConns[key] = conn;

      conn.on("open", () => {
        console.log(`[deepgram-${key}] websocket opened OK`);
        sendJson(clientWs, { type: "status", message: `Deepgram ${key} ASR connected.` });
      });

      conn.on("message", (data) => {
        const raw = data.toString();
        if (process.env.DEBUG_ASR === "1") console.log(`[deepgram-${key}] raw:`, raw.slice(0, 400));
        handleAsrResult(extractDeepgramText(raw, key));
      });

      conn.on("close", (code, reason) => {
        console.log(`[deepgram-${key}] closed, code:`, code);
        asrConns[key] = null;
      });

      conn.on("error", (error) => {
        console.error(`[deepgram-${key}] error:`, error.message);
        sendJson(clientWs, { type: "error", message: `Deepgram ${key} error: ${error.message}` });
      });
    } catch (error) {
      console.error(`[deepgram-${key}] build error:`, error.message);
      sendJson(clientWs, { type: "error", message: error.message });
    }
  }
  function connectIflytekAsr() {
    try {
      iflytekSeq = 1;
      iflytekNextStatus = 0;
      iflytekBytesSent = 0;
      iflytekHasSpeech = false;
      iflytekSilenceFrames = 0;
      clearTimeout(iflytekCloseTimer);
      iflytekCloseTimer = null;
      asrConns.iflytek = new WebSocket(buildIflytekUrl(), { perMessageDeflate: false });
    } catch (error) {
      sendJson(clientWs, { type: "error", message: error.message });
      return;
    }

    asrConns.iflytek.on("open", () => {
	      console.log("[deepgram] websocket opened, language:", resolveDeepgramLanguage(language));
      sendJson(clientWs, { type: "status", message: "Connected to iFlytek realtime ASR." });
    });

    asrConns.iflytek.on("message", (data) => {
      if (process.env.DEBUG_ASR === "1") {
        console.log("[iflytek raw]", data.toString().slice(0, 600));
      }
      handleAsrResult(extractIflytekText(data.toString()));
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed?.payload?.result?.status === 2 || parsed?.header?.status === 2) {
          clearTimeout(iflytekCloseTimer);
          iflytekCloseTimer = setTimeout(() => asrConns.iflytek?.close(), 120);
        }
      } catch {}
    });

    asrConns.iflytek.on("close", () => {
	      console.log("[deepgram] closed, code:", code, "reason:", String(reason || "").slice(0, 200));
      if (ASR_PROVIDER === "iflytek") promotePartialToFinal();
      sendJson(clientWs, { type: "status", message: "iFlytek ASR connection closed." });
      if (listening && ASR_PROVIDER === "iflytek" && clientWs.readyState === WebSocket.OPEN) {
        setTimeout(() => {
          if (listening && (!asrConns.iflytek || asrConns.iflytek.readyState === WebSocket.CLOSED)) {
            connectIflytekAsr();
          }
        }, 120);
      }
    });

    asrConns.iflytek.on("error", (error) => {
	      console.error("[deepgram] error:", error.message);
      sendJson(clientWs, { type: "error", message: `iFlytek ASR connection error: ${error.message}` });
    });
  }

  function getPcmRms(frame) {
    const buffer = Buffer.from(frame);
    let sum = 0;
    let count = 0;
    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      sum += sample * sample;
      count += 1;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  function endIflytekUtterance() {
    if (asrConns.iflytek?.readyState !== WebSocket.OPEN || iflytekNextStatus === 0) return;
    promotePartialToFinal();
    asrConns.iflytek?.send(buildIflytekAudioFrame(Buffer.alloc(0), 2, iflytekSeq++));
    iflytekNextStatus = 0;
    iflytekHasSpeech = false;
    iflytekSilenceFrames = 0;
    clearTimeout(iflytekCloseTimer);
    iflytekCloseTimer = setTimeout(() => asrConns.iflytek?.close(), 1200);
  }

  clientWs.on("message", (data, isBinary) => {
    if (!isBinary) {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (message.type === "start") {
        console.log("[server] client start, language:", message.language, "ASR_PROVIDER:", ASR_PROVIDER);
        listening = true;
        connectAsr(message.language);
      }

      if (message.type === "ping") {
        sendJson(clientWs, { type: "status", message: `pong ${APP_VERSION}` });
      }

      if (message.type === "stop") {
        listening = false;
        if (ASR_PROVIDER === "iflytek") endIflytekUtterance();
        asrConns.iflytek?.close();
        // Clear all connections
        for (const key of Object.keys(asrConns)) { delete asrConns[key]; }
      }

      if (message.type === "set_material") {
        userMaterial = message.text || "";
        // 写入临时文件供 AI 使用
        if (userMaterial) {
          fs.writeFileSync(path.join(dataDir, "temp_profile.md"), userMaterial, "utf8");
        }
        sendJson(clientWs, { type: "status", message: `资料已更新 (${userMaterial.length} 字符)` });
      }

      if (message.type === "generate_answer") {
        sendJson(clientWs, { type: "status", message: "Generating outline..." });
        generateAnswer(message.text || finalBuffer || partialText.en || partialText.zh, true);
      }

      if (message.type === "translate_text") {
        translateText(message.text, message.id || "current", clientWs).catch(() => {});
      }

      return;
    }

    if (ASR_PROVIDER === "iflytek" && asrConns.iflytek?.readyState === WebSocket.OPEN) {
      const rms = getPcmRms(data);
      const hasVoice = rms >= iflytekSpeechThreshold;
      if (!hasVoice && iflytekNextStatus === 0) return;

      if (iflytekBytesSent >= iflytekMaxBytesPerSession && iflytekNextStatus !== 0) {
        endIflytekUtterance();
        return;
      }

      const frameStatus = iflytekNextStatus;
      asrConns.iflytek?.send(buildIflytekAudioFrame(data, frameStatus, iflytekSeq++));
      iflytekNextStatus = 1;
      iflytekBytesSent += data.byteLength || data.length || 0;

      if (hasVoice) {
        iflytekHasSpeech = true;
        iflytekSilenceFrames = 0;
      } else if (iflytekHasSpeech) {
        iflytekSilenceFrames += 1;
        if (iflytekSilenceFrames >= iflytekSilenceFramesToEnd) {
          endIflytekUtterance();
        }
      }
      return;
    }

    // Fan out audio to all active Deepgram connections
    for (const [key, conn] of Object.entries(asrConns)) {
      if (conn?.readyState === WebSocket.OPEN) {
        conn.send(data);
      }
    }
  });

  clientWs.on("close", () => {
    listening = false;
    clearTimeout(questionTimer);
    clearTimeout(iflytekCloseTimer);
    if (ASR_PROVIDER === "iflytek") endIflytekUtterance();
    asrConns.iflytek?.close();
  });

  sendJson(clientWs, {
    type: "status",
    message: `Local client connected (${APP_VERSION}). Choose an audio input and start listening.`
  });
}

wss.on("connection", handleConnection);

server.listen(PORT, () => {
  console.log(`InterviewGo running at http://localhost:${PORT}`);
  console.log(`  (桌面版 Electron 用 http://localhost:${PORT}/overlay.html)`);
});

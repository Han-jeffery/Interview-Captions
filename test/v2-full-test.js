#!/usr/bin/env node
/**
 * ITC-View V2 全流程自动化验收
 * 测试: 健康检查 → 激活码 → 管理后台 → WebSocket → AI答题 → 资料上传
 */

const http = require("node:http");
const WebSocket = require("ws");

const BASE = process.env.TEST_HOST || "http://localhost:3211";
const WS = BASE.replace("http", "ws");
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PWD || "itcview2026";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${name}: ${e.message}`);
      failed++;
      failures.push({ name, error: e.message });
    }
  };
}

function httpReq(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, ...JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data.slice(0, 200) });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/ws`);
    const timer = setTimeout(() => { ws.close(); reject(new Error("WS 连接超时 (10s)")); }, 10000);
    ws.on("open", () => { clearTimeout(timer); resolve(ws); });
    ws.on("error", (e) => { clearTimeout(timer); reject(new Error(`WS 连接失败: ${e.message}`)); });
  });
}

function wsWait(ws, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时 (${timeoutMs/1000}s)`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) { clearTimeout(timer); ws.removeListener("message", handler); resolve(msg); }
        if (msg.type === "error") { clearTimeout(timer); ws.removeListener("message", handler); reject(new Error(msg.message)); }
      } catch {}
    };
    ws.on("message", handler);
  });
}

async function main() {
  console.log("\n🔍 ITC-View V2 全流程验收");
  console.log(`   目标: ${BASE}\n`);
  console.log("━".repeat(50));

  // ── 1. 健康检查 ──
  console.log("\n📡 1. 服务健康检查");
  await test("健康端点 (/health)", async () => {
    const r = await httpReq("GET", "/health");
    if (r.status !== 200 || !r.ok) throw new Error("服务无响应");
    if (!r.deepseek) throw new Error("DeepSeek 未配置");
    if (!r.deepgram) throw new Error("Deepgram 未配置");
  })();

  // ── 2. 激活码系统 ──
  console.log("\n🔑 2. 激活码系统");
  let testCode;

  await test("管理后台登录 (正确密码)", async () => {
    const r = await httpReq("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
    if (!r.ok || !r.token) throw new Error("登录失败");
  })();

  await test("管理后台登录 (错误密码应拒绝)", async () => {
    const r = await httpReq("POST", "/api/admin/login", { password: "wrong" });
    if (r.ok) throw new Error("应拒绝错误密码");
  })();

  await test("生成激活码", async () => {
    const r = await httpReq("POST", "/api/admin/generate", { password: ADMIN_PASSWORD, count: 1 });
    if (!r.ok || !r.codes || r.codes.length === 0) throw new Error("生成失败");
    testCode = r.codes[0];
    console.log(`      📟 新码: ${testCode}`);
  })();

  await test("激活码验证 (未使用的码)", async () => {
    const r = await httpReq("POST", "/api/activate", { code: testCode });
    if (!r.ok || !r.token) throw new Error(`激活失败: ${r.error}`);
    if (r.daysLeft !== 30) throw new Error(`剩余天数应为30，实际: ${r.daysLeft}`);
  })();

  await test("Token 验证", async () => {
    // 获取已激活的 token
    const activate = await httpReq("POST", "/api/activate", { code: testCode });
    const r = await httpReq("POST", "/api/verify-token", { token: activate.token });
    if (!r.ok) throw new Error("Token 验证失败");
  })();

  await test("无效激活码应拒绝", async () => {
    const r = await httpReq("POST", "/api/activate", { code: "XXXX-XXXX-XXXX-XXXX" });
    if (r.ok) throw new Error("应拒绝无效码");
  })();

  await test("查看激活码列表", async () => {
    const r = await httpReq("GET", `/api/admin/codes?password=${ADMIN_PASSWORD}`);
    if (!r.ok || !Array.isArray(r.codes)) throw new Error("获取列表失败");
    console.log(`      📋 共 ${r.codes.length} 个码`);
  })();

  // ── 3. WebSocket + AI 答题 ──
  console.log("\n🔌 3. WebSocket & AI 答题");

  await test("WebSocket 连接", async () => {
    const ws = await wsConnect();
    ws.close();
  })();

  await test("WebSocket 启动 + 接收状态", async () => {
    const ws = await wsConnect();
    ws.send(JSON.stringify({ type: "start", language: "zh-CN" }));
    const msg = await wsWait(ws, "status");
    if (!msg.message) throw new Error("未收到状态消息");
    ws.close();
  })();

  await test("AI 答题生成 (DeepSeek)", async () => {
    const ws = await wsConnect();
    ws.send(JSON.stringify({ type: "start", language: "zh-CN" }));
    await wsWait(ws, "status", 5000);

    ws.send(JSON.stringify({ type: "generate_answer", text: "请做个自我介绍" }));
    const startMsg = await wsWait(ws, "answer_start", 5000);
    if (!startMsg.question) throw new Error("未收到问题确认");

    // 等待完整答案
    const answerMsg = await wsWait(ws, "answer", 45000);
    if (!answerMsg.text || answerMsg.text.length < 5) throw new Error(`答案太短: "${answerMsg.text}"`);
    console.log(`      💬 答案预览: ${answerMsg.text.slice(0, 60)}... (${answerMsg.text.length} 字符)`);
    ws.close();
  })();

  // ── 4. 资料功能 ──
  console.log("\n📁 4. 资料功能");

  await test("资料上传 (WebSocket set_material)", async () => {
    const ws = await wsConnect();
    ws.send(JSON.stringify({ type: "start", language: "zh-CN" }));
    await wsWait(ws, "status", 5000);

    ws.send(JSON.stringify({ type: "set_material", text: "测试资料：候选人精通 Python 和机器学习" }));
    const msg = await wsWait(ws, "status", 5000);
    if (!msg.message.includes("资料")) throw new Error(`未确认资料: ${msg.message}`);
    ws.close();
  })();

  await test("资料上传后 AI 使用资料作答", async () => {
    const ws = await wsConnect();
    ws.send(JSON.stringify({ type: "start", language: "zh-CN" }));
    await wsWait(ws, "status", 5000);

    ws.send(JSON.stringify({ type: "set_material", text: "测试资料：候选人精通 Python 和机器学习" }));
    await wsWait(ws, "status", 5000);

    ws.send(JSON.stringify({ type: "generate_answer", text: "你擅长什么技术？" }));
    await wsWait(ws, "answer_start", 5000);
    const answerMsg = await wsWait(ws, "answer", 30000);

    const text = answerMsg.text.toLowerCase();
    const hasKeyword = text.includes("python") || text.includes("机器学习") || text.includes("machine learning");
    if (!hasKeyword) throw new Error(`答案未引用资料，内容: "${answerMsg.text.slice(0, 80)}"`);
    console.log(`      💬 资料相关答案: ${answerMsg.text.slice(0, 80)}...`);
    ws.close();
  })();

  // ── 总结 ──
  console.log("\n" + "━".repeat(50));
  const total = passed + failed;
  console.log(`\n📊 结果: ${passed}/${total} 通过`);
  if (failed > 0) {
    console.log(`\n❌ 失败项:`);
    failures.forEach((f) => console.log(`   - ${f.name}: ${f.error}`));
    process.exit(1);
  } else {
    console.log("🎉 全部通过！\n");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("\n💥 测试脚本异常:", e.message);
  process.exit(1);
});

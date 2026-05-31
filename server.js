#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

const SERVICE = "microbit-agent";
const PORT = Number(process.env.PORT || 3097);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);

// LLM configuration — default to local Ollama for offline/classroom use
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);
const AUTO_APPROVE = ["1", "true", "yes", "on"].includes(String(process.env.AUTO_APPROVE || "").toLowerCase());

const OUT_DIR = path.join(__dirname, "out");
const REQUESTS_DIR = path.join(OUT_DIR, "requests");

const ACTIONS = [
  "submit_help",
  "list_requests",
  "get_request",
  "review_request",
  "get_response"
];

// ─── Utilities ────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res, html) {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, {
    ...corsHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-length": buf.length
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

// ─── Request persistence ──────────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
}

function requestPath(id) {
  return path.join(REQUESTS_DIR, `${id}.json`);
}

function saveRequest(request) {
  ensureDirs();
  fs.writeFileSync(requestPath(request.id), JSON.stringify(request, null, 2) + "\n");
}

function loadRequest(id) {
  const filePath = requestPath(String(id || "").trim());
  if (!fs.existsSync(filePath)) throw new Error(`Request not found: ${id}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listAllRequests() {
  ensureDirs();
  return fs.readdirSync(REQUESTS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REQUESTS_DIR, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// ─── LLM integration ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a friendly helper for kids learning to code with the BBC micro:bit.
You help children aged 8-14 understand and fix their micro:bit programs in either MicroPython or JavaScript/MakeCode.

Your rules:
- Explain things simply, as if talking to a 10-year-old
- Be encouraging and positive — celebrate what they got right
- Point to the specific part of the code that needs attention (say "on line X" or "look at the part where you wrote...")
- Give ONE hint at a time — never write the whole solution for them
- Use simple words and avoid technical jargon
- Suggest they try one small change and see what happens
- Keep your reply to 3-5 short sentences
- If you spot any inappropriate content in the question or code, start your reply with [FLAG] on its own line`;

function detectLanguage(code = "") {
  const s = String(code).trim().toLowerCase();
  if (!s) return "python";

  const jsSignals = [
    "basic.",
    "input.",
    "led.",
    "pins.",
    "forever(",
    "function (",
    "function(",
    "let ",
    "const ",
    "=>"
  ];
  if (jsSignals.some((x) => s.includes(x))) return "javascript";

  const pySignals = [
    "from microbit import",
    "import microbit",
    "while true:",
    "def ",
    "display.",
    "button_a",
    "button_b",
    "sleep("
  ];
  if (pySignals.some((x) => s.includes(x))) return "python";

  return "python";
}

function buildUserMessage(request) {
  const { studentName, code, question, helpType } = request;
  const language = detectLanguage(code);
  const fence = language === "javascript" ? "javascript" : "python";
  const languageLabel = language === "javascript" ? "JavaScript (MakeCode style)" : "MicroPython";
  const action = helpType === "extend"
    ? "trying to add something new to"
    : "trying to fix a problem in";
  return `${studentName} is ${action} their micro:bit project.

They said: "${question}"

Language: ${languageLabel}

Their code:
\`\`\`${fence}
${code}
\`\`\`

Please give ${studentName} a helpful hint. Use the same language as their code (${languageLabel}). Remember: one hint, keep it simple and encouraging!`;
}

async function callOllama(userMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        stream: false
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message?.content || data.response || "";
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(userMessage) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }]
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text || "";
  } finally {
    clearTimeout(timer);
  }
}

async function generateHint(request) {
  const userMessage = buildUserMessage(request);
  if (LLM_PROVIDER === "anthropic") return callAnthropic(userMessage);
  return callOllama(userMessage);
}

function runLlmAsync(requestId) {
  setImmediate(async () => {
    try {
      let request = loadRequest(requestId);
      request.status = "pending_llm";
      saveRequest(request);
      const hint = await generateHint(request);
      request = loadRequest(requestId);
      if (request.status === "pending_llm") {
        request.llmSuggestion = hint.trim();
        request.flagged = hint.trimStart().startsWith("[FLAG]");
        if (AUTO_APPROVE && !request.flagged) {
          request.finalResponse = request.llmSuggestion;
          request.status = "approved";
          request.teacherNote = "Auto-approved by server setting AUTO_APPROVE.";
          request.reviewedAt = nowIso();
        } else {
          request.status = "pending_review";
        }
        request.llmAt = nowIso();
        saveRequest(request);
        console.log(`[llm] ${requestId}: hint ready (${hint.length} chars${request.flagged ? ", FLAGGED" : ""}${AUTO_APPROVE ? ", AUTO_APPROVE_ON" : ""})`);
      }
    } catch (err) {
      console.error(`[llm] ${requestId} failed:`, err.message || err);
      try {
        const r = loadRequest(requestId);
        r.status = "llm_error";
        r.llmError = err.message || String(err);
        saveRequest(r);
      } catch {}
    }
  });
}

// ─── Action handlers ──────────────────────────────────────────────────────────

function handleSubmitHelp(params) {
  const studentName = String(params.studentName || "").trim().slice(0, 60);
  const code = String(params.code || "").trim();
  const question = String(params.question || "").trim().slice(0, 1000);
  const helpType = String(params.helpType || "debug").trim();
  const className = String(params.className || "").trim().slice(0, 60);

  if (!studentName) throw new Error("studentName is required");
  if (!code) throw new Error("code is required");
  if (!question) throw new Error("question is required");
  if (!["debug", "extend"].includes(helpType)) throw new Error("helpType must be 'debug' or 'extend'");

  const id = crypto.randomUUID();
  const request = {
    id,
    studentName,
    className,
    code,
    question,
    helpType,
    status: "queued",
    llmSuggestion: null,
    llmAt: null,
    llmError: null,
    flagged: false,
    teacherNote: null,
    finalResponse: null,
    submittedAt: nowIso(),
    reviewedAt: null
  };
  saveRequest(request);
  runLlmAsync(id);
  return { ok: true, id, status: "queued" };
}

function handleListRequests(params) {
  const statusFilter = params.status ? String(params.status).trim() : null;
  let requests = listAllRequests();
  if (statusFilter) requests = requests.filter(r => r.status === statusFilter);
  return {
    ok: true,
    count: requests.length,
    requests: requests.map(r => ({
      id: r.id,
      studentName: r.studentName,
      className: r.className,
      helpType: r.helpType,
      status: r.status,
      flagged: r.flagged,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt
    }))
  };
}

function handleGetRequest(params) {
  const id = String(params.id || "").trim();
  if (!id) throw new Error("id is required");
  return { ok: true, request: loadRequest(id) };
}

function handleReviewRequest(params) {
  const id = String(params.id || "").trim();
  const decision = String(params.decision || "").trim();
  const teacherNote = String(params.teacherNote || "").trim();
  const editedResponse = String(params.editedResponse || "").trim();

  if (!id) throw new Error("id is required");
  if (!["approve", "reject"].includes(decision)) throw new Error("decision must be 'approve' or 'reject'");

  const request = loadRequest(id);
  request.teacherNote = teacherNote || null;
  request.reviewedAt = nowIso();

  if (decision === "approve") {
    request.finalResponse = editedResponse || request.llmSuggestion || "";
    request.status = "approved";
  } else {
    request.finalResponse = teacherNote || "Your teacher will come and help you in person.";
    request.status = "rejected";
  }
  saveRequest(request);
  return { ok: true, id, status: request.status };
}

function handleGetResponse(params) {
  const id = String(params.id || "").trim();
  if (!id) throw new Error("id is required");
  const r = loadRequest(id);
  const base = { ok: true, id, status: r.status, studentName: r.studentName, helpType: r.helpType, submittedAt: r.submittedAt };
  if (r.status === "approved" || r.status === "rejected") {
    return { ...base, response: r.finalResponse };
  }
  return base;
}

async function handleAction(action, params) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`);
  if (action === "submit_help") return handleSubmitHelp(params);
  if (action === "list_requests") return handleListRequests(params);
  if (action === "get_request") return handleGetRequest(params);
  if (action === "review_request") return handleReviewRequest(params);
  if (action === "get_response") return handleGetResponse(params);
  throw new Error(`unhandled action: ${action}`);
}

// ─── Student HTML ─────────────────────────────────────────────────────────────

const STUDENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>micro:bit Help Desk</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f0f4ff;color:#1a1a2e;min-height:100vh;padding:1rem}
    .container{max-width:680px;margin:0 auto}
    header{text-align:center;padding:2rem 0 1.5rem}
    header h1{font-size:2rem;color:#5c2d91}
    header p{color:#555;margin-top:.5rem}
    .card{background:white;border-radius:12px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.08);margin-bottom:1rem}
    label{display:block;font-weight:600;color:#333;margin-bottom:.4rem;margin-top:1.2rem}
    label:first-of-type{margin-top:0}
    input,select,textarea{width:100%;padding:.7rem;border:2px solid #ddd;border-radius:8px;font-size:1rem;font-family:inherit}
    input:focus,textarea:focus{outline:none;border-color:#5c2d91}
    textarea.code{font-family:'Courier New',monospace;font-size:.88rem;background:#1a1a2e;color:#a8ff78;border-color:#1a1a2e;resize:vertical}
    .btn{display:block;width:100%;padding:1rem;border:none;border-radius:10px;font-size:1.1rem;font-weight:bold;cursor:pointer;margin-top:1.5rem;transition:background .15s}
    .btn-primary{background:#5c2d91;color:white}
    .btn-primary:hover{background:#7b3fbd}
    .btn-secondary{background:#eee;color:#333;margin-top:.8rem;font-size:1rem}
    .btn-secondary:hover{background:#ddd}
    .ht-group{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin-top:.5rem}
    .ht-btn{border:2px solid #ddd;border-radius:10px;padding:1rem;cursor:pointer;text-align:center;background:white;transition:all .15s}
    .ht-btn.selected{border-color:#5c2d91;background:#f5f0ff}
    .ht-btn .emoji{font-size:1.8rem;display:block;margin-bottom:.3rem}
    .ht-btn .lbl{font-weight:600;font-size:.9rem}
    .ht-btn .desc{font-size:.78rem;color:#666;margin-top:.2rem}
    .status-card{border-left:5px solid #5c2d91}
    .ref-code{font-family:monospace;font-size:1.5rem;color:#5c2d91;font-weight:bold;letter-spacing:.05em;background:#f5f0ff;padding:.5rem 1rem;border-radius:6px;display:inline-block;margin:.5rem 0}
    .badge{display:inline-block;padding:.3rem .8rem;border-radius:20px;font-size:.85rem;font-weight:600;margin-bottom:1rem}
    .badge-wait{background:#fef3c7;color:#92400e}
    .badge-check{background:#dbeafe;color:#1e40af}
    .badge-ready{background:#d1fae5;color:#065f46}
    .response-box{background:#f0fdf4;border:2px solid #10b981;border-radius:10px;padding:1.2rem;margin-top:1rem;line-height:1.6;white-space:pre-wrap}
    .spinner{display:inline-block;width:1rem;height:1rem;border:2px solid #ddd;border-top-color:#5c2d91;border-radius:50%;animation:spin .8s linear infinite;margin-right:.5rem;vertical-align:middle}
    @keyframes spin{to{transform:rotate(360deg)}}
    .small{font-size:.85rem;color:#666}
    .hidden{display:none}
    h2{font-size:1.3rem;color:#5c2d91;margin-bottom:.5rem}
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>🔧 micro:bit Help Desk</h1>
    <p>Stuck on your project? Ask for a hint!</p>
  </header>

  <div id="formView">
    <div class="card">
      <label>Your first name</label>
      <input type="text" id="studentName" placeholder="e.g. Alex" maxlength="40" autocomplete="off">

      <label>What do you need help with?</label>
      <div class="ht-group">
        <div class="ht-btn selected" id="btn-debug" onclick="selectHT('debug')">
          <span class="emoji">🐛</span>
          <div class="lbl">Fix a bug</div>
          <div class="desc">Something isn't working</div>
        </div>
        <div class="ht-btn" id="btn-extend" onclick="selectHT('extend')">
          <span class="emoji">✨</span>
          <div class="lbl">Add something new</div>
          <div class="desc">Make it do more</div>
        </div>
      </div>

      <label>Describe the problem or what you want to add</label>
      <textarea id="question" rows="3" placeholder="e.g. My LED display shows nothing when I press button A" maxlength="500"></textarea>

      <label>Paste your micro:bit code here</label>
      <textarea id="code" class="code" rows="15" placeholder="from microbit import *&#10;&#10;# paste your code here..."></textarea>

      <button class="btn btn-primary" onclick="submitHelp()">Ask for a Hint 🙋</button>
    </div>
  </div>

  <div id="statusView" class="hidden">
    <div class="card status-card" id="statusCard">
      <div id="statusBadge" class="badge badge-wait">Sending...</div>
      <h2 id="statusTitle">Your request was sent!</h2>
      <p id="statusMsg"><span class="spinner"></span>Getting a hint ready...</p>
      <div id="refCodeBox" style="margin-top:1rem">
        <p class="small">Your reference code:</p>
        <span class="ref-code" id="refCode"></span>
        <p class="small">Keep this in case you need it later.</p>
      </div>
      <div id="responseBox" class="response-box hidden"></div>
      <button class="btn btn-secondary" onclick="checkStatus()">Check again 🔄</button>
      <button class="btn btn-secondary" onclick="startOver()">New request</button>
    </div>
  </div>
</div>
<script>
let currentId = null;
let pollTimer = null;
let helpType = 'debug';

function selectHT(type) {
  helpType = type;
  document.getElementById('btn-debug').classList.toggle('selected', type === 'debug');
  document.getElementById('btn-extend').classList.toggle('selected', type === 'extend');
}

async function submitHelp() {
  const studentName = document.getElementById('studentName').value.trim();
  const question = document.getElementById('question').value.trim();
  const code = document.getElementById('code').value.trim();
  if (!studentName) { alert('Please enter your name!'); return; }
  if (!question) { alert('Please describe what you need help with!'); return; }
  if (!code) { alert('Please paste your code!'); return; }
  try {
    const res = await fetch('/run', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({action: 'submit_help', params: {studentName, question, code, helpType}})
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Submit failed');
    currentId = data.id;
    document.getElementById('refCode').textContent = currentId.slice(0,8).toUpperCase();
    document.getElementById('formView').classList.add('hidden');
    document.getElementById('statusView').classList.remove('hidden');
    updateDisplay('queued', null);
    startPolling();
  } catch(err) { alert('Something went wrong: ' + err.message); }
}

function updateDisplay(status, response) {
  const badge = document.getElementById('statusBadge');
  const title = document.getElementById('statusTitle');
  const msg = document.getElementById('statusMsg');
  const responseBox = document.getElementById('responseBox');
  responseBox.classList.add('hidden');
  const states = {
    queued:         {cls:'badge-wait',  text:'Sending... ⏳',        t:'Your request was sent!',              m:'<span class="spinner"></span>Getting a hint ready for you...'},
    pending_llm:    {cls:'badge-check', text:'Reading your code 🤔', t:'Your code is being checked!',          m:'<span class="spinner"></span>The helper is reading your code...'},
    pending_review: {cls:'badge-check', text:'With teacher 👩‍🏫',    t:'Your hint is with your teacher!',     m:'Your teacher is checking your hint before you see it. Nearly there! 😊'},
    llm_error:      {cls:'badge-wait',  text:'Sorry 😅',              t:'Hmm, something went a bit wrong',     m:'Your teacher will come and help you directly.'},
    approved:       {cls:'badge-ready', text:'Hint ready! 💡',        t:"Here's your hint!",                   m:''},
    rejected:       {cls:'badge-wait',  text:'See your teacher 👋',   t:'Your teacher will help you in person', m:''}
  };
  const s = states[status] || states.queued;
  badge.className = 'badge ' + s.cls;
  badge.innerHTML = s.text;
  title.textContent = s.t;
  msg.innerHTML = s.m;
  if ((status === 'approved' || status === 'rejected') && response) {
    responseBox.classList.remove('hidden');
    responseBox.textContent = response;
    stopPolling();
  }
  if (status === 'llm_error') stopPolling();
}

async function checkStatus() {
  if (!currentId) return;
  try {
    const res = await fetch('/run', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({action: 'get_response', params: {id: currentId}})
    });
    const data = await res.json();
    if (data.ok) updateDisplay(data.status, data.response || null);
  } catch {}
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(checkStatus, 6000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startOver() {
  stopPolling();
  currentId = null;
  document.getElementById('statusView').classList.add('hidden');
  document.getElementById('formView').classList.remove('hidden');
}
</script>
</body>
</html>`;

// ─── Teacher HTML ─────────────────────────────────────────────────────────────

const TEACHER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Teacher Dashboard — micro:bit Help</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e}
    header{background:#1a1a2e;color:white;padding:1rem 2rem;display:flex;justify-content:space-between;align-items:center}
    header h1{font-size:1.2rem}
    .count-badge{background:#5c2d91;color:white;padding:.3rem .8rem;border-radius:20px;font-size:.85rem}
    main{max-width:920px;margin:0 auto;padding:1.5rem}
    .toolbar{display:flex;gap:.5rem;margin-bottom:1.5rem;flex-wrap:wrap;align-items:center}
    .filter-btn{border:2px solid #ddd;background:white;padding:.5rem 1.2rem;border-radius:20px;cursor:pointer;font-size:.9rem;font-weight:500}
    .filter-btn.active{border-color:#5c2d91;background:#5c2d91;color:white}
    .refresh-btn{margin-left:auto;background:#eee;border:none;padding:.5rem 1rem;border-radius:20px;cursor:pointer;font-size:.9rem}
    .refresh-btn:hover{background:#ddd}
    .req-card{background:white;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.06);margin-bottom:.8rem;overflow:hidden;border-left:5px solid #ddd;transition:box-shadow .15s}
    .req-card:hover{box-shadow:0 3px 12px rgba(0,0,0,.1)}
    .req-card.st-pending_review{border-left-color:#f59e0b}
    .req-card.st-approved{border-left-color:#10b981}
    .req-card.st-rejected{border-left-color:#9ca3af}
    .req-card.st-llm_error{border-left-color:#ef4444}
    .req-card.flagged{border-left-color:#dc2626!important}
    .card-hdr{padding:1rem 1.2rem;display:flex;align-items:center;gap:.7rem;cursor:pointer;user-select:none;flex-wrap:wrap}
    .card-hdr:hover{background:#fafafa}
    .sname{font-weight:700;font-size:1rem;min-width:80px}
    .badge{display:inline-block;padding:.2rem .6rem;border-radius:12px;font-size:.75rem;font-weight:600}
    .bd-debug{background:#dbeafe;color:#1e40af}
    .bd-extend{background:#d1fae5;color:#065f46}
    .bd-pend{background:#fef3c7;color:#92400e}
    .bd-approved{background:#d1fae5;color:#065f46}
    .bd-rejected{background:#f3f4f6;color:#374151}
    .bd-error{background:#fee2e2;color:#991b1b}
    .bd-flag{background:#fee2e2;color:#dc2626}
    .time-str{font-size:.8rem;color:#888;margin-left:auto}
    .chevron{font-size:.85rem;color:#aaa;transition:transform .2s;flex-shrink:0}
    .open .chevron{transform:rotate(90deg)}
    .card-body{padding:0 1.2rem 1.4rem;border-top:1px solid #f0f0f0}
    .slabel{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#888;margin:1rem 0 .4rem}
    .q-text{background:#f8f9fa;border-radius:8px;padding:.8rem;font-size:.95rem;line-height:1.5}
    pre.code{background:#1a1a2e;color:#a8ff78;border-radius:8px;padding:1rem;font-size:.82rem;overflow:auto;line-height:1.5;max-height:280px;white-space:pre}
    textarea.sugg{width:100%;border:2px solid #ddd;border-radius:8px;padding:.8rem;font-family:inherit;font-size:.95rem;line-height:1.6;resize:vertical;min-height:110px}
    textarea.sugg:focus{outline:none;border-color:#5c2d91}
    .note-input{width:100%;border:2px solid #ddd;border-radius:8px;padding:.7rem;font-family:inherit;font-size:.9rem}
    .note-input:focus{outline:none;border-color:#5c2d91}
    .action-row{display:flex;gap:.8rem;margin-top:1rem}
    .btn-approve{background:#10b981;color:white;border:none;padding:.7rem 1.5rem;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;flex:1}
    .btn-approve:hover{background:#059669}
    .btn-reject{background:#f3f4f6;color:#374151;border:2px solid #ddd;padding:.7rem 1.5rem;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer}
    .btn-reject:hover{background:#e5e7eb}
    .done-banner{background:#d1fae5;border-radius:8px;padding:.8rem;color:#065f46;font-weight:600;margin-top:1rem;text-align:center}
    .rejected-banner{background:#f3f4f6;border-radius:8px;padding:.8rem;color:#374151;font-weight:600;margin-top:1rem;text-align:center}
    .final-box{background:#f0fdf4;border:2px solid #10b981;border-radius:8px;padding:.8rem;white-space:pre-wrap;line-height:1.6;font-size:.95rem}
    .err-box{font-size:.85rem;color:#dc2626;background:#fee2e2;border-radius:6px;padding:.6rem;margin-top:.4rem;font-family:monospace}
    .empty{text-align:center;padding:3rem;color:#888}
    .empty .ico{font-size:3rem;margin-bottom:1rem}
    .loading{text-align:center;padding:2rem;color:#888}
  </style>
</head>
<body>
<header>
  <h1>🔧 micro:bit Help Desk — Teacher Dashboard</h1>
  <span class="count-badge" id="pendingCount">Loading...</span>
</header>
<main>
  <div class="toolbar">
    <button class="filter-btn active" id="f-all" onclick="setFilter('all')">All</button>
    <button class="filter-btn" id="f-pending_review" onclick="setFilter('pending_review')">Needs Review</button>
    <button class="filter-btn" id="f-approved" onclick="setFilter('approved')">Approved</button>
    <button class="filter-btn" id="f-rejected" onclick="setFilter('rejected')">Redirected</button>
    <button class="refresh-btn" onclick="loadRequests()">↺ Refresh</button>
  </div>
  <div id="list"><div class="loading">Loading requests...</div></div>
</main>
<script>
let allReqs = [];
let filter = 'all';
let expanded = {};

async function loadRequests() {
  try {
    const res = await fetch('/run', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({action:'list_requests', params:{}})
    });
    const data = await res.json();
    if (!data.ok) return;
    allReqs = data.requests || [];
    render();
    const n = allReqs.filter(r => r.status==='pending_review'||r.status==='llm_error').length;
    document.getElementById('pendingCount').textContent = n===0 ? '✓ All done' : n+' to review';
  } catch(e) { console.error(e); }
}

function setFilter(f) {
  filter = f;
  ['all','pending_review','approved','rejected'].forEach(k => {
    document.getElementById('f-'+k).classList.toggle('active', k===f);
  });
  render();
}

function fmt(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' · '+d.toLocaleDateString([],{day:'numeric',month:'short'});
}

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function statusBadge(status) {
  const m = {
    queued:['bd-pend','Waiting...'],
    pending_llm:['bd-pend','Getting hint...'],
    pending_review:['bd-pend','Needs Review ⚡'],
    approved:['bd-approved','Approved ✓'],
    rejected:['bd-rejected','Redirected'],
    llm_error:['bd-error','Hint failed ⚠️']
  };
  const [c,l] = m[status]||['bd-pend',status];
  return '<span class="badge '+c+'">'+esc(l)+'</span>';
}

function render() {
  const list = document.getElementById('list');
  let reqs = filter==='all' ? allReqs : allReqs.filter(r=>r.status===filter);
  if (!reqs.length) {
    list.innerHTML = '<div class="empty"><div class="ico">📭</div><p>No requests here yet</p></div>';
    return;
  }
  list.innerHTML = reqs.map(r => {
    const isOpen = expanded[r.id];
    const flagBadge = r.flagged ? '<span class="badge bd-flag">⚑ Flagged</span>' : '';
    const htBadge = '<span class="badge bd-'+(r.helpType||'debug')+'">'+(r.helpType==='extend'?'✨ Extend':'🐛 Fix bug')+'</span>';
    const body = isOpen ? '<div class="card-body" id="b-'+r.id+'"><em style="color:#888">Loading...</em></div>' : '';
    return '<div class="req-card st-'+r.status+(r.flagged?' flagged':'')+'" id="c-'+r.id+'">'
      + '<div class="card-hdr'+(isOpen?' open':'')+'" onclick="toggle(\''+r.id+'\')">'
      + '<span class="sname">'+esc(r.studentName)+'</span>'
      + htBadge + statusBadge(r.status) + flagBadge
      + '<span class="time-str">'+fmt(r.submittedAt)+'</span>'
      + '<span class="chevron">▶</span></div>'
      + body + '</div>';
  }).join('');
  // load bodies for already-open cards
  reqs.filter(r=>expanded[r.id]).forEach(r => loadBody(r.id));
}

async function toggle(id) {
  if (expanded[id]) {
    expanded[id] = false;
    const card = document.getElementById('c-'+id);
    card.querySelector('.card-hdr').classList.remove('open');
    const b = document.getElementById('b-'+id);
    if (b) b.remove();
    return;
  }
  expanded[id] = true;
  const card = document.getElementById('c-'+id);
  card.querySelector('.card-hdr').classList.add('open');
  let b = document.getElementById('b-'+id);
  if (!b) {
    b = document.createElement('div');
    b.className = 'card-body';
    b.id = 'b-'+id;
    b.innerHTML = '<em style="color:#888">Loading...</em>';
    card.appendChild(b);
  }
  await loadBody(id);
}

async function loadBody(id) {
  const b = document.getElementById('b-'+id);
  if (!b) return;
  try {
    const res = await fetch('/run', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({action:'get_request', params:{id}})
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    b.innerHTML = bodyHtml(data.request);
  } catch(e) {
    b.innerHTML = '<div class="err-box">'+esc(e.message)+'</div>';
  }
}

function bodyHtml(r) {
  const canReview = r.status==='pending_review'||r.status==='llm_error';
  const isDone = r.status==='approved'||r.status==='rejected';
  let h = '<div class="slabel">Question</div><div class="q-text">'+esc(r.question)+'</div>'
         +'<div class="slabel">Code</div><pre class="code">'+esc(r.code)+'</pre>';
  if (r.llmError) {
    h += '<div class="slabel">Hint Generation Error</div><div class="err-box">'+esc(r.llmError)+'</div>';
  }
  if (canReview) {
    h += '<div class="slabel">AI Suggestion — edit if needed before approving</div>'
       + '<textarea class="sugg" id="e-'+r.id+'">'+esc(r.llmSuggestion||'')+'</textarea>'
       + '<div class="slabel">Teacher note (private, not shown to student)</div>'
       + '<input class="note-input" type="text" id="n-'+r.id+'" placeholder="optional note to yourself">'
       + '<div class="action-row">'
       + '<button class="btn-approve" onclick="review(\''+r.id+'\',\'approve\')">✓ Approve &amp; Send</button>'
       + '<button class="btn-reject" onclick="review(\''+r.id+'\',\'reject\')">→ I\'ll help them myself</button>'
       + '</div>';
  }
  if (isDone) {
    h += '<div class="slabel">Response sent to student</div>'
       + '<div class="final-box">'+esc(r.finalResponse||'')+'</div>'
       + (r.status==='approved'
         ? '<div class="done-banner">✓ Hint was sent to student</div>'
         : '<div class="rejected-banner">→ Student has been redirected to you</div>');
    if (r.teacherNote) {
      h += '<div class="slabel">Teacher note</div><div class="q-text">'+esc(r.teacherNote)+'</div>';
    }
  }
  return h;
}

async function review(id, decision) {
  const editEl = document.getElementById('e-'+id);
  const noteEl = document.getElementById('n-'+id);
  const editedResponse = editEl ? editEl.value.trim() : '';
  const teacherNote = noteEl ? noteEl.value.trim() : '';
  try {
    const res = await fetch('/run', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({action:'review_request', params:{id, decision, editedResponse, teacherNote}})
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    expanded[id] = false;
    await loadRequests();
  } catch(e) { alert('Error: '+e.message); }
}

loadRequests();
setInterval(loadRequests, 30000);
</script>
</body>
</html>`;

// ─── HTTP server ──────────────────────────────────────────────────────────────

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, STUDENT_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/teacher") {
        sendHtml(res, TEACHER_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const pending = listAllRequests().filter(r => r.status === "pending_review" || r.status === "llm_error").length;
        sendJson(res, 200, {
          status: "ok",
          service: SERVICE,
          llmProvider: LLM_PROVIDER,
          ollamaUrl: LLM_PROVIDER === "ollama" ? OLLAMA_URL : null,
          ollamaModel: LLM_PROVIDER === "ollama" ? OLLAMA_MODEL : null,
          anthropicModel: LLM_PROVIDER === "anthropic" ? ANTHROPIC_MODEL : null,
          autoApprove: AUTO_APPROVE,
          pendingReview: pending,
          studentUrl: `http://${HOST}:${PORT}/`,
          teacherUrl: `http://${HOST}:${PORT}/teacher`
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/actions") {
        sendJson(res, 200, { service: SERVICE, actions: ACTIONS });
        return;
      }

      if (req.method === "POST" && url.pathname === "/run") {
        const body = await readBody(req);
        const action = String(body.action || "").trim();
        if (!action) {
          sendJson(res, 400, { ok: false, error: "action is required" });
          return;
        }
        const payload = await handleAction(action, body.params || {});
        sendJson(res, 200, payload);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
  });
}

function main() {
  ensureDirs();
  createServer().listen(PORT, HOST, () => {
    console.log(`${SERVICE} listening on http://${HOST}:${PORT}`);
    console.log(`student:  http://${HOST}:${PORT}/`);
    console.log(`teacher:  http://${HOST}:${PORT}/teacher`);
    console.log(`health:   http://${HOST}:${PORT}/health`);
    console.log(`llm_provider=${LLM_PROVIDER}`);
    console.log(`auto_approve=${AUTO_APPROVE}`);
    if (LLM_PROVIDER === "ollama") {
      console.log(`ollama_url=${OLLAMA_URL}  model=${OLLAMA_MODEL}`);
    } else {
      console.log(`anthropic_model=${ANTHROPIC_MODEL}  key=${ANTHROPIC_API_KEY ? "set" : "MISSING"}`);
    }
  });
}

if (require.main === module) main();

module.exports = { ACTIONS, handleAction, createServer };

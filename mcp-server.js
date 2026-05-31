#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * microbit-agent — MCP stdio adapter
 *
 * Wraps the HTTP action server as an MCP tool server so it can be used by
 * Claude Code, Claude Desktop, VS Code Copilot, and other MCP clients.
 *
 * Protocol: MCP 2024-11-05 (JSON-RPC 2.0 over stdio, newline-delimited)
 *
 * Usage:
 *   node mcp-server.js
 *
 * Or add to Claude Code:
 *   claude mcp add microbit-agent -- node /path/to/mcp-server.js
 */

const readline = require("node:readline");
const { handleAction, ACTIONS } = require("./server.js");

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOL_DEFS = [
  {
    name: "submit_help",
    description: "Submit a micro:bit MicroPython help request from a student. The LLM generates a hint asynchronously; the teacher then reviews it before the student sees it. Returns a request ID for polling.",
    inputSchema: {
      type: "object",
      properties: {
        studentName: { type: "string", description: "Student's first name." },
        code: { type: "string", description: "The student's MicroPython source code." },
        question: { type: "string", description: "What the student is asking — what's wrong or what they want to add." },
        helpType: { type: "string", enum: ["debug", "extend"], description: "'debug' for something not working, 'extend' for adding new behaviour." },
        className: { type: "string", description: "Optional class or group name (e.g. '4B', 'Thursday coding club')." }
      },
      required: ["studentName", "code", "question", "helpType"]
    }
  },
  {
    name: "list_requests",
    description: "List all student help requests. Use status filter to focus on requests needing teacher review.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["queued", "pending_llm", "pending_review", "approved", "rejected", "llm_error"],
          description: "Optional filter. Omit to list all requests."
        }
      }
    }
  },
  {
    name: "get_request",
    description: "Get the full details of a specific help request: student code, question, AI-generated hint, and current status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Request UUID returned by submit_help." }
      },
      required: ["id"]
    }
  },
  {
    name: "review_request",
    description: "Teacher reviews an AI-generated hint and either approves it (student sees the hint) or redirects the student to the teacher in person.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Request UUID." },
        decision: { type: "string", enum: ["approve", "reject"], description: "'approve' to send the hint to the student. 'reject' to redirect them to ask the teacher in person." },
        editedResponse: { type: "string", description: "The final hint text to send (can be the AI suggestion, edited, or entirely new). Used when decision is approve." },
        teacherNote: { type: "string", description: "Optional private note for the teacher's own records. Not shown to the student." }
      },
      required: ["id", "decision"]
    }
  },
  {
    name: "get_response",
    description: "Check the status of a help request and retrieve the approved response when ready. Used by the student-facing UI to poll for their hint.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Request UUID returned by submit_help." }
      },
      required: ["id"]
    }
  }
];

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: "2.0", id, error: err });
}

// ─── Message dispatch ─────────────────────────────────────────────────────────

async function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "microbit-agent", version: "0.1.0" },
      capabilities: { tools: {} }
    });
    return;
  }

  if (method === "initialized" || method === "notifications/cancelled") return;

  if (method === "tools/list") {
    sendResult(id, { tools: TOOL_DEFS });
    return;
  }

  if (method === "tools/call") {
    const toolName = String(params?.name || "").trim();
    const args = params?.arguments || {};

    if (!ACTIONS.includes(toolName)) {
      sendResult(id, {
        content: [{ type: "text", text: `Unknown tool: ${toolName}. Available: ${ACTIONS.join(", ")}` }],
        isError: true
      });
      return;
    }

    try {
      const result = await handleAction(toolName, args);
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      });
    } catch (err) {
      sendResult(id, {
        content: [{ type: "text", text: `Error running ${toolName}: ${err.message}` }],
        isError: true
      });
    }
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

// ─── stdin loop ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch { sendError(null, -32700, "Parse error"); return; }
  await dispatch(msg);
});

rl.on("close", () => process.exit(0));

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[microbit-agent] unhandled rejection: ${reason}\n`);
});

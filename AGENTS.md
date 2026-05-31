# Agent Guide

microbit-agent is a human-in-the-loop help desk for kids working on BBC micro:bit projects. Students submit MicroPython code and a question; an LLM generates a kid-friendly hint; a teacher reviews it before the student sees it.

## Project layout

- `server.js` — HTTP action server + embedded student and teacher web UIs
- `mcp-server.js` — stdio MCP entry point for Claude Code / Claude Desktop
- `out/requests/` — one JSON file per help request (created at runtime, gitignored)

## Read these first

1. `SOUL.md` — project purpose and design guardrails
2. `README.md` — setup, env vars, API reference

## Commands

Syntax check:
```powershell
node --check server.js
node --check mcp-server.js
```

Run the server:
```powershell
node server.js
```

Add as a Claude Code MCP tool:
```powershell
claude mcp add microbit-agent -- node C:\Users\Eoin\git\microbit-agent\mcp-server.js
```

Health check (server must be running):
```powershell
curl.exe -s http://127.0.0.1:3097/health
```

Submit a test request:
```powershell
curl.exe -s -X POST http://127.0.0.1:3097/run -H "Content-Type: application/json" `
  -d '{"action":"submit_help","params":{"studentName":"Alex","code":"from microbit import *\ndisplay.show(Image.HAPPY)","question":"nothing shows on display","helpType":"debug"}}'
```

## Actions

| Action | Who calls it | What it does |
|--------|-------------|--------------|
| `submit_help` | Student UI / agent | Submit code + question, triggers async LLM hint generation |
| `list_requests` | Teacher UI / agent | List all requests, optionally filtered by status |
| `get_request` | Teacher UI / agent | Full details of one request including code and AI suggestion |
| `review_request` | Teacher UI / agent | Approve (with optional edits) or reject a request |
| `get_response` | Student UI (polling) | Check status and retrieve approved hint |

## Request state machine

```
queued → pending_llm → pending_review → approved
                                      → rejected
                    → llm_error
```

## LLM configuration

Set `LLM_PROVIDER=ollama` (default) for offline/classroom use with a local Ollama instance.
Set `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` for cloud inference.

The system prompt in `server.js` (`SYSTEM_PROMPT` constant) is tuned for:
- BBC micro:bit MicroPython vocabulary
- Age 8–14 audience
- One hint at a time, never the full solution
- Flagging inappropriate content with `[FLAG]`

## Safety rules

- Never display AI-generated content to students without teacher approval.
- `flagged: true` requests must be visible in the teacher UI (red badge) before the teacher can act.
- Do not log or store student names alongside school-identifiable metadata.
- Keep the service bound to a local/LAN address in classroom deployments (default `HOST=0.0.0.0` is suitable for LAN; restrict further if needed).
- The `teacherNote` field is private and never returned to students.

## Workflow

```
Student submits → LLM runs async → teacher reviews in dashboard
                                 → teacher edits hint if needed
                                 → teacher approves (or redirects)
                                 → student sees hint (or "ask me directly")
```

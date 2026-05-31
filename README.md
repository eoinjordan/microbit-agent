# microbit-agent

Human-in-the-loop help desk for kids working on BBC micro:bit projects.

Kids paste their MicroPython code and ask a question. An LLM (local Ollama by default, or Anthropic) generates a kid-friendly hint. The teacher reviews and approves the hint before the student sees it.

## Workflow

```
Student submits code + question
        ↓
LLM generates hint (async)
        ↓
Teacher reviews → edits → approves / redirects
        ↓
Student's browser shows the approved hint
```

## URLs

| URL | Who uses it |
|-----|-------------|
| `http://localhost:3097/` | Students |
| `http://localhost:3097/teacher` | Teachers |
| `http://localhost:3097/health` | Status check |

## Quickstart

```bash
cp .env.example .env
# edit .env — set LLM_PROVIDER and matching keys
node server.js
```

## LLM options

### Offline (Ollama — classroom default)

```env
LLM_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5-coder:7b
```

Pull the model once:
```bash
ollama pull qwen2.5-coder:7b
```

Any Ollama model works. `llama3.2:3b` is lighter; `qwen2.5-coder:7b` gives better code hints.

### Online (Anthropic)

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

## Docker

```bash
docker compose up -d
```

The `out/requests/` directory is volume-mounted so requests survive restarts.

On a Pi with Ollama running on the same host, set `OLLAMA_URL=http://host.docker.internal:11434`.

## API

All actions via `POST /run`:

```json
{ "action": "submit_help", "params": { "studentName": "Alex", "code": "from microbit import *\n...", "question": "My LED won't light up", "helpType": "debug" } }
```

```json
{ "action": "list_requests", "params": {} }
```

```json
{ "action": "get_request", "params": { "id": "<uuid>" } }
```

```json
{ "action": "review_request", "params": { "id": "<uuid>", "decision": "approve", "editedResponse": "...", "teacherNote": "..." } }
```

```json
{ "action": "get_response", "params": { "id": "<uuid>" } }
```

## Request states

| Status | Meaning |
|--------|---------|
| `queued` | Just submitted, LLM call starting |
| `pending_llm` | LLM is generating the hint |
| `pending_review` | Hint ready, waiting for teacher |
| `approved` | Teacher approved, student can see it |
| `rejected` | Teacher redirected student to themselves |
| `llm_error` | LLM failed, teacher writes hint manually |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3097` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LLM_PROVIDER` | `ollama` | `ollama` or `anthropic` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Ollama model name |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Anthropic model |
| `LLM_TIMEOUT_MS` | `90000` | LLM call timeout |

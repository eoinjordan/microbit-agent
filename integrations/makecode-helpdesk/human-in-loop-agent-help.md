# Human-in-the-loop Agent Help Desk

This branch is an integration sketch for adding classroom-safe LLM help to the MakeCode micro:bit editor.

The companion service is:

- `microbit-agent`: https://github.com/eoinjordan/microbit-agent

## Why this belongs near MakeCode

MakeCode already has the important learner-facing pieces:

- Blocks, JavaScript, and Python views of the same project
- a simulator
- a micro:bit download/flash workflow
- project state that can be represented as source and blocks

The missing classroom workflow is not "send this project to a chatbot." The useful workflow is:

1. The learner asks for help from inside the editor.
2. The editor sends the current code, language view, and question to a local classroom help desk.
3. A local Ollama model drafts one short hint.
4. The teacher reviews, edits, approves, or redirects the request.
5. The learner sees the approved hint in the editor.

That keeps MakeCode as the learning environment and keeps the teacher in the loop.

## Proposed editor integration

The first production-shaped integration should be a target-specific editor action:

- label: `Ask teacher`
- source: current project source from the active editor view
- optional representation: block XML or MakeCode's internal blocks representation when available
- endpoint: local `microbit-agent` server, default `http://127.0.0.1:3097`
- response: approved teacher hint, rendered with code blocks and copy buttons

The request payload should stay small and explicit:

```json
{
  "action": "submit_help",
  "params": {
    "studentName": "Alex",
    "question": "My LED display shows nothing",
    "code": "basic.forever(function () { ... })",
    "helpType": "debug",
    "className": "5th Class",
    "source": "makecode",
    "language": "javascript"
  }
}
```

The response polling stays the same as `microbit-agent`:

```json
{
  "action": "get_response",
  "params": {
    "id": "<request-id>"
  }
}
```

## Safety rules

- Do not auto-apply LLM output to the project.
- Prefer one hint over a full solution.
- Keep the teacher review step on by default.
- Keep all classroom state local by default.
- Allow `AUTO_APPROVE` only as a deliberate local server setting for testing or trusted small-group use.
- Treat flagged content as teacher-only until reviewed.

## Standalone fork path

For a standalone school fork, add a persistent editor panel:

- current code preview
- blocks preview if the active project can be decompiled
- question input
- submit status
- final approved hint

For an upstream contribution, keep the feature smaller:

- add a target extension hook that can open a configured help URL with the current code
- document the local service protocol
- leave model choice and teacher workflow outside the editor

That makes the feature useful without forcing MakeCode itself to depend on Ollama or any hosted LLM provider.

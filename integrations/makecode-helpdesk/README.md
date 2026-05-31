# MakeCode micro:bit Help Desk Bridge

This folder contains a small integration bridge for the classroom `microbit-agent` service.

It is intentionally separate from the core MakeCode editor code while the workflow is being tested. The bridge can be loaded from a forked MakeCode panel, an iframe, or a local development page and talks to the local help desk server at `http://127.0.0.1:3097`.

## Local workflow

1. Start `microbit-agent`.

   ```powershell
   cd ..\microbit-agent
   $env:AUTO_APPROVE="false"
   node server.js
   ```

2. Start this MakeCode target locally.

   ```powershell
   cd ..\pxt-microbit-agent-fork
   npm install
   pxt serve
   ```

3. Use the bridge protocol from an editor panel or local page:

   ```js
   const client = new MicrobitAgentBridge({
     endpoint: "http://127.0.0.1:3097",
     studentName: "Alex"
   });

   const submitted = await client.submit({
     question: "Why is my LED not showing?",
     code: "basic.forever(function () { led.plot(2, 2) })",
     helpType: "debug",
     language: "javascript"
   });

   const final = await client.waitForResponse(submitted.id);
   ```

## Why this is a bridge first

MakeCode already owns the project model, block decompiler, simulator, and editor UI. The classroom agent should not replace those. It should attach as a narrow workflow:

- capture the current code or block representation
- ask one question
- send it to the local teacher-reviewed help desk
- show the approved hint

Once this bridge is working in a fork, the same protocol can be adapted into a proper MakeCode target extension or proposed upstream as a configurable classroom help feature.

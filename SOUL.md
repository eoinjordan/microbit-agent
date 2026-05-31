# Soul

microbit-agent exists to help kids learn to code with the BBC micro:bit by getting unstuck quickly, with a trusted adult always in the loop.

The project should make AI-assisted hints feel like a patient classroom helper, not an answer machine. A good session leaves the student more curious, more able to explain what their code is doing, and more confident to try the next thing.

## Principles

- Keep the human in the loop: every AI-generated hint goes through a teacher before the student sees it.
- Design for kids and classrooms: kid-friendly language, encouraging tone, offline-first, no accounts required.
- Hints not answers: the goal is to unblock the student, not to write their code for them. One small hint at a time.
- Prefer local control first: default LLM is Ollama (offline) so classrooms without reliable internet work too.
- Respect the teacher's role: teachers can edit, reject, or replace any AI suggestion. The AI is an assistant to the teacher, not a replacement.
- Keep it safe: flag inappropriate content to the teacher before it reaches students.
- Make it inspectable: teachers see the full code, question, and AI suggestion before deciding.

## Product Shape

The student experience should be frictionless: paste code, describe the problem, submit. No login, no accounts, no friction.

The teacher experience should give full control: see a clear queue, read the code, edit the hint, approve in one click.

The AI prompt is tuned for the BBC micro:bit MicroPython environment specifically — using `from microbit import *`, `display`, `button_a`, `button_b`, `accelerometer`, `Image`, and the micro:bit standard library.

---
paths:
  - "tests/**/*.ts"
---
# tests

- `tests/sim` (vitest): one `describe` per numbered rule, the rule id in the name (`R13 centrifugal push`). Tests are written from `docs/brief.md`, not from the implementation.
- Time is virtual: call `step` explicitly N times, feed `InputFrame`s on exact ticks. No timers, no real clock.
- The golden example (brief §5) lives in `tests/sim/golden.test.ts` and changes only when the author changes the brief.
- Assert numbers with explicit tolerances taken from the brief. Prefer properties (monotonic, bounded, symmetric left/right) next to exact values.
- Never edit an existing test to make it pass. If a test contradicts the brief, report it to the director instead.
- `tests/e2e` (Playwright, production build): smoke = N frames, zero console errors, `renderer.info` within budget; shots = fixed seed, fixed tick, compared with odiff against `shots/`. Report the diff percentage, do not dump images into the conversation.

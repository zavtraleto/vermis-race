---
paths:
  - "src/sim/**/*.ts"
  - "src/data/**/*"
---
# src/sim and src/data

- Pure TypeScript. No imports from `three`, DOM, `src/render`, `src/input`, `src/ui`, `src/app`, `src/dev`. ESLint enforces it; do not disable the rule.
- No `Math.random`, `Date`, `performance`, `setTimeout`. Randomness: the seeded RNG whose state is inside `RaceState`.
- `step` mutates preallocated state in place and allocates nothing; no closures, array literals or object literals in the tick path.
- State stays flat and JSON-serializable: no classes, Maps, Sets, functions or cyclic refs in `RaceState`.
- Player, rivals and traffic are one `Car` struct with `kind`; AI only produces an `InputFrame` and goes through the same `step`.
- No tuning literals: parameters arrive as `CarParams` / config objects loaded from `src/data`. Structural constants (`DT`, `SEG_PER_UNIT`, placeholder `K_HEADING`) live in one constants file and match `docs/brief.md` §3.
- The sim emits `SimEvent`s into a preallocated buffer; render and audio react to events, never reach into sim internals.
- Fixed update order of cars (by index). Anything order-dependent must be deterministic.
- Every behaviour implements a numbered rule from `docs/brief.md`; cite the rule id in a short comment (`// R13`). If the behaviour is not in the brief, stop and ask the director.
- Names come from `docs/glossary.md`.

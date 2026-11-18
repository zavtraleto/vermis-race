# Vermis Race — portrait pseudo-3D arcade racer

TypeScript (strict) + three.js (exact version pinned in package.json) + Vite. Mobile web, 9:16, touch first.
Говори с автором (Максим) по-русски. Документация — на русском, идентификаторы и комментарии в коде — на английском.

## Truth
- Rules of the game: `docs/brief.md` (numbered rules R*, golden example §5). Details and sources: `docs/reference/kickoff-brief.md`.
- Names: `docs/glossary.md`. Numbers: `src/data` + log in `docs/balance.md`. Decisions: `docs/decisions/`.
- Where we are and what is next: `docs/progress.md`. Research already done: `docs/research/` (read before researching again).
- Rule changes go to brief first, then code. Never invent game rules; statuses [решено] are the author's and are not reopened without him.

## Roles (ADR 0001)
- The main chat is the director and the author's colleague (game designer, artist, second developer): plans, decides architecture, owns `docs/`, briefs subagents, reads diffs, gives the author honest feedback and ideas, asks questions when something is unclear.
- Code, research and reading sources are delegated to subagents on junior models: `implementer`, `test-writer`, `reviewer`, `researcher` (`.claude/agents/`). Tests are never written by the agent that wrote the implementation.
- A subagent's report is not proof. Verify by command output.

## Commands
- Check: `npm run check` (tsc --noEmit + eslint)
- Tests: `npm test` (vitest, sim only, no browser)
- Smoke: `npm run smoke` (prod build, Playwright runs N frames, zero console errors, renderer.info budget)
- Screenshot: `npm run shot -- <scenario>` (deterministic frame + odiff against `shots/`)
- Dev server: `npm run dev`

## Hard rules
- `src/sim` imports nothing from three, DOM, `src/render`, `src/input`, `src/app`. No `Math.random`, `Date`, `performance` there; randomness only via the seeded RNG stored in state.
- State is flat serializable JSON. All input reaches the sim as `InputFrame` per tick.
- Tunable numbers live in `src/data` JSON, never as literals in logic. Every number change gets a line in `docs/balance.md`.
- Every [гипотеза] is a runtime flag (`src/data/hypotheses.json` + dev panel), never hard-coded.
- Zero allocations in the sim tick and the render frame.
- three.js: only the pinned version's API (see `.claude/rules/render.md`).
- Failing test first. Never modify a test to make it pass — if a test looks wrong, stop and ask.
- Minimal diff. No new dependencies or abstractions without asking the author.
- Never commit to `main` directly (hook enforces); short branches, small vertical slices.
- Done = `check` + `test` green, `smoke` clean, screenshot or metric checked against a criterion named in advance, `docs/progress.md` updated.
- Green tests do not mean a playable game: feel, touch ergonomics and fun are judged by the author on a phone. A stage is closed only by him.

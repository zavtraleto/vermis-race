---
name: ship
description: Finish the current task — review by a clean-context agent, full checks, docs update, commit on the feature branch.
disable-model-invocation: true
---
Finish the current task.

1. Run `npm run check`, `npm test`, `npm run smoke`; run `npm run shot` if anything visible changed. Stop on any failure.
2. Dispatch `reviewer` on the branch diff. Fix blockers through `implementer`; never by editing tests.
3. Update `docs/progress.md` (done / next / «Промпт следующей сессии»). If numbers in `src/data` changed, add lines to `docs/balance.md`. If a decision was made, add an ADR in `docs/decisions/`. If a rule changed, `docs/brief.md` must already say so.
4. Commit on the feature branch with a message that says what changed and which rules (R*) it implements. Do not merge into `main` and do not push: the author reads the diff and merges himself.
5. Give the author: what changed, how it was verified (command output), what to try on the phone, open questions.

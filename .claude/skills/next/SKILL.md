---
name: next
description: Start the next task from docs/progress.md — read state, plan the slice, dispatch test-writer then implementer.
disable-model-invocation: true
---
Start the next task.

1. Read `docs/progress.md` (sections «Следующее» and «Промпт следующей сессии») and the brief rules that task touches. Run `git status` and `git log --oneline -5`.
2. If the previous stage needs the author's playtest sign-off and it is not recorded in progress.md, stop and ask him.
3. State the task in two or three sentences with an acceptance criterion that a command can check (test names, a screenshot criterion, a metric). If the brief does not cover the behaviour, propose the brief change to the author first.
4. Create a branch `feat/<short-name>`.
5. Dispatch `test-writer` (red tests from the brief), check that they fail for the right reason, then `implementer`, then verify yourself with `npm run check`, `npm test`, and `npm run smoke` / `npm run shot` when render or input changed.
6. Tell the author what to try by hand and what feedback you want from him.

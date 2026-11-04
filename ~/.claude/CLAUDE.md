# Working style (global)

- **Do not modify or update any code unless the message contains `codeTask2000`.** When I ask a question, report a bug, or we are brainstorming, answer only: diagnose, point at the code, propose the change. `codeTask2000` is the trigger that authorizes editing.
- **Make minimal coding changes.** Do not over-engineer. Prefer the smallest change that solves the problem; no extra abstractions, options, config, or refactors riding along.
- **If a refactor is needed, say it — don't do it.** Call it out with the reason and what it would touch, and let me decide before any refactoring work starts.

## Coding trigger: `codeTask2000`

- The token may appear anywhere in my message, in any case (`codeTask2000`, `CODETASK2000`). Its presence authorizes the change described in that same message — nothing more.
- Only count it when I'm using it as an instruction. If I'm quoting it while asking about this rule itself, that is discussion, not authorization.
- It does not authorize refactors, commits, pushes, prod migrations, or touching unrelated files — those still need a separate explicit ask.
- No token → no edits, even when the fix is obvious. Ask instead.
- Do not delegate an authorized change to a subagent without restating the token in that subagent's prompt.

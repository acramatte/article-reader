# Agent guide

Article Reader: paste an article URL (or text), listen to it narrated. Node 24 backend (`server.mjs`) + Vite frontend; speech inference runs as a separate service (`pocket-tts-service/` by default, `kokoro-service/` optional).

## Orientation

- Start at `README.md`, then `docs/README.md`. `docs/architecture.md` is how the pieces fit; `docs/development.md` covers dev servers, config and tests.
- **Docs are part of the change.** If you alter behaviour, config/env vars, a limit, or a test command, update the matching `docs/` page in the same commit.
- The backend fetches and parses untrusted URLs and HTML. Keep the SSRF filter, parsing isolation, CSP and resource caps intact; changes there need tests.

## Checks

```sh
npm test              # unit/integration (node --test)
npm run build
npm run test:browser  # Playwright; needs the local Pocket TTS service on :8000 and internet
```

Run `npm test` and `npm run build` before calling work done; run the browser suite when touching UI, playback or streaming.

## Commit, branch & PR conventions

**Commits** use imperative mood with a Conventional-Commits-style type prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`; an optional scope such as `fix(security):` is fine). The body leads with WHY ("Add X so that Y" / "Replace X with Y so that Z"), then a design-decisions paragraph (what was extracted/shared and why), then a final `Tests:` line listing the exact test command(s) run. Keep commits focused; squash related refinements. CI enforces the type prefix, the `Tests:` line and the absence of merge commits; check locally with `node scripts/check-commits.mjs origin/main HEAD`.

```
feat: <imperative subject>

Add <X> so that <Y>. [WHY]

<design decisions — what was extracted/shared and why>. [optional but expected for non-trivial changes]

Tests: npm test; npm run build
```

`Tests:` examples: code change → `Tests: npm test; npm run build`; docs-only → `Tests: docs-only change; verified with git diff --check`.

**Branches** are simple and feature-focused (`feat/<slug>` / `fix/<slug>`). Always create a dedicated branch/worktree before touching files, and fork worktrees from an explicit ref (`git worktree add -b feat/<name> <dir> origin/main`), never bare `HEAD`. Use a separate worktree whenever concurrent sessions are possible.

**Pull requests** carry the same WHY + design-decisions rationale and end with an explicit `Tests:` line. For genuinely dependent changes use stacked PRs (`gh stack`). **Never merge main into a feature branch — rebase instead** (`git rebase origin/main`, verify linearity, then `git push --force-with-lease`).

## ripwire — deterministic codebase maps (on PATH as `ripwire`)
Reach for it BEFORE blind grep + whole-file reads. First call ~1s cold; after that warm, ~0.1s.
- Orient on a task: `ripwire <dir> --for="<task in words>"` — ranked, quality-annotated
  signatures. Paste symbol/file names from the issue verbatim; named mentions get anchored.
- One task: `--pack-task="<task>" --legend=compact`; before parallel agents: `--plan-lanes=N --task="<goal>"`, then read `lanes[].execution`.
- Have a stack trace / build error: `ripwire <dir> --from-trace=FILE --legend=compact` (`-` = stdin) —
  paste the error, don't paraphrase it into a query.
- Who calls X: `--callers=SYM --legend=compact`. "Is it safe to change X?" needs the full blast radius:
  `--impact=SYM --legend=compact` (transitive) plus `--uses=SYM --legend=compact` (every read/write/import site).
- Apply a whole-symbol edit without a whole-file Read: `--replace-symbol-body=SYM` plus `--edit-payload=FILE|-`
  (or insert-before/after); the receipt carries region, blob_sha, edit_check, tests_to_run + ONE next= — no re-read after it; `--edit-check=SYM --legend=compact` is for a contract question WITHOUT an edit in hand.
- Before writing a new fn/class/helper: `--exemplar="<what you're writing>" --legend=compact` — duplicates are born on small tasks.
- Before calling work done: `--quality-delta --legend=compact` (what you made worse), then `--test-gate --legend=compact`.
- Trust notes: counts marked counts_floor are floors, not totals; a zero means "none found", never "none exists".
- The commands above ask for the compact legend (terse definitions of only the attributes present); add `--legend=full` when a definition's reasoning is needed: a term you do not recognise, a floor or cap you need explained, a map a human will read.
Defaults to break (less context is measurably MORE accurate, not just cheaper — code-repair
accuracy fell 29% -> 3% as context grew 32K -> 256K tokens, LongCodeBench):
- Do NOT open a file you have not located first: rank with `--for`/`--grep`, then read what it names.
- Do NOT read a whole file to understand one symbol: `--expand=SYM --legend=compact` gives the body + callee sigs.
- Do NOT fan reads across several files to learn one thing: `--pack-task="<task>" --legend=compact` is one call.

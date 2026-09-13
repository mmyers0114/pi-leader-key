# Tasks: Command Args at the Config Level

Ordered by dependency. Tasks 2, 3, 4 are independent of each other once Task 1 lands (safe to parallelize); Task 5 needs everything.

- [x] (Prior work) Binding wizard Tasks 1–6 — shipped in v1.1.0, verified in-session. Boxes checked retroactively; see git history.

- [x] Task 1: Split command/args schema with legacy normalization (implemented, suite green)
  - Acceptance: `BindingAction` command variant becomes `{ command: string; args?: string }`; `validateCommand()` rejects empty, lone `/`, missing leading slash, and any interior whitespace in the command part; `isBindingAction` requires `args` (when present) to be a string; `sanitizeBindings` splits legacy `{ command: "/model opus" }` on the first space (trim both parts) and treats it identically to the split form.
  - Verify: `npx tsx __tests__/logic.test.ts` — new asserts for valid split, legacy split equivalence, lone-`/` rejection, spaced-command rejection, non-string args rejection; full suite green.
  - Dependencies: None
  - Files: logic.ts, __tests__/logic.test.ts
  - Estimated scope: Small (2 files)

- [x] Task 2: Surface dropped bindings (implemented, suite green)
  - Acceptance: `ConfigResult` gains `dropped: string[]` (keys sanitized away); shortcut handler in index.ts notifies once per press when non-empty (`Ignored invalid bindings: "x" — check leader-key.json`); empty case notifies nothing.
  - Verify: unit test pins `dropped` contents for a mixed valid/invalid file; full suite green.
  - Dependencies: Task 1
  - Files: logic.ts, index.ts, __tests__/logic.test.ts
  - Estimated scope: Small (3 files)

- [x] Task 3: Dispatch composes command + args (implemented, suite green)
  - Acceptance: `dispatchBinding` composes `` `${command}${args ? " " + args : ""}` `` and submits exactly as today (setText + onSubmit); `shouldRestoreDraft` is called with the composed string; no-args bindings dispatch byte-identical to before.
  - Verify: new `shouldRestoreDraft` case with composed args string; full suite green.
  - Dependencies: Task 1
  - Files: index.ts, __tests__/logic.test.ts
  - Estimated scope: XS (2 files, few lines)

- [x] Task 4: Wizard optional args step (implemented — manual in-session run still pending)
  - Acceptance: after the command pick, an optional free-text Editor step (Enter on empty = no args, reuses the existing Editor pattern); summary and conflict lines display the composed `command + args`; save writes the split form; command-only flow unchanged.
  - Verify: full suite green; manual — create one binding with args and one without, fire both in-session via leader key.
  - Dependencies: Task 1
  - Files: wizard.ts
  - Estimated scope: Medium (1 file, new step + display)

## Checkpoint: After Tasks 1–4

- [ ] All tests pass (`npx tsx __tests__/logic.test.ts`)
- [ ] `lens_diagnostics mode=full` clean
- [ ] Manual wizard run done (Task 4)
- [ ] Review with human before release task

- [x] Task 5: Docs, verification matrix, 1.2.0 (docs + automated verification done; in-session firing matrix left for user — see release summary)
  - Acceptance: README + AGENTS.md document `{ command, args }` (split form primary, legacy embedded form noted as accepted); the "largely untested" args caveat replaced with the exercised matrix (built-in with args, extension with args, skill ref, prompt template with args, unknown command behavior, double-space preservation); CHANGELOG 1.2.0 entry combining the unpublished 1.1.1 hardening notes; `package.json` → 1.2.0; local `v1.1.1` tag deleted, `v1.2.0` tagged.
  - Verify: manual matrix executed in a dev-installed session; read-through of docs against implementation.
  - Dependencies: Tasks 1–4
  - Files: README.md, AGENTS.md, CHANGELOG.md, package.json
  - Estimated scope: Small (4 files, docs + version)

## Checkpoint: Complete

- [ ] All acceptance criteria met
- [ ] Human review, commit + tag + push

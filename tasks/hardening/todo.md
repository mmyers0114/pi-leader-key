# Tasks: Production Hardening and Test Coverage

> Outline, decisions, and risks: `tasks/hardening/plan.md`.
> Baseline on 1.4.0: `npm test` green (352 logic assertions, 28 node:test cases, 0 skipped). `npm audit --omit=dev`: 0.
> Dependencies below are ordering constraints for the person running the plan.

**Commands**
- Full: `npm test` (typecheck + `tsx --test __tests__/*.test.ts`)
- Single file: `npx tsx __tests__/logic.test.ts`

---

## T1: Cap timer durations at the 32-bit limit

**Description:** `positiveMs()` in `logic.ts` accepts any finite positive number. Node's `setTimeout` stores delays as signed 32-bit, so anything above `2147483647` overflows and fires after about 1 ms. Confirmed: `setTimeout(fn, 3e9)` emits `TimeoutOverflowWarning` and fires after 1 ms. With a large `leaderTimeoutMs`, the leader overlay dismisses at once. Fix in `positiveMs` so `loadConfig()` and the setup wizard (`askMs`, which uses `positiveMs(Number(raw), -1)`) both reject it.

**Acceptance criteria:**
- [x] `positiveMs(3e9, fb)` returns `fb`; `positiveMs(2147483647, fb)` returns `2147483647`
- [x] `loadConfig()` with `leaderTimeoutMs: 3e9` falls back to the default and records a note saying why
- [x] The setup wizard re-asks for a timeout above the limit, and its message says the maximum

**Verification:**
- [x] `npm test` passes, with new regression asserts for the boundary (`2147483647` accepted, `2147483648` rejected)
- [x] `node -e 'setTimeout(()=>{},3e9)'` is no longer the path used by any config value (covered by the boundary test)

**Dependencies:** None
**Files:** `logic.ts` (`positiveMs`, `loadConfig`), `wizard.ts` (`askMs` message), `__tests__/logic.test.ts`, `__tests__/setup-wizard.test.ts`
**Scope:** S (3 files)

---

## T2: Add a CI workflow for pushes and pull requests

**Description:** `.github/workflows/publish.yml` is the only workflow, and it runs `npm test` only on `v*` tags. Nothing gates `main` or PRs. Add `ci.yml` triggered on `push` to `main` and on `pull_request`. Use the same SHA-pinned actions as `publish.yml` (`actions/checkout`, `actions/setup-node`), Node 24, `npm ci`, `npm test`, and `permissions: contents: read`.

**Acceptance criteria:**
- [x] `ci.yml` runs on push to `main` and on pull requests
- [x] Action references are pinned to full commit SHAs, matching `publish.yml`
- [x] A deliberately failing test on a scratch branch makes the check fail (proves it gates)

**Verification:**
- [x] First run on the default branch is green
- [x] Scratch-branch failure observed and recorded, then the branch deleted

**Dependencies:** None
**Files:** `.github/workflows/ci.yml` (new)
**Scope:** XS (1 file)

---

## T3: Extract command, action, and exec dispatch from `index.ts` and test it

**Description:** `dispatchBinding()` (`index.ts:333`) and `submitViaEditor()` (`index.ts:175`), about 115 lines together, have no tests. They hold the core feature: draft save and restore, command submission, action routing, exec output handling, and reload detection. Move them into a module that takes its dependencies as parameters (editor surface, UI notifier, `pi.exec`, compaction and shutdown hooks). The module must not import `@earendil-works/pi-*` if it is under test, so the tests run standalone under tsx, as `logic.ts` does. Write characterization tests against the current behavior first, then refactor.

**Acceptance criteria:**
- [x] Characterization tests exist for: command with and without leftover text (draft restored or not); action `compact`, `shutdown`, `clearEditor`, and unknown action; exec success, exec failure (stderr used, `[exit N]` prefix), and empty output; no editor focused (warning, nothing typed)
- [x] Reload detection: `/reload` binding leaves the status alone
- [x] `index.ts` only wires events and delegates to the extracted module
- [x] Behavior is unchanged (characterization tests were green before the refactor and still pass after)

**Verification:**
- [x] `npm test` green
- [x] `lens_diagnostics mode=full` clean on `index.ts` and the new module

**Dependencies:** T2 (land after CI is green, so the refactor is gated)
**Files:** `index.ts`, new dispatch module, `__tests__/dispatch.test.ts` (new)
**Scope:** M (3 files)

---

## T4: Integration test: a real command binding through the mounted editor

**Description:** `__tests__/editor-integration.test.ts` drives pi's real `CustomEditor`, but no test submits a command binding through it. `submitViaEditor()` calls `submitValue`, which pi marks private in its `.d.ts`. It exists in the installed pi-tui 1.0.2, and the fallback is `onSubmit` called directly, which can skip autocomplete cancellation and history reset. Add a test that opens the leader overlay on the real editor, fires a command binding, and asserts the composed command reaches `onSubmit`. The peer `"*"` range stays as pi's docs require; this test is what catches a breaking pi release.

**Acceptance criteria:**
- [x] CI runs the pi-tui and pi-coding-agent version the host ships (1.1.0), not the 1.0.2 the lockfile pins. Either pin the devDependencies to the host version (the peer range stays `"*"` per pi's docs), or run a matrix over 1.0.2 and 1.1.0
- [x] The test submits `/model opus` (or similar) through the real editor and asserts the exact text delivered to `onSubmit`
- [x] The test also covers the fallback branch by stubbing `submitValue` away
- [x] When `CI` is set, a missing peer fails the test instead of skipping it, so CI cannot pass silently

**Verification:**
- [x] `npm test` green locally against 1.1.0 (already true in a scratch copy: 352 + 28, 0 failures)
- [x] `npm test` green locally with peers installed
- [x] Skip-to-fail behavior demonstrated by unsetting a peer under `CI=true`

**Dependencies:** T3 (uses the extracted dispatch path)
**Files:** `__tests__/editor-integration.test.ts`
**Scope:** S (1 file)

---

## T5: Write config through symlinks without replacing them

**Description:** `writeAtomic()` in `logic.ts` writes a temp file and renames it over the target. If `leader-key.json` is a symlink (common with dotfile managers such as stow and chezmoi), the rename replaces the link with a regular file and the managed source goes stale. Confirmed: after `saveConfig` through a symlink, `lstat` reports it is no longer a symlink. Resolve the real path with `realpathSync` before writing, and write the temp file beside the real target.

**Acceptance criteria:**
- [x] `saveConfig` and `saveBinding` through a symlink leave the symlink in place and update its target
- [x] A dangling symlink is refused with an explicit error, not silently replaced (the chosen behavior is tested)
- [x] Existing atomicity guarantees hold: no `.tmp` left behind on failure; the corrupt-file refusal still applies

**Verification:**
- [x] `npm test` green with new symlink cases in `__tests__/logic.test.ts`
- [x] The probe from this review (`saveConfig` through a symlink) now reports `isSymbolicLink() === true`

**Dependencies:** None
**Files:** `logic.ts` (`writeAtomic`, `saveConfig`, `saveBinding`), `__tests__/logic.test.ts`
**Scope:** S (2 files)

---

## T6: Report corrupt and malformed config accurately on leader press

**Description:** In the shortcut handler in `index.ts`, a `parse` or `shape` error yields default config with no bindings, so pressing the leader key shows "No leader bindings configured." That is misleading, and the real error appears only once at `session_start`. Branch on `error` and say the file is unreadable, pointing at the file. Keep the no-wizard behavior, so a broken file is never overwritten.

**Acceptance criteria:**
- [x] `parse` and `shape` errors show a message naming `leader-key.json` as unreadable
- [x] `missing` still opens the setup wizard; an empty `bindings` object still shows "No leader bindings configured."
- [x] A corrupt file is never passed to the wizard or any save path

**Verification:**
- [x] Tests from T3's dispatch module cover all three branches
- [x] Manual: write `{nope` to the config, press the leader key, see the unreadable message

**Dependencies:** T3 (edits the shortcut handler after extraction, to avoid conflicting changes in `index.ts`)
**Files:** `index.ts` (shortcut handler), dispatch module, `__tests__/dispatch.test.ts`
**Scope:** S (2 files)

---

## T7: Restrict config file permissions to the owner

**Description:** Config can contain `exec` bindings, which are shell commands. `writeAtomic()` sets no mode, so the file inherits the umask (typically group- and world-readable). Create new files with mode `0600`. When replacing an existing file, keep its current mode rather than forcing one. Do not change the mode of a file the user has deliberately made more restrictive.

**Acceptance criteria:**
- [x] A new config file is created with mode `0600`
- [x] Replacing an existing file of mode `0644` keeps `0644`
- [x] The temp file is created with the intended mode before the rename, so there is no window of wider permissions

**Verification:**
- [x] `npm test` green, with `statSync(...).mode & 0o777` asserts in `__tests__/logic.test.ts`
- [x] `ls -l ~/.pi/agent/leader-key.json` shows `-rw-------` after a fresh setup on a test HOME

**Dependencies:** T5 (both change `writeAtomic`; land T5 first)
**Files:** `logic.ts` (`writeAtomic`), `__tests__/logic.test.ts`
**Scope:** XS (2 files)

---

## T8: Decide on `biome.json`

**Description:** `biome.json` exists (formatter settings only), but Biome is not in `devDependencies`, there is no lint script, and `node_modules/.bin` has no `biome`. It is dead config. The project notes say "Lint: none configured". Choose one: adopt Biome (add the devDependency, a `lint` script, and run it once) or delete `biome.json`.

**Acceptance criteria:**
- [x] Either `@biomejs/biome` is a devDependency with a working script, and the run is clean or its findings are recorded, or `biome.json` is removed
- [x] No config file remains for a tool that is not installed

**Verification:**
- [x] `npm run lint` passes (if adopted), or `grep -rn biome` shows no stale reference outside the skill files

**Dependencies:** None. Needs the user's decision (see plan, Open Questions).
**Files:** `biome.json`, `package.json`
**Scope:** XS (2 files)

---

## T9: Verify two unconfirmed assumptions (investigation only)

**Description:** Two review findings are not yet confirmed. Answer each from the installed pi source (`/home/matthew/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` in the project's `node_modules`), with file and line evidence. Record the answers in this task's notes. Make no code changes in this task.
- (a) Does `pi.exec` kill the child on its 15 s timeout, and does it bound buffered stdout? The `exec` binding in `index.ts` buffers the full output before `capOutput` truncates it.
- (b) Is pi's key parsing (`parseKeyId`) case-sensitive? `validateLeaderKey` lowercases for checking but stores the original case, and `index.ts` registers `config.leaderKey` unchanged.

**Acceptance criteria:**
- [x] (a) answered with file:line evidence for both the timeout behavior and the output cap
- [x] (b) answered with file:line evidence, and a one-line probe showing the registered key for `CTRL+Space` vs `ctrl+space`
- [x] Each answer states whether T10 or T11 is needed

**Findings:**

(a) `pi.exec` is `execCommand` (`dist/core/extensions/loader.js:326-329`).

- Timeout does kill, but weakly: `dist/core/exec.js:42-47` fires `killProcess()` → `proc.kill("SIGTERM")` (`exec.js:24`) on the direct child only. The SIGKILL escalation at `exec.js:27-28` is unreachable in practice — its guard is `!proc.killed`, and Node sets `killed` when a signal is *delivered*, not when the process exits, so a SIGTERM-ignoring child outlives the 5 s window. pi's bug, not fixable from here. Grandchildren are never signalled, since `bash -c` is what gets the signal.
- **The promise can outlive the timeout by a lot.** `exec.js:56` resolves through `waitForChildProcess` (`dist/utils/child-process.js:23-70`), which after `exit` waits for stdout/stderr to end and re-arms a 100 ms idle timer (`EXIT_STDIO_GRACE_MS`) on *every* chunk. A surviving grandchild that keeps writing keeps the promise pending — measured: `waitedMs=30008 code=0 stdoutLen=40.0MB killed=true`, all of it after the timeout fired. So a hostile binding is both a memory and a liveness problem. The `head -c` cap from T10 closes most of it: once `head` has its bytes it exits, the pipe breaks, and further writes fail with EPIPE.
- Output is **unbounded**: `exec.js:17-18` and `exec.js:48-53` concatenate every chunk into a plain string with no counter or truncation. pi's own bash tool does cap (`dist/core/bash-executor.js`, `maxOutputBytes`), but `pi.exec` does not.
- **T10 needed.** Capping after the fact cannot help.

(b) pi-tui `parseKeyId` (`dist/keys.js:603-615`) lowercases the whole id (`keys.js:604`) before matching via `matchesKey` (`keys.js:633-634`), which the shortcut path uses per keystroke (`dist/modes/interactive/interactive-mode.js:1755-1758`). Probe:

```
"CTRL+Space"   NUL: true  g: false G: false
"ctrl+space"   NUL: true  g: false G: false
"Ctrl+SPACE"   NUL: true  g: false G: false
"G"            NUL: false g: true  G: false
"g"            NUL: false g: true  G: false
"shift+g"      NUL: false g: false G: true
```

- Modifiers and key names are case-insensitive, so a hand-edited `CTRL+Space` registers and matches identically. `validateLeaderKey` (`logic.ts:224`) lowercases the same way and requires a modifier.
- Caveat, not our problem: a bare capital must be spelled `shift+g`, since the bare-key branch compares the raw data (`keys.js:936`) against the lowercased id — `matchesKey("G", "G")` is false. `parseKey` returns printables verbatim (`keys.js:1095-1097`), so never compare `parseKey(data) === shortcutId`; use `matchesKey`.
- **T11 not needed.**

**Verification:**
- [x] Probe output pasted into the task notes

**Dependencies:** None. Blocks T10 and T11.
**Files:** none (read-only)
**Scope:** XS

---

## T10: Bound `exec` output (conditional on T9a)

**Description:** Only if T9a finds that `pi.exec` buffers unbounded output: cap what is buffered, for example by wrapping the command with `head -c 65536` before `bash -c`, so a runaway command cannot exhaust memory inside the 15 s window. Skip this task if T9a shows pi already bounds it.

**Acceptance criteria:**
- [x] A command producing more than the cap does not grow memory without bound (demonstrated with a large-output command)
- [x] Output shown to the user is still capped by `capOutput`, with the same message format

**Decision:** `cappedExecCommand()` in `dispatch.ts` wraps the binding as
`{ cmd; } 2>&1 | head -c 65536; exit ${PIPESTATUS[0]}`. stderr goes through the
same pipe so a chatty failure cannot dodge the cap; `PIPESTATUS` carries the
user's exit code past `head`. When the cap truncates, the writer dies of SIGPIPE
and the code is reported as 141 — verified, not assumed:

```
"yes"                            -> exit 141 bytes 65536  10ms
"git status"                     -> exit 0   bytes 626    6ms
"echo out; echo err >&2; exit 3" -> exit 3   bytes 8      5ms
"sleep 30"                       -> SIGTERM  15015ms   (pi's timeout)
```

`capOutput()` still does the user-facing trim, so the message format is unchanged.
The 15 s timeout and SIGTERM behaviour are pi's, untouched here.

**Verification:**
- [x] `npm test` green; manual `exec` binding running `yes | head -c 200000000`

**Dependencies:** T9 (conditional)
**Files:** dispatch module or `logic.ts` (`dispatchPlan`), tests
**Scope:** S (2 files)

---

## T11: Normalize leader-key case (conditional on T9b)

**Decision:** skipped. T9b showed pi-tui's `parseKeyId` lowercases the whole id
(`dist/keys.js:604`), so `CTRL+Space` and `ctrl+space` register and match
identically. `validateLeaderKey` already lowercases for checking
(`logic.ts:224`), so the stored case is cosmetic. Nothing to normalize.

**Acceptance criteria:**
- [ ] `loadConfig()` normalizes case, and the registered key matches the documented form
- [ ] The existing `validateLeaderKey` rejection messages are unchanged

**Verification:**
- [ ] `npm test` green, with a `CTRL+Space` case in `__tests__/logic.test.ts`

**Dependencies:** T9 (conditional)
**Files:** `logic.ts` (`loadConfig`), `__tests__/logic.test.ts`
**Scope:** XS (2 files)

---

## T12: Correct the stale header comment in `index.ts`

**Description:** The top-of-file comment in `index.ts` says a blank default config is written on first startup. Since 1.4.0, nothing is written until the setup wizard is confirmed (see the config bootstrap note in `AGENTS.md`). Rewrite the paragraph to describe the wizard.

**Acceptance criteria:**
- [x] Header describes the first-press setup wizard and states that nothing is written until confirmed
- [x] `grep -n "blank default config" index.ts` returns nothing

**Verification:**
- [x] `npm test` green (comment-only change); `lens_diagnostics` clean

**Dependencies:** T3 (same file; land after the extraction to avoid churn)
**Files:** `index.ts`
**Scope:** XS (1 file)

---

## Checkpoints

### After Phase 1 (T1, T2, T9)
- [x] `npm test` green with the T1 boundary tests
- [x] `ci.yml` green on `main`
- [x] T9 answers recorded, and T10 and T11 marked needed or skipped

### After Phase 2 (T3, T4)
- [x] Characterization tests green before and after the extraction
- [x] Real-editor command test green locally, and fails under `CI=true` if a peer is missing

### After Phase 3 (T5, T6, T7)
- [x] Symlink, corrupt-file, and permission cases all covered by tests
- [x] Manual smoke test: leader key, command binding, exec binding, corrupt config

### Complete
- [x] Every acceptance criterion above ticked, with the evidence recorded
- [x] T8 decided; T10 and T11 done or skipped per T9
- [x] Ready for review

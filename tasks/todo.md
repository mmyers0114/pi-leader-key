# Tasks: First-Run Setup Wizard

> Target **1.4.0**. Spec: `SPEC-first-run-setup.md`. Plan: `tasks/plan.md`.
> Baseline on 1.3.0: **333 tests passing**.
> Supersedes `tasks/archive/1.2.0-command-args/`.

**Commands (all tasks):**
- Test: `npm test` (= `tsc --noEmit && tsx --test __tests__/*.test.ts` — all
  three test files, not just logic)
- Single file: `npx tsx __tests__/logic.test.ts`
- Lint: none configured; pi-lens runs on save. Verify with
  `lens_diagnostics mode=full`.
- Manual run: `pi install /home/matthew/Projects/pi-leader-key`, then delete
  `~/.pi/agent/leader-key.json` and press `ctrl+space`.

---

## Phase 1: Foundation (`logic.ts` — headless, fully testable)

### Task 1: Extract the atomic write and add `saveConfig()`

**Description:** `saveBinding()` (`logic.ts:746`) does read → merge → temp
file → rename, refusing to overwrite a corrupt or non-object file. The wizard
needs identical discipline, so extract the write half into a shared helper and
add `saveConfig()` on top of it. Merging happens against the **raw parsed
object**, not the normalized config, so fields this version does not model
survive a save.

**Acceptance criteria:**
- [ ] `saveConfig(next: Partial<Config>, path?: string)` writes `next` merged
      over the raw parsed file, creating the file and its parent directory
      when absent
- [ ] The shared write helper performs temp-file + `renameSync`, cleans the
      temp file on failure, and `saveBinding()` is refactored onto it with
      **no behavior change**
- [ ] A corrupt or non-object existing file is refused, never overwritten;
      the caller receives `{ ok: false, error }` and decides how to surface it
- [ ] The input object is not mutated

**Verification:**
- [ ] Tests pass: `npx tsx __tests__/logic.test.ts` — new asserts for
      all-four-fields-plus-starter-binding write, preservation of unrelated
      keys and key order, no input mutation, corrupt-JSON refusal,
      non-object refusal, missing-directory creation, atomicity (no `.tmp`
      left behind); existing `saveBinding` tests unchanged and green
- [ ] Manual check: none — pure logic
- [ ] `lens_diagnostics mode=full` clean

**Dependencies:** None
**Files:** `logic.ts`, `__tests__/logic.test.ts`
**Estimated scope:** M (2 files)

---

### Task 2: Export `positiveMs` and add `validateEditorEffect()`

**Description:** The wizard needs to validate the two timeout fields and the
`editorEffect` choice. `positiveMs()` (`logic.ts:224`) already exists but is
module-private; `loadConfig()` (`logic.ts:268-271`) inlines the editorEffect
coercion instead of naming it. Export the first, extract the second.

**Acceptance criteria:**
- [ ] `positiveMs` is exported and unchanged in behavior
- [ ] `validateEditorEffect(raw: unknown): EditorEffect` accepts `"none"` and
      `"grayedOut"`, coerces legacy `"spinner"` to `"grayedOut"`, and falls
      back to the default for anything else — matching `loadConfig()` exactly
- [ ] `loadConfig()` calls `validateEditorEffect()` instead of its inline
      ternary, with no behavior change

**Verification:**
- [ ] Tests pass: `npx tsx __tests__/logic.test.ts` — `positiveMs` rejects
      non-numeric, zero, negative, and strings (wizard parses with `Number()`
      first; a string in the file stays a fallback); accepts finite numbers;
      `validateEditorEffect` pins all four cases above; existing
      `editorEffect` load tests unchanged and green
- [ ] `lens_diagnostics mode=full` clean

**Dependencies:** None · **Parallel-safe with Task 3** (separate region of `logic.ts` — but see plan: two agents in one file is the failure mode, so prefer sequential)
**Files:** `logic.ts`, `__tests__/logic.test.ts`
**Estimated scope:** S (2 files)

---

### Task 3: Remove `ensureConfig()` and its tests

**Description:** The silent bootstrap is the thing being replaced. Delete it
and everything that exists only to serve it. `DEFAULT_CONFIG` (`logic.ts:63`)
stays — it is used throughout.

**Acceptance criteria:**
- [ ] `ensureConfig()` (`logic.ts:300-308`), `defaultConfigJson()`
      (`logic.ts:289`), and `EnsureConfigResult` (`logic.ts:293`) are removed
      — all three become dead once `ensureConfig` goes
- [ ] The import at `index.ts:85` and the call at `index.ts:121` are removed
- [ ] The test block at `__tests__/logic.test.ts:804-857` is removed and no
      test references `ensureConfig`
- [ ] Loading the extension with no config file writes nothing to disk

**Verification:**
- [ ] Tests pass: `npm test` — suite green at 333 minus the removed
      `ensureConfig` asserts
- [ ] Manual check: with `~/.pi/agent/leader-key.json` deleted, load pi and
      confirm no file appears (check `ls ~/.pi/agent/`)
- [ ] `lens_diagnostics mode=full` clean — no unused-import findings

**Dependencies:** None
**Files:** `logic.ts`, `index.ts`, `__tests__/logic.test.ts`
**Estimated scope:** S (3 files, deletions)

> ⚠ **Transient state:** between this task and Task 5 a fresh install gets no
> file and sees "No leader bindings configured" — today's behavior minus the
> blank file. Benign, but ship Tasks 3 and 5 in the same range.

---

## Checkpoint: Foundation

- [ ] `npm test` green
- [ ] `lens_diagnostics mode=full` clean
- [ ] `logic.ts` still free of pi imports (the suite loads it standalone under tsx)
- [ ] Review with human before proceeding

---

## Phase 2: The wizard (vertical slice)

### Task 4: `runSetupWizard()` — four steps plus confirm

**Description:** A new sibling of `runBindingWizard()` (`wizard.ts:193`),
built as one `ctx.ui.custom` overlay following the `questionnaire.ts`
pattern. Four uniform fields: leader key (free text), the two timeouts (free
text, `positiveMs`), editor effect (`SelectList` over `grayedOut` / `none`),
then a confirm summary. Escape goes back a step; escape at step one writes
nothing. **Do not refactor `runBindingWizard`** — it is a binding state
machine and the two change independently.

**Acceptance criteria:**
- [ ] One overlay for the whole flow, reusing `makeEditor` (`wizard.ts:91`),
      `makeSelectList` (`wizard.ts:75`) and `selectListTheme` (`wizard.ts:57`)
      — no new theming
- [ ] Confirm writes via `saveConfig()` with all four fields plus
      `bindings: { r: { command: "/reload" } }`; a failed write leaves the
      config untouched and shows the error inline, not as a thrown overlay
- [ ] Escape/cancel at any step writes nothing
- [ ] The leader-key step is **not** validated against pi's reserved
      bindings — pi's own diagnostic covers that
- [ ] Stays under ~200 lines. If it grows, the shape is wrong — say so
      rather than adding state

**Verification:**
- [ ] Tests pass: `npm test` (overlay UI is manual; logic paths covered via
      Task 1/2 tests)
- [ ] Manual check: walk all four steps, confirm a write, check the file
      contents; then re-enter the wizard and escape at each step confirming
      the file is untouched
- [ ] `lens_diagnostics mode=full` clean

**Dependencies:** Tasks 1, 2
**Files:** `wizard.ts`, `index.ts` (export)
**Estimated scope:** M (2 files)

---

### Task 5: Route the missing-config trigger and add the closing screen

**Description:** Replace the empty-bindings branch at `index.ts:573` — the one
that notifies "No leader bindings configured" — with the wizard, triggered on
`error === "missing"` rather than `bindings.length === 0` so a deliberately
hand-emptied config stays on today's warning path. Then the closing screen,
which must name the **currently active** leader key, not the one just
configured.

**Acceptance criteria:**
- [ ] `loadConfig().error === "missing"` opens `runSetupWizard()`;
      `bindings.length === 0` on an existing file keeps the existing warning
- [ ] The closing screen names the key the user actually has to press right
      now, and then says: press that key, then `r`
- [ ] The active key is **passed into** the wizard rather than re-read from
      config, so there is only one value to name
- [ ] The `capturing` guard (`index.ts:568`) still covers the wizard path, so
      two leader presses cannot open two overlays
- [ ] Confirming writes the config; the new key is **not** described as live
      until the reload confirms it

**Verification:**
- [ ] Tests pass: `npm test`
- [ ] Manual check, fresh install: delete the config, press `ctrl+space`,
      complete the wizard, confirm the closing screen names `ctrl+space` and
      not the newly chosen key
- [ ] Manual check: with an existing config whose `bindings` is `{}`, press
      the leader key and confirm the **warning** appears, not the wizard
- [ ] `lens_diagnostics mode=full` clean

**Dependencies:** **Task 3** (hard — while `ensureConfig()` runs, the file
always exists, `error` is never `"missing"`, and the wizard cannot open) and
Task 4
**Files:** `index.ts`, `wizard.ts`
**Estimated scope:** M (2 files)

---

### Task 6: Guard `ctx` teardown after a reload-triggering dispatch

**Description:** The `finally` at `index.ts:591` calls
`ctx.ui.setStatus("leader", undefined)` **after** dispatch. Dispatching the
`r` → `/reload` binding invalidates `ctx` — pi's runner says *"This extension
ctx is stale after session replacement or reload. Do not use a captured pi or
command ctx after `ctx.reload()`."* Make the teardown safe in that case, and
quote the warning in a comment so a later "helpful" cleanup does not put it
back.

**Acceptance criteria:**
- [ ] The leader-indicator teardown does not touch an invalidated `ctx` and
      cannot throw out of the `finally`
- [ ] No `Shortcut handler error:` toast appears after a reload-triggering
      dispatch
- [ ] The `invalidate()` warning is quoted in a comment at the guard
- [ ] The `r` → `/reload` binding survives the reload it triggers

**Verification:**
- [ ] Tests pass: `npm test`
- [ ] Manual check: `leader` → `r`, confirm no error toast, no stuck LEADER
      indicator, and the leader key still works afterward
- [ ] `lens_diagnostics mode=full` clean

**Dependencies:** Task 5
**Files:** `index.ts`
**Estimated scope:** S (1 file)

---

## Checkpoint: Wizard

- [ ] `npm test` green
- [ ] `lens_diagnostics mode=full` clean
- [ ] End-to-end: fresh install → leader key → wizard → configured working
      leader key, with no file ever written on load
- [ ] Review with human before proceeding

---

## Phase 3: Verification and loose ends

### Task 7: Manual in-session pass over the Success Criteria

**Description:** The wizard's behavior is manual by nature. Walk every
Success Criterion in `SPEC-first-run-setup.md` in a real pi session and check
each one off. This is also where the spec's two Open Questions get answered.

**Acceptance criteria:**
- [ ] Every Success Criterion in the spec is checked off, or explicitly
      marked not-met with a note
- [ ] Repeat-press: two leader presses in quick succession open one overlay,
      not two
- [ ] Escape/cancel at every step leaves the file absent or byte-identical
- [ ] A corrupt existing config is reported and never overwritten
- [ ] Repeated reloads accumulate no state — no stuck overlay, no leaked
      timers, no growing bindings
- [ ] **Open Question:** does the leader overlay teardown flicker on repeated
      reloads? (cheapness is settled; visual cleanliness is not)
- [ ] **Open Question:** should the wizard warn on a corrupt-but-existing
      config? Record the answer even if it is "leave as-is"

**Verification:**
- [ ] Manual check: the run itself, with results recorded against the spec
- [ ] Review with human before proceeding

**Dependencies:** Tasks 4, 5, 6
**Files:** none (verification only); spec checkboxes if updated
**Estimated scope:** S (1 session)

---

### Task 8: Close the 1.2.0 args-wizard manual-run gap

**Description:** Carried forward from
`tasks/archive/1.2.0-command-args/todo.md`: Task 4 there is marked complete
but annotated *"manual in-session run still pending"*, and its checkpoint is
still open. The args step was shipped in 1.2.0 and never exercised
interactively. It lives in the same file the new wizard is touching, so
verify it while that context is open.

**Acceptance criteria:**
- [x] Create a command binding **with** args and one **without** via
      `/leader-bind`; fire both through the leader key in-session
      (2026-10-05: `ptl`/`ptf`/`ptu`/`pto` plus plain bindings, fired e2e)
- [ ] The summary and conflict lines display the composed `command + args`
      (summary exercised by those saves; a prefix-conflict display was not)
- [x] A binding with args survives save → reload → fire
- [x] The 1.2.0 archive note is updated to reflect the result

**Verification:**
- [ ] Manual check: the run itself
- [ ] Result recorded in `tasks/archive/1.2.0-command-args/todo.md`

**Dependencies:** None — **fully independent**; safe at any point
**Files:** `tasks/archive/1.2.0-command-args/todo.md`
**Estimated scope:** XS (1 session, no code)

---

## Checkpoint: Verified

- [ ] Every Success Criterion in `SPEC-first-run-setup.md` checked off
- [ ] Repeated-reload pass clean
- [ ] 1.2.0 args gap closed and recorded
- [ ] Review with human before proceeding

---

## Phase 4: Release

### Task 9: Docs and 1.4.0

**Description:** Document the wizard where users will find it, and make the
docs true again. `AGENTS.md` currently documents the `ensureConfig()`
bootstrap as a maintenance fact — that paragraph is now wrong.

**Acceptance criteria:**
- [ ] `README.md` describes the first-run wizard; config docs and wizard
      strings stay identical to what ships
- [ ] `AGENTS.md`: replace the `ensureConfig()` bootstrap bullet, and add the
      maintainer facts that are not derivable from the code (the closing
      screen names the **active** key by design; `ctx` must not be touched
      after a reload-triggering dispatch; `loadConfig().error === "missing"`
      is the trigger, not empty bindings)
- [ ] `CHANGELOG.md` 1.4.0 entry: first-run wizard, `ensureConfig()` removed,
      `r` → `/reload` starter binding, reload now applies a changed
      `leaderKey` in-session
- [ ] `package.json` → `1.4.0`

**Verification:**
- [ ] Tests pass: `npm test`
- [ ] Manual check: read-through of README/AGENTS.md against the shipped
      behavior — every documented fact still true
- [ ] Review with human, commit + tag + push

**Dependencies:** Tasks 1–7
**Files:** `README.md`, `AGENTS.md`, `CHANGELOG.md`, `package.json`
**Estimated scope:** S (4 files, docs + version)

---

## Checkpoint: Complete

- [ ] All acceptance criteria met
- [ ] `npm test` green at 333 + new
- [ ] `lens_diagnostics mode=full` clean
- [ ] Human review, commit + tag + push

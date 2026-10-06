# Implementation Plan: First-Run Setup Wizard

> Target release: **1.4.0** (1.3.0 published 2026-10-04).
> Spec: `SPEC-first-run-setup.md`. One-pager: `docs/ideas/first-run-setup-wizard.md`.
> Supersedes the archived `tasks/archive/1.2.0-command-args/` plan (shipped 1.2.0).

## Overview

Replace `ensureConfig()`'s silent blank-config-on-first-load with a one-time
interactive wizard. With no config on disk, pressing the leader key opens a
four-field setup overlay instead of a notification; confirming it writes the
config plus one starter binding (`r` → `/reload`) and shows a closing screen
naming the *currently active* leader key. The trigger is inverted on
purpose: the same condition that makes the wizard open — an unbound leader
key — is a bug in any implementation, so a broken wizard can never silently
do nothing.

Baseline: **333 tests passing** on 1.3.0.

## Architecture Decisions

- **The leader-key press is the trigger; no startup hook, no setup command,
  no marker field.** `loadConfig()` already returns `error: "missing"` when
  the file is absent (`logic.ts:236`), and `registerShortcut` already binds
  the default leader key on a bare install (`index.ts:561`). The wizard
  replaces the existing empty-bindings branch (`index.ts:573`) — no new
  state, no schema change, nothing for a hand-edited config to carry.
- **Trigger on `error === "missing"`, not `bindings.length === 0`.** The
  current branch fires for both an uninitialized install *and* a
  deliberately hand-emptied config. Splitting them keeps "exists but empty"
  on today's warning path, so the wizard never fights a user who meant it.
- **Reload rides the shipped `r` binding, not a direct `ctx.reload()`.**
  Runtime-confirmed 2026-10-05 (mechanism traced in the bundle): the
  factory re-runs on reload, so a new `leaderKey` takes effect, and
  `onExtensionShortcut` is a single property assignment, so the old key
  dies with no ghost residue. Task 6 does not grow a stale-shortcut job. Routing through
  normal command dispatch keeps the wizard from touching `ctx` after a
  runtime swap. Reload is cheap and already routine (user-confirmed), so
  the recommended first binding costs nothing.
- **Extract the atomic write; keep two entry points.** `saveConfig()` and
  `saveBinding()` carry identical read-merge-temp-file-rename discipline.
  Duplicating it invites drift, so the write is shared and the two public
  functions stay separate.
- **The closing screen names the active key, not the configured one.**
  Printing the new key sends the user to press a shortcut that does not
  exist until the reload lands, and they conclude the wizard is broken.
  Called out in Flow, Boundaries, and Success Criteria because it is the
  single easiest thing to get wrong.
- **The starter binding is written to the file, not injected in code**, so
  it stays visible, editable, and discoverable via `/find-commands`.
- **No reserved-key validation in the wizard.** pi's `getShortcuts()` already
  emits a diagnostic for collisions. A hand-maintained reserved list would
  drift from pi's builtins.
- **New wizard, new function.** `runSetupWizard()` is a sibling of
  `runBindingWizard()`, not a refactor of it. That one is 452 lines at
  complexity 64 and is a binding state machine; prefs are a different shape
  and the two will change independently. The four fields are uniform, so
  the prefs wizard is a step list, not another state machine.

## Task List

### Phase 1: Foundation (logic.ts — headless, fully testable)

- [ ] Task 1: Extract the atomic write and add `saveConfig()`
- [ ] Task 2: Export `positiveMs`, add `validateEditorEffect()`
- [ ] Task 3: Remove `ensureConfig()` and its tests

### Checkpoint: Foundation

- [ ] `npm test` green (333 + new)
- [ ] `lens_diagnostics mode=full` clean
- [ ] `logic.ts` still free of pi imports

### Phase 2: The wizard (vertical slice)

- [ ] Task 4: `runSetupWizard()` — four steps plus confirm
- [ ] Task 5: Route the missing-config trigger; add the closing screen
- [ ] Task 6: Guard `ctx` teardown after a reload-triggering dispatch

### Checkpoint: Wizard

- [ ] `npm test` green
- [ ] End-to-end: fresh install → leader key → wizard → configured working
      leader key, with no file ever written on load

### Phase 3: Verification and loose ends

- [ ] Task 7: Manual in-session pass over the Success Criteria
- [ ] Task 8: Close the 1.2.0 args-wizard manual-run gap
      (create/fire/reload confirmed 2026-10-05; conflict-line display still open)

### Checkpoint: Verified

- [ ] Every Success Criterion in `SPEC-first-run-setup.md` checked off
- [ ] Repeated-reload pass: no stuck overlay, no leaked timers, no growing
      bindings

### Phase 4: Release

- [ ] Task 9: Docs and 1.4.0

### Checkpoint: Complete

- [ ] All acceptance criteria met
- [ ] Human review, commit + tag + push

## Dependency Graph

```
Task 1  saveConfig + shared atomic write ──┬──► Task 4  runSetupWizard
                                            │
Task 2  positiveMs export,                 │
         validateEditorEffect ─────────────┴──► Task 4

Task 3  remove ensureConfig ───────────────┐
                                           ├──► Task 5  trigger + closing screen
                                           │            │
                                           │            └──► Task 6  ctx guard
                                           │
                        (Task 4) ──────────┘

Task 7  manual pass  ←── needs Tasks 4, 5, 6 landed
Task 8  args manual run  ←── independent of everything above
Task 9  docs + release  ←── needs Tasks 1–7
```

**Task 3 blocks Task 5, and this is a hard ordering constraint, not a
preference.** While `ensureConfig()` still runs, the config file always
exists after load, so `loadConfig()` never returns `error: "missing"` and
the wizard can never open. Removing it first is what makes the trigger
reachable.

The transient state between Task 3 and Task 5 is benign: a fresh install
gets no file and sees "No leader bindings configured" — today's behavior
minus the blank file. Nothing is broken, the feature is just not there yet.
Ship Tasks 3 and 5 in the same commit range or the window stays open.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Closing screen names the new key instead of the active one | High — user concludes the wizard is broken on first run | Wizard receives the active key as a parameter rather than reading config itself, so there is one value to name. Pinned in Success Criteria. |
| `ctx` touched after `/reload` invalidates it | Med — possible `Shortcut handler error:` toast, leader indicator stuck | Task 6 isolates the teardown at `index.ts:591` and makes the reload case safe. The `invalidate()` quote goes in a code comment. |
| Wizard silently does nothing if the trigger never fires | High — the exact inversion risk the design accepts | Inverted condition is itself a bug: an unbound leader key breaks the key pi holds. Covered by Success Criteria "pressing the leader key opens the wizard". |
| `runSetupWizard` grows into another 452-line state machine | Med — unmaintainable sibling | Four uniform fields; the step list is the design. Keep it under ~200 lines; if it grows, the shape is wrong. |
| Prefs and binding wizards drift apart in look and feel | Low | Both use `makeEditor` / `makeSelectList` (`wizard.ts:91`, `wizard.ts:75`) and `selectListTheme`. No new theming. |
| Removal of `ensureConfig` leaves stale import or dead tests | Low | Task 3 removes `index.ts:85`, the `index.ts:121` call, and the test block at `__tests__/logic.test.ts:805-843` together. |
| Wizard writes a config that wipes hand-added fields | Low | `saveConfig()` merges against the raw parsed object, same discipline as `saveBinding()`. Covered by tests. |

## Parallelization Opportunities

- **Task 2 is fully independent** of Tasks 1 and 3 — separate validators,
  separate tests. Safe to run concurrently.
- **Task 8 is independent of everything** — a manual verification of shipped
  1.2.0 behavior. Safe at any point.
- **Tasks 1 and 3 touch the same file** (`logic.ts`) — sequence them, or
  merge them, but do not parallelize; two agents editing one file is the
  failure mode, not a speedup.
- **Task 4 and Task 5 touch different files** (`wizard.ts`, `index.ts`) and
  can overlap, but Task 5 is meaningless until Task 4 exists, so this buys
  little.

## Open Questions

- Should the wizard warn when a config file exists but is corrupt?
  `reportConfigProblems` (`index.ts:144`) already surfaces that once per
  session, and a corrupt file is not `missing`, so it falls through to the
  empty-bindings warning today. Carried from the spec.
- Does the leader overlay teardown flicker on repeated reloads? Cheapness
  is settled (user-confirmed); visual cleanliness is not. Checked during
  Task 7.

# Implementation Plan: Production Hardening and Test Coverage

> Source: top-to-bottom review of 1.4.0 (hardening and testing focus), this session.
> Task detail lives in `tasks/hardening/todo.md`. This file holds the outline, decisions, and risks.
> Predecessor plan (1.4.0 setup wizard) is untouched in `tasks/plan.md` and `tasks/todo.md`. It shipped in `9bf35e3`; its checkboxes are stale.

## Overview

The pure logic in `logic.ts` is well guarded and the suite is green: `npm test` passes with 352 logic assertions and 28 node:test cases, zero skipped, and `npm audit --omit=dev` reports 0. The gaps are:

1. One confirmed bug: timer values above Node's 32-bit limit make leader mode fire instantly.
2. One confirmed data-safety gap: config writes replace symlinks.
3. The extension wiring in `index.ts` (624 lines) has no automated tests, including the command-dispatch path that is the core feature.
4. CI runs only on release tags, so nothing gates changes to `main`.
5. Smaller items: a misleading message on a corrupt config, a stale header comment, config file permissions, and a dead `biome.json`.

## Architecture Decisions

- **Keep `peerDependencies` at `"*"`.** pi's `docs/packages.md` ("Declare dependencies") says host packages (`pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core`, `typebox`) must use `"*"` and must not be bundled. The package already complies. The earlier proposal to narrow the range is withdrawn. Compatibility is covered by an integration test against the installed pi instead.
- **Extract dispatch from `index.ts` into a testable module.** `dispatchPlan()` in `logic.ts` already routes bindings; the side effects (draft save and restore, submit, exec, reload detection) move behind an injectable `ctx`/editor surface so they can be driven from tests. This follows the existing pattern: logic is pure and testable, `index.ts` executes plans.
- **Fix at the choke point.** The timer cap goes in `positiveMs()`, which both `loadConfig()` and the setup wizard already call. One fix covers both entry points.
- **`tasks/todo.md` stays the durable record.** pi's `todo` tool keeps its state per session, not in the repo, so it only tracks live progress during a session.

## Package Dependencies

- **Declared:** `peerDependencies` `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, both `"*"`. No `dependencies`. `devDependencies`: `@types/node`, `tsx`, `typescript`.
- **Matches pi's `docs/packages.md` ("Declare dependencies"):** host packages use `"*"` peers, are not bundled, and do not appear in `dependencies`.
- **Imports:** the source imports only those two host packages. There are no `typebox` or `pi-ai` imports, so the 0.83.0 TypeBox migration needs no action here.
- **Version skew:** the lockfile records every pi peer at 1.0.2, because npm auto-installs peers and locks them, but the host runs pi 1.1.0. The suite also passes on 1.1.0, checked in a scratch copy (352 logic assertions and 28 node:test cases, 0 failures), so the skew is not breaking today. CI still tests a version users don't run. See T4.
- **Recent pi changes that don't affect this manifest:** 0.99.0 (managed git packages no longer auto-install peers) and 0.76.0 (shrinkwrap removed).

## Task List

### Phase 1: Quick wins with no dependencies
- [x] T1: Cap timer durations at the 32-bit limit
- [x] T2: Add a CI workflow for pushes and pull requests
- [x] T9: Verify two unconfirmed assumptions (investigation only)

### Checkpoint: CI gates the branch
- [x] `ci.yml` green on `main`
- [x] Verified-issue list from T9 recorded in `todo.md` before any fix that depends on it

### Phase 2: Testing the extension wiring
- [x] T3: Extract command, action, and exec dispatch from `index.ts` and test it
- [x] T4: Add an integration test that runs a real command binding through the mounted editor

### Phase 3: Data safety and messaging
- [x] T5: Write config through symlinks without replacing them
- [x] T6: Report corrupt and malformed config accurately on leader press
- [x] T7: Restrict config file permissions to the owner

### Checkpoint: Hardening complete
- [x] `npm test` green, including the new regression tests
- [x] `index.ts` no longer has untested branches in dispatch
- [ ] Manual smoke test: leader key, a command binding, an exec binding, and a corrupt config — **not done, needs a human at a TTY**

### Phase 4: Cleanup
- [x] T8: Decide on `biome.json` (adopt or remove)
- [x] T10: Fix `exec` output cap, only if T9 confirms the issue
- [x] T11: Fix leader-key case handling, only if T9 confirms the issue — **skipped**, T9b found pi case-insensitive
- [x] T12: Correct the stale `index.ts` header comment

### Checkpoint: Ready for release
- [x] All acceptance criteria met
- [x] Changelog entry drafted

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| T3 extraction changes dispatch behavior | High | Add characterization tests against current behavior before moving code (TDD: lock behavior, then refactor) |
| pi private `submitValue` removed in a future pi | High | T4 integration test runs against the installed pi, so a break fails CI instead of users |
| CI runs against a pi version that differs from what users get | Medium | Test against the version resolved by `npm ci`; re-run on pi releases |
| Symlink fix writes through to an unexpected target | Medium | Resolve with `realpathSync` and refuse targets outside the config's real directory |
| CI tests pi 1.0.2 (lockfile) while users run pi 1.1.0 | Medium | T4: pin devDependencies to the host version, or run a matrix over both |
| Hand-editing `index.ts` in two tasks at once | Low | Serialize T3, then T6, then T12 (same file) |

## Open Questions

- T8: Adopt Biome (add the dependency and a lint script) or delete `biome.json`? The project notes say "Lint: none configured".
- T10 and T11 are conditional on T9's findings. T9 decides whether they are worth doing.
- Stale checkboxes in `tasks/plan.md` and `tasks/todo.md` (the shipped wizard): archive them, or leave as history?

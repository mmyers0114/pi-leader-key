# Implementation Plan: Command Args at the Config Level

## Overview

Split the `command` binding's embedded args (`{ "command": "/model opus" }`) into an explicit optional field (`{ "command": "/model", "args": "opus" }`). Command and args get different validation rules (strict vs. opaque), the wizard gains an optional args step, and dropped-binding visibility closes the silent-drop gap. Fully backward compatible: legacy embedded-args bindings load identically. Target release: **1.2.0**, folding in the unpublished 1.1.1 hardening (tag exists locally only — delete it at release time and ship once).

Supersedes the completed binding-wizard plan (shipped in v1.1.0; its todo boxes are checked retroactively in git history).

## Architecture Decisions

- **`args?: string`, not an array.** pi passes handlers one raw string (everything after the first space, no tokenizing, no quote parsing — verified in `agent-session.js:_tryExecuteExtensionCommand`). An array implies a token model that doesn't exist. Schema mirrors the platform.
- **Validation stays in `loadConfig` (per press), not cached at session start.** Dispatch re-reads config every press so hand-edits apply without restart; per-press validation of a tiny JSON file costs microseconds. Caching would reintroduce stale-state crashes for zero measurable gain.
- **Legacy normalization at load, not migration.** `{ "command": "/model opus" }` splits on the first space into command+args and behaves identically. New writes always use the split form. No user action, no breakage.
- **Normalization rule: trim edges only, never touch the interior.** Args are opaque (pi does no quote parsing), so collapsing interior whitespace could corrupt quoted content. Split trims both parts; dispatch composes with a single space.
- **No unknown-command warning anywhere.** Wizard picker is built from live `getCommands()` (impossible path); hand-edited unknown names can't be checked robustly (built-ins aren't enumerable from the extension API). Documented residual, not guarded.
- **Dropped bindings become visible.** `ConfigResult` gains `dropped: string[]`; the shortcut handler notifies once per press when non-empty.

## Task List

### Phase 1: Foundation (logic.ts)

- [x] Task 1: Split command/args schema with legacy normalization
- [x] Task 2: Surface dropped bindings

### Checkpoint: Foundation

- [ ] Full suite green (`npx tsx __tests__/logic.test.ts`)
- [ ] `lens_diagnostics mode=full` clean

### Phase 2: Consumers

- [x] Task 3: Dispatch composes command + args
- [x] Task 4: Wizard optional args step

### Checkpoint: Consumers

- [ ] Full suite green
- [ ] Manual wizard run: create command binding with and without args, fire both in-session

### Phase 3: Release

- [x] Task 5: Docs, verification matrix, 1.2.0

### Checkpoint: Complete

- [ ] All acceptance criteria met, human review, push + tag

## Risks and Mitigations

| Risk | Impact | Mitigation |
| ------ | -------- | ------------ |
| Legacy split changes dispatch bytes (`"/model  opus"` → `"/model opus"`) | Low | pi trims and splits on first space; interior double-space only mattered inside opaque args, which handlers receive trimmed-or-verbatim either way. Covered by a test pinning the normalization. |
| `shouldRestoreDraft` comparison breaks for composed commands | Low | Caller passes the composed string; existing tests plus a new args case pin it. |
| Scope creep into unknown-command guarding | Med | Explicitly out of scope (see decision above); enforce in review. |

## Open Questions

- None. Decided: single 1.2.0 release (minor — new user-facing capability, backward compatible), folding in unpublished 1.1.1. At release: `git tag -d v1.1.1`, combined changelog entry, `package.json` → 1.2.0, tag `v1.2.0`.

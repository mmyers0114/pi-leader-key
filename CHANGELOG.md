# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **CI on every push and pull request.** `.github/workflows/ci.yml` runs `npm test` with `CI=true` on `main` and on PRs; `publish.yml` only ever ran on version tags, so nothing gated a change until release. It runs a matrix over pi `1.0.2` (what the lockfile pins) and `1.1.0` (what the host ships), because the integration suites resolve the real peers and dispatch reaches for pi-tui's private `submitValue()`. `CI=true` makes a missing peer fail instead of skipping, so the matrix cannot pass by testing nothing.
- **Dispatch extracted from `index.ts` into `dispatch.ts`**, behind an injectable `DispatchDeps`. The command, action, and exec paths had no automated coverage at all; they are now characterized in `__tests__/dispatch.test.ts` (22 cases) and driven against pi's real `CustomEditor` in `__tests__/editor-integration.test.ts`. Like `logic.ts`, it imports nothing from pi.
- `__tests__/editor-integration.test.ts`: a command binding submitted through the real editor, asserting the exact text delivered to `onSubmit`, the draft restored afterwards, the `onSubmit` fallback when `submitValue()` is missing, and a guard that fails if a future pi drops `submitValue()` outright.

### Fixed

- **Timer values above Node's 32-bit limit no longer make leader mode fire instantly.** `positiveMs()` caps at `2147483647`, the choke point both `loadConfig()` and the setup wizard already go through, and the wizard's rejection now names the maximum.
- **Config writes no longer replace a symlink with a regular file.** `saveConfig()` resolves the target with `realpathSync` and refuses anything outside the config's real directory, so a symlinked config keeps its link and a symlink pointing at someone else's file is not silently rewritten.
- **A corrupt or wrongly-shaped config now says so on leader press.** `leaderPressOutcome()` reports "could not be parsed — fix or remove leader-key.json" or "is not a leader-key config …" instead of the misleading "No leader bindings configured", and never routes a broken file into the setup wizard, which must not overwrite a file it could not read.
- **A runaway `exec` binding no longer grows without bound.** `pi.exec` concatenates stdout into one uncapped string (pi's `dist/core/exec.js`), so `capOutput()` only trimmed what was already buffered — and the call can also stay pending long past the 15 s timeout, because pi waits for the streams to close and never signals grandchildren. The command is now wrapped as `{ cmd; } 2>&1 | head -c 65536; exit ${PIPESTATUS[0]}`, capping memory below the display cap, breaking the pipe once the bytes are in, and keeping the user's exit code.
- **`/leader-bind` writes the leading slash when a command is taken straight from the picker.** Issue #1. Entering the highlighted match without tabbing first fell back to the picker's bare value, so the config got `{"command":"model"}`, which `validateCommand()` then dropped as `missing-slash` — the key silently did nothing. Tab already prefixed the query line; `resolveCommandSelection()` in `logic.ts` now does the same for the picker fallback, and every value reaching `commandValue` carries its slash.

### Changed

- Config files are written owner-only (`0600`), and an existing config with looser permissions is tightened on the next save.
- The `index.ts` header no longer claims a blank config is written on first startup. Nothing is written until the setup wizard is confirmed.

### Not changed

- Leader-key case handling, after verification: pi-tui's `parseKeyId` lowercases the whole key id (`dist/keys.js:604`), so a hand-edited `CTRL+Space` registers and matches identically. No normalization needed.

## [1.4.0] - 2026-10-05

### Added

- **First-run setup wizard.** With no config file present, the first leader-key press opens a short wizard — leader key, `leaderTimeoutMs`, `sequenceTimeoutMs`, indicator style — and writes the config on confirm with a starter `r` → `/reload` binding. Nothing touches disk until then; cancelling any step writes nothing. The closing notice names the leader key that is live *right now*, since the newly chosen one only registers on the reload.
- `saveConfig()` in `logic.ts`, merging over the raw file so unknown keys and unrecognized bindings survive. `runBindingWizard` now writes through it; saving was already atomic.
- A README section stating the actual sequence grammar — printable ASCII (32–126), no whitespace, case-sensitive, no length cap — instead of leaving the only specification to the error you get for trying an invalid one.
- `__tests__/setup-wizard.test.ts`: 8 checks over the first-run wizard, covering keep-the-default, re-ask on bad input, and that nothing is written unless the confirm is accepted. It redirects `HOME` before importing so the wizard can be tested without a seam in production code.

### Changed

- **Defaults retuned, with a shorter leash.** `leaderTimeoutMs` `3600` → `1000` (vim's `timeoutlen` default; the indicator shows leader mode is armed, so the wait can afford to be short) and `sequenceTimeoutMs` `750` → `400`. The sequence value does double duty as the prefix-disambiguation delay — with `g`, `t`, `w`, `o`, and `v` all carrying several bindings, it cannot go as low as vim's 100ms `ttimeoutlen` without firing premature bindings. Existing configs keep whatever they already had; only new ones get these.
- **Every wizard field offers its default explicitly.** An empty submit keeps the default, and the placeholder names the value and says enter keeps it — so accepting a default is a choice rather than a prefilled box you have to clear. The indicator step marks the shipped default, derived from `DEFAULT_CONFIG.editorEffect` so the marker cannot rot.

- Setup UI is built from pi's own `ctx.ui.input()` / `select()` / `confirm()` dialogs instead of a custom component. They work over RPC, where a custom component cannot, and the interaction needed no custom rendering.
- The leader-indicator teardown no longer touches an invalidated `ctx` after a reload-triggering dispatch, which removes a `Shortcut handler error:` toast when the `r` → `/reload` binding fired.

### Removed

- `ensureConfig()`, `defaultConfigJson()`, and `EnsureConfigResult`. The blank config is no longer written on first startup — that is the wizard's job now. An existing config file, valid or not, is still never touched.

## [1.3.0] - 2026-10-04

### Added

- `npm test` typechecks (`tsc --noEmit`) before running the suite under `tsx --test`.
- The wizard's command step is two keys again: **tab** fills the highlighted match into the query line, **enter** commits it to the args step. `/find-commands` shares the contract.

### Changed

- `editorEffect: "grayedOut"` grays whatever editor is mounted, custom ones included, instead of swapping in a copy of pi's default; falls back to the LEADER status line when no editor has focus.
- `/leader-commands` renamed `/find-commands`. No alias.
- Config hardening: prototype-polluting binding keys, bindings with more than one type, and non-object `bindings` are reported as dropped with a reason rather than silently ignored; `leaderKey` and both timeouts are validated; saving merges into the raw file so unknown fields and unrecognized bindings survive, and writes atomically.
- `exec` output is stripped of ANSI escapes and capped.

### Fixed

- Command step no longer answers "command must start with /" when enter is pressed on a name-only filter (`mod` → `/model`).
- Leader mode no longer loses pasted editor content when a `command` binding runs, and restores the editor effect in a `finally`.

## [1.2.0] - 2026-09-13

### Added

- Command bindings take an explicit optional `args` field:
  `{ "command": "/model", "args": "opus" }` dispatches `"/model opus"`
  through the full editor submit pipeline. Args are opaque (edges trimmed,
  interior kept verbatim); `command` itself must be a bare slash name (no
  interior whitespace). Legacy embedded form (`{ "command": "/model opus" }`)
  normalizes identically at load, so existing configs keep working; new
  `/leader-bind` writes always use the split form.
- `/leader-bind` gains an optional args step after the command pick (Enter
  on empty = no args); summary and conflict lines show the composed
  `command + args` string.
- Invalid bindings are reported: `loadConfig` returns `dropped: string[]`
  and the leader-key handler notifies once per press
  (`Ignored invalid bindings: "x" — check leader-key.json.`).

### Fixed

- Malformed bindings in `leader-key.json` (null, empty, or wrong-shaped
  entries from hand-editing) no longer crash dispatch — `loadConfig` drops
  invalid entries and keeps the valid ones; unknown `action` values notify
  instead of silently doing nothing.
- `/leader-bind` command step requires a leading `/`, so free-typed text
  can't save as a broken `{ command }` binding.
- Command dispatch restores the user's pre-dispatch editor draft (built-ins
  clear the editor; extension commands leave the command text).
- Documented that changing `leaderKey` requires a pi restart (the shortcut
  registers once at startup; all other settings apply on next press).

## [1.1.0] - 2026-09-05

### Added

- `/leader-bind`: interactive binding-creation wizard in a single overlay —
  type → value (command picker with fill-then-confirm, action list, or shell
  command editor) → key sequence → conflict check (exact and prefix overlaps,
  explicit overwrite confirmation) → summary + save. Escape walks back a
  step; cancel writes nothing; a corrupt config file is never overwritten.
  New bindings work immediately without a reload. Reachable via
  `/leader-bind` or the "Add binding" entry atop `/leader-commands`.
- Command picker extracted into one shared component used by both
  `/leader-commands` and the wizard.

## [1.0.0] - 2026-09-05

### Added

- Leader key (default `ctrl+space`) with multi-key sequences; bindings for
  slash commands, built-in actions (`compact`, `shutdown`, `clearEditor`),
  and shell one-liners, with prefix-disambiguation timers.
- `/leader-commands`: runtime command discovery over `pi.getCommands()` —
  scrollable picker windowed to 10 rows (pi's built-in selector does not
  scroll), fuzzy type-to-filter, provenance labels, exact invokable string
  echoed on selection.
- First-run blank config written to `~/.pi/agent/leader-key.json`, guarded to
  never overwrite an existing file; config lives outside the package so it
  survives updates.

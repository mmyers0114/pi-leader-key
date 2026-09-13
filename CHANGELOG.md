# Changelog

All notable changes to this project are documented in this file.

## [1.1.1] - 2026-09-13

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

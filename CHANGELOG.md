# Changelog

All notable changes to this project are documented in this file.

## [1.1.0] - unreleased

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

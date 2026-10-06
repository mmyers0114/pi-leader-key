# First-Run Setup Wizard

## Problem Statement

How might we make a fresh install of pi-leader-key guide the user to a
working configuration, instead of silently writing a blank config file and
leaving them to read the README?

## Recommended Direction

Trigger the wizard from the leader-key press itself. The shortcut handler
already branches on "nothing usable here" (`index.ts:573`), so the wizard
simply replaces that notification. No startup hook, no new command, no
state flag — the trigger is the key the user is already being told to
press. The entry point exists even with no config on disk: `loadConfig()`
falls back to defaults at load (`index.ts:118`), so `registerShortcut`
still binds `ctrl+space`.

The wizard collects prefs only — `leaderKey`, `leaderTimeoutMs`,
`sequenceTimeoutMs`, `editorEffect` — and writes one starter binding,
`r` → `/reload`, to disk. It closes by instructing the user to press
their *currently active* leader key, then `r`, to apply the new
configuration.

"Missing file" means uninitialized. A file that exists with zero bindings
keeps today's "No leader bindings configured" warning, since that is a
state a user can reach deliberately by hand-editing.

Reloading via the `r` binding rather than `ctx.reload()` from the wizard is
deliberate. It runs the reload through the ordinary command-dispatch path
(`setEditorText` + `submitViaEditor`, `index.ts:369-371`), so the wizard
never touches `ctx` after a runtime swap and needs no overlay-teardown
ordering around a reload. It also fixes a problem that is not first-run:
hand-editing `leaderKey` today leaves the key dead until pi restarts, with
no in-session recovery. A shipped `r` → `/reload` makes that self-healing
forever and doubles as the documentation of how to apply config changes.

Two pi internals shape this design:

- `extension.shortcuts` is a `Map` keyed by shortcut
  (`dist/core/extensions/loader.js:256`), and the TUI snapshots it into a
  closure at startup (`interactive-mode.js:1709-1760`). A runtime
  `registerShortcut` is therefore a no-op; only the reload path
  (`interactive-mode.js:5389`) re-snapshots. This is why applying a new
  `leaderKey` requires a reload at all.
- `/reload` is a documented built-in command
  (`docs/slash-commands.md:49`) that reloads keybindings, extensions,
  skills, templates, themes, and context files.

The starter binding is written to the config file rather than injected in
code, so it stays visible, editable, and discoverable via `/find-commands`.

## Key Assumptions to Validate

- [ ] Delete config → press `ctrl+space` → wizard opens → choose a new
      leader key → press `ctrl+space` then `r` → the new key opens leader
      mode in the same session.
- [ ] No `Shortcut handler error:` toast from the `finally` cleanup at
      `index.ts:590-593`, which runs `ctx.ui.setStatus("leader", undefined)`
      after dispatch and therefore after `/reload` has invalidated `ctx`.
- [ ] The `r` → `/reload` binding survives the reload it triggers (it is
      read from disk by the re-created extension instance).
- [ ] Repeated reloads do not accumulate state — bindings, timers, or a
      stuck overlay.
- [ ] The final screen names the *active* key, not the newly configured
      one. If it printed the new key, the user would press a key that has
      no registered shortcut yet and conclude the wizard is broken.
- [ ] Users who press `ctrl+space` before reading any docs land in the
      wizard rather than confused.

## Risks to Test

- **Stale ctx in the cleanup path.** pi surfaces handler throws as a
  `Shortcut handler error:` toast (`interactive-mode.js`), so the failure
  is visible rather than silent. Guard the status cleanup with a
  try/catch; the indicator is moot after a reload since the extension is
  re-created.
- **Builtin key collision.** If the user picks a `leaderKey` that pi
  reserves, `getShortcuts` emits "Extension shortcut 'X' conflicts with
  built-in shortcut. Skipping." (`runner.js:449+`) and the key never
  registers. pi already warns, which is the right outcome — do not
  auto-reject, and do not let the wizard imply the new key works before
  the reload confirms it.
- **`r` occupies a sequence the user may later want.** Acceptable, but the
  final screen should frame it as a starter binding rather than a fixture.

## MVP Scope

**In:**

- Remove `ensureConfig()` (`index.ts:121`, `logic.ts:300`). This is
  required, not optional: it writes the file at load, which would make the
  wizard permanently unreachable.
- Route the leader-key "nothing usable here" branch
  (`index.ts:573-575`) to the wizard instead of a notification.
- A prefs wizard over the four tuning fields, reusing the overlay
  conventions in `wizard.ts` (`ctx.ui.custom`, `makeEditor`,
  `makeSelectList`, Escape-to-back).
- A new `saveConfig()` persistence primitive. None exists today —
  `saveBinding()` (`logic.ts:746`) only merges a single binding. It must
  keep the same discipline: merge against the raw parsed JSON rather than
  the normalized config, write to a temp file and `renameSync` into place,
  and refuse to overwrite a corrupt or non-object file.
- Exported validators for the timing fields and the editor effect.
  `positiveMs` (`logic.ts:224`) is module-private and `editorEffect` is
  validated inline inside `loadConfig`.
- A final summary step that prints the active key and the `r` → `/reload`
  instruction.

**Out:** binding creation (reuses `/leader-bind` unchanged), config
migration, a "run setup again" command.

## Not Doing (and Why)

- **Auto-opening at `session_start`.** It hijacks the first screen of every
  install, including the many who never want this extension at all. The
  leader-key press is opt-in by construction.
- **Reusing `runBindingWizard` for prefs.** It is a binding state machine;
  prefs are a different shape, and merging them couples two things that
  change independently.
- **A `setupComplete` marker in the config.** It writes a field the loader
  does not model and that every hand-edited config would have to carry.
- **Migrating existing configs.** Nobody is broken today.
- **Validating `leaderKey` against pi's reserved keybindings.** pi already
  emits a diagnostic, and a hand-maintained reserved-key list would drift
  from pi's builtins.

## Open Questions

- **Escape behavior: keep as decided.** Escaping writes nothing, so the
  config stays missing and the wizard reappears on the next leader-key
  press. This can read as nagging or as persistent invitation; it is
  accepted as-is, but it is the behavior most worth revisiting after real
  use.
- Whether the wizard should warn when the config file exists but is
  corrupt. `reportConfigProblems` (`index.ts:144`) already surfaces that
  once per session, and a corrupt file is not `missing`, so it falls
  through to the empty-bindings warning today.
- Whether `saveConfig()` and `saveBinding()` should share one
  read-merge-write-write helper rather than duplicating the temp-file and
  corrupt-file logic.
- Whether repeated reloads are cheap enough to be a comfortable default
  binding, or whether the reload path (`session.reload()`,
  `keybindings.reload()`, `rebuildChatFromMessages`) is heavy enough to
  warrant timing before shipping `r` as the recommended first binding.
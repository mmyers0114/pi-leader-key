# pi-leader-key

Press the leader key (default `ctrl+space`), then tap a short key sequence to trigger an action, slash command, or shell command.

## Config

`~/.pi/agent/leader-key.json` — written by the first-run wizard, never overwritten once it exists; it lives outside the package so it survives `pi update`.

```jsonc
{
  // Key combination to activate leader mode (default: "ctrl+space").
  // Restart pi after changing it — the shortcut registers once at startup.
  "leaderKey": "ctrl+space",

  // How long leader mode stays armed after the leader key (default: 1000).
  // Vim's `timeoutlen` default. The indicator shows leader mode is armed,
  // so this can stay short.
  "leaderTimeoutMs": 1000,

  // Max wait between keystrokes in a multi-key sequence (default: 400).
  // Also the delay before a prefix binding fires, which is why it is not
  // shorter — see "Sequences" below.
  "sequenceTimeoutMs": 400,

  // Visual indicator during leader mode (default: "grayedOut").
  // "grayedOut" — gray the mounted editor (pi's own or a custom one);
  //              falls back to the LEADER status line when nothing focused
  //              is an editor
  // "none"      — static LEADER status indicator
  // Legacy "spinner" values coerce to "grayedOut"
  "editorEffect": "grayedOut",

  // Key bindings: sequence → binding
  "bindings": {
    "c":  { "action": "compact" },
    "m":  { "command": "/model" },
    "gs": { "exec": "git status" }
  }
}
```

The wizard's starter state is one binding, `r` → `/reload`, so a fresh config is immediately useful. A config with no bindings at all — hand-emptied, or written before 1.4.0 — warns "No leader bindings configured" when the leader key is pressed.

### Binding types

Each binding is exactly one of:

- **`command`** — a slash command, routed through pi's full editor pipeline. Anything starting with `/`. Arguments go in the explicit `args` field: `{ "command": "/model", "args": "opus" }` dispatches `"/model opus"`, exactly like typing it. Legacy embedded form (`{ "command": "/model opus" }`) normalizes identically at load (split on first space, trim edges, interior verbatim). Args are opaque — never an array, never re-tokenized.
- **`action`** — direct API call: `"compact"` (trigger conversation compaction), `"shutdown"` (graceful shutdown), `"clearEditor"` (clear the editor text).
- **`exec`** — shell command run via `bash -c`; output is shown as a notification.

Wizard specifics (`/leader-bind`): command values must start with `/`; sequences are validated (printable ASCII, no whitespace); conflicts with existing bindings — exact or prefix overlaps — require explicit overwrite confirmation; a corrupt config file is never overwritten (save refuses and reports); the save preserves all other bindings and non-binding fields.

### Sequences

A sequence is one or more keys typed in order after the leader key: `"c"` or `"gs"`.

- Each character must be printable ASCII — codes 32–126, so `!` through `~`. No unicode, no function keys.
- Whitespace is rejected anywhere in the sequence, which includes the space bar.
- Matching is case-sensitive and exact: `"g"` and `"G"` are different bindings.
- There is no length cap. There is also no reason to go past three — a longer one is slower to type and no easier to recall.
- Escape cancels leader mode. Any other non-printable key is ignored rather than treated as part of a sequence.

A sequence that is also a prefix of another binding waits `sequenceTimeoutMs` for the next key: with both `"g"` and `"gs"` bound, leader+`g` waits briefly for `s` before firing `"g"`. That is why `sequenceTimeoutMs` is not as short as it could be — it is a decision window, not just a typing gap.

## Adding bindings

Run `/leader-bind` for an interactive wizard: type → value (+ optional args step for `command`) → key sequence →
conflict check → save. It writes the merged config and the binding works
immediately. Escape backs out a step; cancel writes nothing.

Alternatively, edit `~/.pi/agent/leader-key.json` by hand. Discover available
slash commands from the environment at runtime rather than trusting any cached
list:

1. `/find-commands` — picker over `pi.getCommands()` (extension commands, prompt templates, skills), generated at invocation time; type-to-filter fuzzy-matches names and descriptions; tab fills the highlighted command into the picker's query line and enter inserts it into the editor (falling back to an echoed string when the editor holds unrelated text)
2. `pi list` — installed packages
3. `grep registerCommand` in extension source files — registered commands
4. Skill `SKILL.md` files — their registered slash commands
5. Ask the user which commands they want mapped

## Maintaining

Test command and dev-install workflow: README, "Development". Facts the README doesn't carry:

- Config bootstrap: **gone as of 1.4.0**. `ensureConfig()` used to write a blank config on first load; it is deleted, along with `defaultConfigJson()` and `EnsureConfigResult`. Nothing writes to disk until the user confirms the wizard. The trigger branches on `loadConfig().error === "missing"`, NOT on `bindings.length === 0` — a deliberately hand-emptied config keeps the old "No leader bindings configured." warning.
- Testing the setup wizard: `CONFIG_PATH` is `join(homedir(), ...)` evaluated once at module load, so `__tests__/setup-wizard.test.ts` sets `process.env.HOME` to a temp dir **before** the dynamic `await import("../wizard.ts")`. Do not add an env seam to `logic.ts` to make this easier — `$HOME` already does it, and the import has to stay dynamic.
- `sequenceTimeoutMs` does **double duty**: the gap between keys in a sequence *and* the prefix-disambiguation delay. With `g`, `t`, `w`, `o`, `v` all carrying several bindings, dropping it toward vim's 100ms `ttimeoutlen` fires premature bindings. `leaderTimeoutMs` has no such constraint — the grayed-out editor already shows leader mode is armed, which is why it matches vim's 1000ms `timeoutlen`.
- `ask()` in `wizard.ts` treats an empty submit as "keep the default" and names the default in the placeholder. `ctx.ui.input` returns `string | undefined`, so `undefined` is cancel and `""` is an empty submit — that distinction is the whole contract, don't collapse it.
- Keep `logic.ts` free of pi imports — the test suite loads it standalone under tsx, where `@earendil-works/pi-*` don't resolve. The peers are declared in `package.json` and resolved by pi at runtime.
- TUI components split across the peers: containers/widgets (`Container`, `Text`, `SelectList`, `Editor`, `fuzzyFilter`, …) come from `@earendil-works/pi-tui`; chrome (`DynamicBorder`) comes from `@earendil-works/pi-coding-agent`. The LSP cannot resolve the peers, so a wrong-package import looks clean — verify exports with `node --input-type=module -e "console.log(typeof (await import('PKG')).NAME)"`.
- Leader mode never swaps the editor out. `ui.custom()` without `overlay: true` replaces the editor container, so the capture overlay renders `tui.getFocusedComponent()` itself (`focusedEditor()` in `logic.ts`) — that is both why the mounted editor has to be captured *inside* the overlay factory and why graying it needs no `setEditorComponent`. `getFocusedComponent()` is declared on pi-tui's abstract `TuiBase`, not on the `TUI` interface pi types the handle as, hence the guarded lookup.
- Graying wraps each rendered line in `ESC[90m` (bright black), not `ESC[2m` (faint): faint only lightens the default foreground, so themed borders and colored text come through untouched. `borderColor` is muted around the `render()` call (`renderEditor()`) and deleted again afterwards when the editor had no border of its own.
- `borderColor` cannot simply be assigned: it may be an own field, a prototype method, or a getter with no setter, and the wrong write throws out of `render()`. `borderAccess()` classifies it and the write is skipped for anything read-only — the lines still gray, only the border stays. Do not "simplify" that away.
- The capture overlay takes focus while it is up (that is what keeps the sequence keys from reaching the editor), so a text cursor blinks out for the duration. The editor's text, keybindings, and undo history are untouched. This is the accepted cost of not replacing the editor.
- The command step is two keys: tab fills the highlighted match into the query line (`makeCommandPicker`'s `onComplete`, default `setQuery("/"+value)`) and stays put; enter runs `acceptCommand()`, which goes through `resolveCommandSelection()` (logic.ts) — a full `/name [args]` line verbatim, otherwise the picker's highlighted match — and moves to the args step. **Invariant: every value reaching `commandValue` carries its leading slash.** Tab supplies it when it fills the query; `resolveCommandSelection()` supplies it for the picker fallback, because `buildCommandMenu()` keeps `value` bare (`label` is the slashed form) for `/find-commands` and the tab handler. `saveBinding()` validates nothing, so a bare name reaches the config file and is then dropped by `normalizeBinding()` as `missing-slash` — issue #1, and the leader key silently does nothing. Do not "simplify" the slash away: tab already prefixes it, which is why the fix went into the fallback rather than into the menu.
- Tab is no longer load-bearing — enter alone is sufficient since the fix above. What tab still buys is staying in the step to look at, refine, or add args inline before committing; the confirm step would cover the review anyway. Removing it is a self-contained change if you ever want it: the tab branch and `onComplete` param in `makeCommandPicker`, the hint string, `index.ts`'s custom `onComplete`, and the "command picker: tab fills, enter accepts" cases. Not a drive-by.
- Re-reading a name-only query as a command produced "command must start with /" for text the picker had just filtered down to a single match — that regression came from tightening the check in a fix set, not from pi. `splitCommandLine()` treats any `/x` of two characters or more as complete, so a half-typed `/mod` commits a command that does not exist; that hole predates the fix and is deliberately left alone. SelectList only knows enter, so the picker's tab branch is written out by hand, and multi-character input is ignored (an editor does not take a pasted chunk here). Nothing in the wizard ever *runs* the command it picks — it only fills the args step.
- Build UI from pi's own dialogs first: `ctx.ui.input()` / `ctx.ui.select()` / `ctx.ui.confirm()`, all returning `undefined`/`false` on cancel, all with `{signal?, timeout?}` options. `ctx.ui.custom()` is for interactions that need their own rendering or input — `docs/extensions.md` says "Use `ctx.ui.custom()` only when the interaction needs its own rendering and input." Dialogs also work over RPC, custom components do not. `runSetupWizard()` is four dialogs and a save; an earlier hand-rolled Container/DynamicBorder/SelectList version was ~250 lines that should not have existed.
- `runSetupWizard(ctx, activeKey)`: `activeKey` is the key pi registered at load, **not** the key just chosen. The new key has no shortcut until the reload lands, so the closing notice must name the one the user can actually press. It rides the `r` → `/reload` starter binding rather than calling `ctx.reload()` directly, so the wizard never touches a ctx that a reload may have invalidated.
- `leaderIndicator()` in `logic.ts` owns the show-grayed-vs-show-LEADER decision so it is testable without a TUI; the warning about a missing editor is once per extension load, not per session — pi's `session_shutdown` reason enum has no "extension unloaded" case. `session_start` clears the in-flight capture, because a session switch can drop an overlay without resolving it.
- `__tests__/editor-integration.test.ts` drives pi's real `TuiMainScreen` and `CustomEditor` (the peers are peerDependencies, so a missing peer skips instead of failing). `logic.test.ts` cannot catch a shape mismatch with what pi actually mounts — that file is what catches it.

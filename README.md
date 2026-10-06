# pi-leader-key

Vim-style leader key shortcuts for the [pi coding agent](https://github.com/earendil-works/pi), inspired by OpenCode.
Press the leader key (default `ctrl+space`), then tap a short key sequence to run a slash command, a built-in action, or a shell one-liner.

## Features

- **Leader key with multi-key sequences** — `gs` for git status, `m` for the model picker, whatever you like
- **Bind any slash command** — including commands contributed by other extensions, prompt templates, and skills
- **Three binding types** — slash commands (with arguments), built-in actions, shell one-liners
- **Interactive setup** — a first-run wizard, then `/leader-bind` and `/find-commands`, no JSON hand-editing required
- **Safe config** — survives package updates, never overwrites your file, refuses to clobber corrupt configs

## Why this exists

pi's native `keybindings.json` only remaps a fixed set of built-in action ids (`tui.*`, `app.*` — see pi's `docs/keybindings.md`). A handful mirror built-in commands like `/new` or `/tree`, but there is **no native way to assign a key to an arbitrary slash command**, and no way at all to bind commands contributed by extensions, prompts, or skills. `pi.registerShortcut()` exists but is an extension-author API (it registers a code handler), not user configuration.

This extension fills that gap: one leader key gives you an unlimited namespace of two- and three-key shortcuts to anything invokable in your session.

## Install

```bash
pi install npm:pi-leader-key
# or straight from git (same release, useful while npm lags):
pi install git:github.com/mmyers0114/pi-leader-key@v1.2.0
```

The first time you press the leader key, a short setup wizard asks for the leader key, both timeouts, and the indicator style, then writes `~/.pi/agent/leader-key.json` (outside the package directory, so it survives updates) with a starter `r` → `/reload` binding. Nothing is written to disk until you confirm. It ends by telling you to press the leader key again and hit `r` — the new key is not live until that reload lands.

Add more bindings any time with `/leader-bind`.

## First run

Press the leader key (`ctrl+space`) with no config file present and a setup wizard opens. It asks four things, then shows a summary to confirm:

| Step | Asked for |
| --- | --- |
| 1 | Leader key — press enter to keep `ctrl+space`, or type another combination; re-asks on an unmatchable one |
| 2 | `leaderTimeoutMs` — press enter to keep `1000`, or type another number |
| 3 | `sequenceTimeoutMs` — press enter to keep `400`, or type another number |
| 4 | Indicator — `grayedOut` or `none`, with the default marked |

Every step offers its default explicitly: the placeholder names the value and says enter keeps it, so accepting a default is a choice you make rather than a prefilled box you have to clear.

Confirming writes `~/.pi/agent/leader-key.json` with those four settings plus one starter binding, `r` → `/reload`:

```jsonc
{
  "leaderKey": "ctrl+space",
  "leaderTimeoutMs": 1000,
  "sequenceTimeoutMs": 400,
  "editorEffect": "grayedOut",
  "bindings": {
    "r": { "command": "/reload" }
  }
}
```

Nothing touches the disk until you confirm, and cancelling or escaping any step writes nothing. The wizard ends by telling you to press the leader key again and hit `r`: **the key you just chose is not live yet** — pi registers the shortcut once at startup, so `/reload` is what puts it in place.

## Quick start

After the wizard (or by hand):

```jsonc
// ~/.pi/agent/leader-key.json
{
  "leaderKey": "ctrl+space",
  "bindings": {
    "c":  { "action": "compact" },
    "m":  { "command": "/model" },
    "gs": { "exec": "git status" }
  }
}
```

Press `ctrl+space`, then `gs` — the shell command runs and its output appears as a notification. Press `ctrl+space`, then `m` — the model picker opens as if you had typed `/model`.

> [!NOTE]
> A new `leaderKey` only takes effect after a reload — pi registers the shortcut once at startup. Run `/reload` (or the wizard's starter `r` binding). Every other setting applies on your next leader press.

## Bind any slash command

Anything you can type after `/` can go behind a key sequence — including commands from any installed package:

```jsonc
{
  "bindings": {
    "ov": { "command": "/om:view" },
    "r1": { "command": "/review:1" },
    "mo": { "command": "/model", "args": "opus" }
  }
}
```

Command bindings run through pi's full editor submit pipeline, exactly as if you had typed the text and pressed Enter — so arguments work too. Put them in the explicit `args` field; the two forms below dispatch byte-identically (`"/model opus"`), and the legacy embedded form keeps loading so existing configs don't break. (pi declines a submit while the editor still holds text, so a `command` binding waits until the box is empty. `action` and `exec` bindings are unaffected — they never go through the editor.)

> [!TIP]
> Don't guess at command names — run `/find-commands` to browse everything invokable in your current session, or `/leader-bind` to pick one and bind it in a single flow.

## Finding commands: `/find-commands`

Opens a scrollable picker over every invokable command in the current session — extension commands, prompt templates, and skills — generated at invocation time, so newly installed packages appear automatically.

- **Type to filter** — fuzzy match over names and descriptions
- Entries show provenance (`extension`, `prompt`, or `skill`) plus the description
- **Tab** fills the highlighted command into the query line so you can read the full name, **Enter** accepts the line — the same two-key contract the `/leader-bind` wizard uses, and the same gesture pi's own command autocomplete uses. The editor is where you were about to type it anyway, so no copying
- If the editor already holds unrelated text, the pick falls back to echoing the exact invokable string (e.g. `/om:view`) for `bindings` — no typos
- **+ Add binding**, the first entry, jumps straight into the `/leader-bind` wizard

In non-TUI mode the list is shown as a plain notification instead. Escape cancels.

> [!NOTE]
> This command was renamed from `/leader-commands`. The old name no longer resolves — the picker browses every command in the session, leader-key related or not. Update any muscle memory, docs, or bindings that reference it.

## Creating bindings: `/leader-bind`

Walks you through a binding in one overlay: pick a type (`command` / `action` / `exec`), enter the value (fuzzy command picker, action list, or free-text shell input), choose a key sequence, confirm, done.

- Sequences must be printable ASCII with no spaces; command values must start with `/`
- In the command step, **Tab** fills the highlighted match into the query line and **Enter** commits that line to the args step — tab never advances, so the full command is on screen for one last look. A typed `/name args` line is taken verbatim, a name-only filter like `mod` resolves to the highlighted `/model` instead of raising a validation error. The wizard never runs the command it picks
- Collisions — exact or prefix overlaps — are shown with the conflicting bindings and require explicit overwrite confirmation
- The merged config is written to `~/.pi/agent/leader-key.json` and works immediately, no reload
- Escape walks back a step; cancelling anywhere writes nothing; a corrupt config file is never overwritten

## Configuration

| Key | Default | Description |
| --- | ------- | ----------- |
| `leaderKey` | `"ctrl+space"` | Combination that activates leader mode. Restart pi after changing it. |
| `leaderTimeoutMs` | `1000` | How long leader mode stays armed after the leader key, in milliseconds. Matches vim's `timeoutlen` default; the indicator shows you it is armed, so the wait can stay short. |
| `sequenceTimeoutMs` | `400` | Max wait between keystrokes in a multi-key sequence, in milliseconds. Also the delay before a prefix binding fires (see below), which is why it is not shorter. |
| `editorEffect` | `"grayedOut"` | Visual indicator while leader mode is active: `"grayedOut"` grays out whichever editor is mounted — pi's own or a custom one — and falls back to a static `LEADER` status when no editor has focus. `"none"` always shows the `LEADER` status. |
| `bindings` | `{}` | Sequence → binding. Empty means the leader key warns until you add some. |

Invalid values fall back to defaults, and malformed binding entries are ignored — a typo in one binding can't break the rest.

### Binding types

| Type | Example | What it does |
| ---- | ------- | ------------ |
| `command` | `{ "command": "/model" }` | Runs a slash command through pi's full editor pipeline |
| `command` + args | `{ "command": "/model", "args": "opus" }` | Same, with arguments (legacy `{ "command": "/model opus" }` also accepted) |
| `action` | `{ "action": "compact" }` | `compact`, `shutdown`, or `clearEditor` |
| `exec` | `{ "exec": "git status" }` | Runs via `bash -c` (15s timeout); output shown as a notification, capped at 2KB |

> [!NOTE]
> `command` + `args` dispatches the composed string (`command + " " + args`) through the same handler a manual Enter press triggers. Args are opaque: edges trimmed, interior kept verbatim; a legacy `"/model  opus"` (double space) normalizes to `"/model opus"`. Unknown command names pass through untouched — the binding fires against whatever is registered that session, so a command from a removed package simply does nothing until the package is back. Composition, normalization, and draft-restore against the composed string are exercised by the automated dispatch matrix in `__tests__/logic.test.ts` (section `dispatchPlan`: built-in + args, the three actions, exec verbatim, unknown/blank bindings, the unnormalized legacy form, and the four draft-restore outcomes) with `__tests__/editor-integration.test.ts` covering the same helpers against pi's real editor; if a command behaves differently bound than typed, please file an issue.

### Sequences

A sequence is one or more keys typed in order after the leader key: `"c"` or `"gs"`.

The rules, which the wizards and `validateSequence()` enforce:

| Rule | Detail |
| ---- | ------ |
| Characters | Each must be printable ASCII — codes 32–126, so `!` through `~`. No unicode, no function keys. |
| Whitespace | Rejected anywhere in the sequence, which includes the space bar. The wizards trim the ends before saving, but `loadConfig` does not rewrite a hand-written key — `" gs "` in the file is a binding that can never match. |
| Length | No hard limit. There is no reason to go past three; a longer one is slower to type and no easier to recall. |
| Case | Case-sensitive and exact. `"g"` and `"G"` are different bindings. |

Escape cancels leader mode. Any other non-printable key — an arrow, a function key — is ignored rather than treated as part of a sequence.

A sequence that is also a prefix of a longer binding waits `sequenceTimeoutMs` for the next key: with both `"g"` and `"gs"` bound, leader + `g` pauses briefly for `s` before firing `"g"`. The wizards treat exact and prefix overlaps in either direction as conflicts and ask before overwriting.

## Development

```bash
npm test                          # tsc --noEmit, then the suite under tsx
pi install /path/to/this/repo     # load as a local package
```

`__tests__/logic.test.ts` is the assert-based suite (no framework) and covers the pure half; `editor-integration.test.ts` and `picker-integration.test.ts` ask the installed pi peers real questions and skip when a peer is missing.

Publishing: pushing a `v*` tag publishes to npm through `.github/workflows/publish.yml`, which runs `npm ci && npm test` first — bump `package.json`, date the CHANGELOG section, tag, and let CI do the rest.

Pure logic (config loading, key matching, menu building) lives in `logic.ts`, deliberately free of pi imports so the suite loads standalone under tsx. The `@earendil-works/pi-*` peers are declared in `package.json` and resolved by pi at runtime.

## License

MIT License

Copyright (c) 2026 mmyers0114

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

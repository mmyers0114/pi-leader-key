# pi-leader-key

Vim-style leader key shortcuts inspired by OpenCode for the [pi coding agent](https://github.com/earendil-works/pi).
Press the leader key (default `ctrl+space`), then tap a short key sequence to run
a slash command, a built-in action, or a shell one-liner.

## Install

```bash
pi install npm:pi-leader-key
```

On first startup a blank config is written to `~/.pi/agent/leader-key.json`. Edit that file to add bindings.

## Config

```jsonc
{
  "leaderKey": "ctrl+space",
  "leaderTimeoutMs": 3600,
  "sequenceTimeoutMs": 750,
  "editorEffect": "grayedOut",
  "bindings": {
    "c":  { "action": "compact" },
    "q":  { "action": "shutdown" },
    "gs": { "exec": "git status" },
    "cx": { "command": "/context" }
  }
}
```

- **leaderKey** — key combination that activates leader mode.
- **leaderTimeoutMs** — how long leader mode stays active before timing out.
- **sequenceTimeoutMs** — max wait between keystrokes in a multi-key sequence.
- **editorEffect** — `"grayedOut"` dims the editor while leader mode is active
  (default); `"none"` shows a static LEADER status instead.
- **bindings** — sequence → binding. A sequence that is also a prefix of a
  longer one waits for `sequenceTimeoutMs` before firing the shorter one.

## Binding types

| Type | Example | What it does |
| ------ | --------- | -------------- |
| `command` | `{ "command": "/model" }` | Runs a slash command through pi's full editor pipeline |
| `action` | `{ "action": "compact" }` | `compact`, `shutdown`, or `clearEditor` |
| `exec` | `{ "exec": "git status" }` | Runs via `bash -c`; output shown as a notification |

Escape cancels leader mode; non-printable keys are ignored.

## Finding commands to bind: `/leader-commands`

`/leader-commands` opens a scrollable picker over every invokable command in
the current session (extension commands, prompt templates, skills) — generated
at invocation time, so newly installed packages appear automatically.

- **Type to filter** — fuzzy match over command names and descriptions.
- Entries show provenance (`extension`, `prompt`, or `skill`) and description.
- Selecting an entry echoes the exact invokable string (`/om:view`,
  `/review:1`, …) to paste into `bindings` without typos; escape cancels.

In non-TUI mode the list is shown as a plain notification instead.

## Development

```bash
npx tsx __tests__/logic.test.ts   # assert-based suite, no framework
pi install /path/to/this/repo     # load as a local package
```

Pure logic (config loading, key matching, menu building) lives in `logic.ts`,
deliberately free of pi imports so the suite loads standalone. The pi-* peer
dependencies are declared in `package.json` and resolved by pi at runtime.

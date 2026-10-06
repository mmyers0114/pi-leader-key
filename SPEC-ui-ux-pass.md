# SPEC — UI/UX pass and visual style lock

## Objective

Give the three interactive surfaces — the first-run setup wizard, `/leader-bind`,
and `/find-commands` — one consistent voice and one locked visual style, then
freeze it. No new features are planned, so this is the last structural pass
before the styling becomes load-bearing.

Success means: a user who uses one of the three has already learned the other two.

## Current state

Three surfaces, two rendering strategies:

| Surface | Renders | Steps | Chars |
| ------- | ------- | ----- | ----- |
| First-run setup | pi dialogs (`ui.input` / `ui.select` / `ui.confirm`) | 4 prompts + confirm | ~110 |
| `/leader-bind` | custom `Container` + `DynamicBorder` + `SelectList` + `Editor` | 8-step union | ~452 |
| `/find-commands` | custom `Container` + `SelectList` + query line | 1 flow | ~90 |

The split is **correct and should stay**. The setup wizard is a form, and pi's
dialogs do forms well — they also work over RPC, where a custom component cannot.
`/leader-bind` is a stateful flow that embeds the command picker and does live
conflict detection mid-entry; that needs its own rendering. What must be unified
is the vocabulary, not the chrome.

A visual vocabulary already exists and is applied consistently:

| Role | Current treatment |
| ---- | ----------------- |
| Border | `DynamicBorder((s) => theme.fg("accent", s))` — `wizard.ts:102`, `:400`, `:599` |
| Title | `theme.fg("accent", theme.bold(title))`, `"Surface — step"` |
| Hint / footer | `theme.fg("dim", hint)`, `"key action • key action"` |
| Error / status | `theme.fg("warning", "  " + status)` |
| Selected row | `theme.fg("accent", ...)` |
| Description | `theme.fg("muted", ...)` |
| Scroll info | `theme.fg("dim", ...)` |
| No match | `theme.fg("warning", ...)` |

The problems are not inconsistency — they are gaps.

## The gaps

1. **No depth indicator.** `/leader-bind` has an 8-member step union but no
   "step N of M". A user in the `confirm` step cannot tell whether they are
   nearly done or halfway.
2. **Steps are numbered by union, not by path.** The union has 8 members; the
   path a user actually walks is 5–6 (`type` → kind-specific → maybe `args` →
   `sequence` → maybe `conflict` → `confirm`). Any N-of-M indicator must count
   the path.
3. **The setup wizard has no chrome at all.** Correct for what it is, but it
   means first-run and `/leader-bind` share only a naming convention. That is
   enough to build on — see *Locked style* below.
4. **No way to see accumulated work.** At `confirm`, the user sees only the
   candidate binding. Nothing shows the sequence they already chose when they
   are at `command`.
5. **Hint strings are duplicated inline** across eight step branches
   (`wizard.ts:461`–`594`) and drift by hand.

## Locked style

Adopt as the project style, and treat changes to it as deliberate:

- **Title**: `theme.fg("accent", theme.bold("Surface — step"))`, `Surface` being
  `Leader key setup` or `New leader binding`. Already universal.
- **Depth**: append ` (N/M)` to the title, `N`/`M` counted along the walked
  path, `M` computed as the steps that branch on the chosen kind.
- **Hint**: `theme.fg("dim", …)`, lowercase, `"verb noun • verb noun"`,
  bullets `•`. Last hint in the list is the escape one.
- **Escape** always returns to the previous step; it cancels only from the
  first step. Already the behaviour — it needs to be named as the rule.
- **Errors** are inline `warning` text, never a dialog. Validation never
  advances the step and never discards the text typed so far — already true in
  `wizard.ts:236-256`.
- **Every default is offered, not prefilled.** New for the setup wizard
  (shipped 1.4.0); the rule generalises to any future prompt.

## Changes

### `/leader-bind`

- Add `pathIndex(step: Step): { n: number; m: number }` in `wizard.ts`, keyed
  off the selected `bindingType` so `M` is honest. Title becomes
  `New leader binding — key sequence (4/5)`.
- Replace the eight inline hint strings with a `hints: Record<Step, string>`
  next to `titles` (`wizard.ts:402-411`), so title and hint stay in one place.
- Render a dim running summary of already-answered fields under the title on
  the `command`, `action`, and `exec` steps — the answer to gap 4.

### `/find-commands`

- Adopt the same title and hint grammar. Audit the no-match and empty-query
  states against `warning` / `dim` as above.
- No structural change.

### First-run setup wizard

- No change. Its dialogs are pi's, and their styling is pi's — overriding it
  would mean hand-rolling chrome to look like something pi already draws well.
- The `"Leader key setup — …"` titles already match the locked grammar.

## Not Doing

- **Unify the setup wizard into a custom panel.** It would lose RPC support and
  add ~200 lines to reproduce input and select.
- **A theming layer.** `theme.fg(role, text)` with a small role vocabulary is
  the whole system. A palette abstraction would be indirection over six call
  sites.
- **Animation, spinners, or progress bars.** Setup takes seconds.
- **A settings UI.** `/leader-bind` and the config file cover it; a settings
  screen is a third surface to keep in sync.
- **Backtracking the grayed-out editor effect.** It is the shipped default and
  the visual anchor for the mode; `none` remains the escape hatch.

## Success criteria

- [ ] Every title matches `Surface — step (N/M)`.
- [ ] Every hint comes from one `hints` record, not a per-branch literal.
- [ ] `N/M` is correct on all four `/leader-bind` paths (command, command+args,
      action, exec).
- [ ] A new maintainer can state the six visual roles without reading the code.

## Open questions

- Should `/find-commands` show a hint line at all when the query is empty? An
  empty hint leaves the bottom edge bare next to the list.
- Is ` (N/M)` too much chrome for a 5-step flow? Cheap to test and cheap to
  drop, but it should be decided once, here.
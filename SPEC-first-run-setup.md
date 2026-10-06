# Spec: First-Run Setup Wizard

> Target release: **1.4.0** (1.3.0 shipped 2026-10-04).
> Origin: `docs/ideas/first-run-setup-wizard.md`.

## Objective

A fresh install of pi-leader-key currently writes a blank config on first
load and says nothing. The user is left to read the README, learn the
schema, and hand-write JSON before anything works. Replace that silent
bootstrap with a one-time interactive setup wizard that collects the four
tuning fields, writes one starter binding, and leaves the user with a
working leader key.

Success looks like: someone who has only ever seen the extension listed in
`pi list` installs it, presses the leader key they were told about, and
within one wizard gets a configured, working leader key — without opening
the config file.

The trigger is the leader-key press itself. `loadConfig()` falls back to
defaults when no file exists (`logic.ts:230`), so `registerShortcut` at
`index.ts:561` still binds `ctrl+space` on a bare install. The shortcut
handler already branches on "nothing usable here" (`index.ts:574`); the
wizard replaces that notification. No startup hook, no new command, no
state flag.

"Missing file" means uninitialized. A file that exists with zero bindings
keeps today's "No leader bindings configured" warning — that is a state a
user can reach deliberately by hand-editing, and treating it as
uninitialized would fight them.

## Verified pi internals

The design depends on two pi behaviors. Both were traced in the 1.0.4
bundle (`dist/bundle/chunks/chunk-H33F2TZD.js`) and confirmed live on
2026-10-05: a mid-session `leaderKey` edit is picked up on `/reload`, and
the previous leader key is dead afterward. The shortcut set is replaced,
not accumulated. The trace below is the mechanism; the live run is the
proof.

**1. A runtime `registerShortcut` is a no-op; only the reload path
re-registers.** `setupExtensionShortcuts` assigns
`this.defaultEditor.onExtensionShortcut = data => {…}` — a single property
assignment that closes over a shortcut map. It does not append, so it can
never observe a shortcut registered after startup. `getShortcuts()`
builds a fresh `Map` from the currently-loaded extension instances on each
call (derived state, never accumulated), and `handleReloadCommand` calls
`setupExtensionShortcuts(runner)` after `session.reload()`. A reload
therefore *replaces* the shortcut set cleanly: the new leader key goes
live and the old one goes dead, with no ghost-key residue to design
around.

**2. The extension factory re-runs on reload.** `session.reload()` calls
`_resourceLoader.reload()` → `loadFinalExtensionSet` →
`loadExtensionPaths` → `loadExtensionsCached`, which per path calls:

```js
let factory = await loadExtensionModule(resolvedPath, cacheToken);
... { extension: await initializeExtension(factory, ...), error: null }
```

The cache is on the **module import**, not the factory call. The cache is
keyed by cwd (`useExtensionCacheCwd` only clears when the cwd *changes*),
so a same-directory reload keeps the cached module — which is correct,
because the extension's code has not changed. But `initializeExtension`
calls `await factory(load.api)` unconditionally on every load. So the
factory re-runs, `loadConfig()` re-reads the file, and the new
`leaderKey` is picked up.

**3. `ctx` is invalidated by a reload.** The extension runner's
`invalidate()` message states: *"This extension ctx is stale after session
replacement or reload. Do not use a captured pi or command ctx after
`ctx.reload()`."* The `finally` cleanup at `index.ts:591` calls
`ctx.ui.setStatus("leader", undefined)` after dispatch, and dispatch of the
`r` → `/reload` binding triggers that invalidation. Any reload path must
guard this call.

**4. Built-in key collisions are detected by pi.** `getShortcuts()`
compares each extension key against `buildBuiltinKeybindings()` and emits a
diagnostic when the built-in sets `restrictOverride === true`. pi already
warns — the wizard does not need to, and must not duplicate it.

## Patterns (source of truth: pi extension examples)

- **Wizard flow** — `examples/extensions/questionnaire.ts`: a single
  `ctx.ui.custom<T>((tui, theme, _kb, done) => …)` overlay for the whole
  wizard, `SelectList` for option steps, embedded `Editor` for free text,
  `done(result)` to exit. One overlay, not one per step.
- **Overlay construction** — the `makeEditor` / `makeSelectList` helpers
  already in `wizard.ts`, with Escape-to-go-back. The prefs wizard is a
  sibling of `runBindingWizard`, not a reuse of it.
- **Free text** — `Editor` with `matchesKey` for Enter/Escape, as in
  `questionnaire.ts`.
- **Config write** — the `saveBinding` discipline in `logic.ts:746`:
  merge against the **raw parsed JSON** rather than the normalized config,
  write to a temp file and `renameSync` into place, refuse to overwrite a
  corrupt or non-object file.

## Flow

1. **Leader key** — the user presses the active leader key (`ctrl+space`
   on a fresh install). No config on disk ⇒ the wizard opens in place of
   the notification at `index.ts:574`.
2. **Leader key** — the user picks the key that will *become* the leader
   key. Presented as a free-text `Editor` step (the user types
   `ctrl+space`, `ctrl+g`, …) with the current value shown for editing.
   Not validated against pi's reserved bindings — pi's own diagnostic
   covers that, and a hand-maintained reserved list would drift.
3. **Timing** — `leaderTimeoutMs` and `sequenceTimeoutMs`, free-text,
   validated by `positiveMs` (`logic.ts:224`), which is currently
   module-private and must be exported.
4. **Editor effect** — `SelectList` over `grayedOut` / `none`, one-line
   descriptions, matching the README.
5. **Confirm** — a summary of the four fields. Confirm writes the config
   with one starter binding, `r` → `/reload`, via `saveConfig()`.
   Cancel/escape at any step writes nothing.
6. **Closing screen** — must name the **currently active** leader key
   (the one from step 1), not the newly configured one, and then say:
   press that key, then `r`. Printing the new key would send the user to
   press a key that has no registered shortcut until the reload completes,
   and they would conclude the wizard is broken.

Reloading through the `r` binding rather than calling `ctx.reload()` from
the wizard is deliberate:

- It routes through the ordinary command-dispatch path
  (`submitViaEditor`, `index.ts:367`), so the wizard never touches `ctx`
  after a runtime swap and needs no overlay-teardown ordering around a
  reload.
- It fixes a problem that is not first-run: hand-editing `leaderKey`
  today leaves the key dead until pi restarts, with no in-session
  recovery. A shipped `r` → `/reload` makes that self-healing permanently
  and doubles as the documentation of how to apply config changes.

The starter binding is written to the config file rather than injected in
code, so it stays visible, editable, and discoverable via `/find-commands`.

`/reload` was measured cheap and already fires often in normal use, so
binding it as the recommended first action costs nothing in practice.

## Commands

```
Test:    npx tsx __tests__/logic.test.ts
Lint:    (none configured — pi-lens pipeline runs on save)
Dev run: pi install /home/matthew/Projects/pi-leader-key
         then delete ~/.pi/agent/leader-key.json and press ctrl+space
```

## Project Structure

```
index.ts                → leader-key handler: route the no-config branch to the
                          wizard; prefs overlay UI (ctx.ui.custom, SelectList, Editor);
                          closing screen naming the active key
wizard.ts               → runSetupWizard(ctx), sibling of runBindingWizard,
                          reusing makeEditor / makeSelectList
logic.ts                → delete ensureConfig(); add saveConfig(); export
                          positiveMs; add validateEditorEffect()
__tests__/logic.test.ts → coverage for saveConfig + the exported validators
~/.pi/agent/leader-key.json → the file written (outside the repo, never committed)
```

`logic.ts` stays free of pi imports (the suite loads it standalone under
tsx).

## Code Style

Match the existing files: 4-space indent, double quotes, function-first,
`ctx.ui.notify(msg, level)` for feedback, no classes.

```ts
export function saveConfig(
    next: Partial<Config>,
    path: string = CONFIG_PATH,
): SaveConfigResult
```

## Testing Strategy

Assert-based suite in `__tests__/logic.test.ts`, run with tsx, no
framework (existing convention — 103 tests today). New coverage:

- `saveConfig`: writes all four fields plus the starter binding; preserves
  unrelated keys and key order; does not mutate its input; **refuses to
  overwrite a corrupt or non-object file**; writes atomically (no partial
  file observable); creates the file and its directory when absent.
- `validateEditorEffect`: `"grayedOut"` / `"none"` accepted, legacy
  `"spinner"` coerces to `"grayedOut"`, anything else rejected.
- `positiveMs` (now exported): rejects non-numeric, zero, and negative.
  A string in the config file stays a fallback (`loadConfig` already pins
  this). The wizard parses free text with `Number()` before calling it.
- `ensureConfig` deletion: no test should reference it.

The overlay UI itself is manually verified in an interactive session.

## Boundaries

- **Always:** run the test suite before committing; keep UI strings and
  schema identical to the README/AGENTS.md config docs; validate before
  writing; treat a failed write as "leave config untouched and say so".
- **Ask first:** changing the config file schema or `editorEffect`
  semantics; adding a dependency; a fourth binding type.
- **Never:** overwrite an existing binding without explicit confirmation;
  write outside the known config fields; overwrite a corrupt config file
  (refuse and report); touch `ctx` after dispatching `/reload`; tell the
  user their new leader key is live before the reload has confirmed it.

## Success Criteria

- [ ] With `~/.pi/agent/leader-key.json` absent, pressing `ctrl+space`
      opens the wizard rather than a notification
- [ ] No config file is written on extension load — `ensureConfig()` is gone
- [ ] Wizard writes all four fields plus `r` → `/reload`; file re-reads as
      valid JSON with `bindings: { r: { command: "/reload" } }`
- [ ] Pressing the **active** leader key then `r` applies the new
      `leaderKey`; the **old** leader key is dead in the same session
      (mechanism confirmed live 2026-10-05 — wizard path still to exercise)
- [ ] The `r` → `/reload` binding survives the reload it triggers
- [ ] No `Shortcut handler error:` toast appears after the reload
- [ ] The closing screen names the **active** key, not the newly
      configured one
- [ ] Escape/cancel at every step leaves the file absent or byte-identical
- [ ] A corrupt existing config is reported and never overwritten by the
      wizard
- [ ] Repeated reloads accumulate no state — no stuck overlay, no leaked
      timers, no growing bindings
- [ ] All new `logic.ts` functions tested; full suite passes
- [ ] README + AGENTS.md document the wizard, and AGENTS.md's
      `ensureConfig()` bootstrap note is updated or removed

## Deferred

- **Editing or deleting existing bindings** — create-only, unchanged from
  the `/leader-bind` decision.
- **`/leader-commands` deprecation** — still deferred; neither picker is
  redundant yet. Re-discuss after the wizard is in real use.
- **A `setupComplete` marker in the config** — it writes a field the loader
  does not model and that every hand-edited config would have to carry.
- **Migrating existing configs** — nobody is broken today.
- **Validating `leaderKey` against pi's reserved bindings** — pi emits its
  own diagnostic, and a hand-maintained list would drift from pi's
  builtins.

## Resolved Questions

- *Does `leader+reload` actually apply a new `leaderKey` in the same
  session?* — **Yes**, runtime-confirmed 2026-10-05. The factory re-runs,
  the shortcut closure is replaced wholesale, and the previous key is
  dead. See "Verified pi internals" 1 and 2 for the mechanism.
- *Is `r` → `/reload` too heavy to recommend as a first binding?* — **No.**
  Reload is cheap and already a routine action in a session.
- *Auto-open the wizard at `session_start`?* — **No.** It hijacks the first
  screen of every install, including users who never want this extension.
  The leader-key press is opt-in by construction.
- *Reuse `runBindingWizard` for prefs?* — **No.** It is a binding state
  machine; prefs are a different shape and the two change independently.
- *Factor `saveConfig()` and `saveBinding()` into one read-merge-write
  helper?* — **Yes.** They carry identical temp-file and corrupt-file
  discipline; duplicating it invites drift. Extract the atomic write, keep
  the two entry points separate.
- *Escape behavior?* — **Keep as decided.** Escaping writes nothing, so
  the config stays missing and the wizard reappears on the next leader-key
  press. This can read as nagging or as a persistent invitation; it is
  accepted as-is and is the behavior most worth revisiting after real use.

## Open Questions

- Whether the wizard should warn when the config file exists but is
  corrupt. `reportConfigProblems` (`index.ts:144`) already surfaces that
  once per session, and a corrupt file is not `missing`, so it falls
  through to the empty-bindings warning today.
- Whether repeated reloads are *visually* clean — not whether they are
  cheap (settled above), but whether the leader overlay teardown
  (`index.ts:591`) flickers or leaves a frame of stale chrome.
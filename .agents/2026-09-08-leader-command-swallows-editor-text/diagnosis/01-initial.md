# Diagnosis: successful `command` binding swallows in-progress editor text

Repo: pi-leader-key @ 4f7c321 (main)

## Root cause

One sentence: the `command` branch of `dispatchBinding` destroys the user's draft before and after the submit — it overwrites the editor buffer with the binding's command text via `setText()`, runs `onSubmit()`, then unconditionally clears the buffer — and nothing in either the extension or pi's submit handler ever saves the pre-existing draft.

## Causal chain

1. **Leader press → dispatch.** `pi.registerShortcut` handler runs `runEffectCapture` then `dispatchBinding` — `index.ts:389-415` (shortcut), `index.ts:230` (dispatch call). The capture overlay does not touch the editor buffer; the damage happens entirely in the command branch.

2. **Draft destroyed (pre-submit).** `index.ts:234-236`:

   ```ts
   if ("command" in binding) {
       leaderEditor?.setText(binding.command);
       await leaderEditor?.onSubmit?.(binding.command);
       ctx.ui.setEditorText("");
       return;
   }
   ```

   `leaderEditor` is the extension's `CustomEditor`, installed via `ctx.ui.setEditorComponent` (`index.ts:113-118`). Pi's `createExtensionUIContext` wires `setEditorText: (text) => this.editor.setText(text)` (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:1920`) and the custom editor *becomes* `this.editor` (`interactive-mode.js:2125`). So `leaderEditor` **is** pi's active editor; `setText(binding.command)` at `index.ts:235` overwrites the user's typed draft in the live buffer. `Editor.setText` (`pi-tui/dist/components/editor.js:917`) replaces all state — it pushes an undo snapshot but nothing restores it automatically. The draft is gone from the buffer here, before any submit logic runs.

3. **Pi's own handler clears again (built-in commands).** `leaderEditor.onSubmit` is the handler pi attached in `setupEditorSubmitHandler` (`interactive-mode.js:2362`; copied onto the custom editor at `interactive-mode.js:2086`). For every built-in slash command it handles (`/model`, `/compact`, `/settings`, `/tree`, … — `interactive-mode.js:2366-2497`), the handler itself calls `this.editor.setText("")` to clear the editor before running the command. So even without step 2, the buffer is wiped. For extension-registered commands the idle path (`interactive-mode.js:2540-2550`, normal-message submission) does *not* clear — which is why the extension added the `ctx.ui.setEditorText("")` line at `index.ts:237`: it emulates the editor's own submit-time clear (`Editor.handleInput` clears before invoking `onSubmit` when the user presses Enter; a programmatic `onSubmit(text)` call does not).

4. **Unconditional final clear.** `index.ts:237` (`ctx.ui.setEditorText("")`) wipes whatever remains, for both built-in and extension-command paths, successful or not.

Net: three independent kill points (235, pi's internal `setText("")` in built-in branches, 237), and the earliest one (235) destroys the only copy of the draft, so no later logic could restore it. There is **no draft save/restore** anywhere in pi's submit handler — `restoreQueuedMessagesToEditor` (`interactive-mode.js:3615`) covers queued *messages*, not editor drafts.

## Why the `action` `clearEditor` binding is not implicated

`clearEditor` → `ctx.ui.setEditorText("")` at `index.ts:258` is a separate branch, only reached when the binding is `{ "action": "clearEditor" }`. The `command` branch returns at `index.ts:238` before any action handling.

## Proposed minimal fix (implementer)

In `dispatchBinding`, `index.ts:234-238` — save the draft before clobbering and restore it after submit:

```ts
if ("command" in binding) {
    const draft = leaderEditor?.getText() ?? "";
    leaderEditor?.setText(binding.command);
    await leaderEditor?.onSubmit?.(binding.command);
    // Restore the user's draft unless the command left meaningful text behind.
    const after = ctx.ui.getEditorText().trim();
    if (!after || after === binding.command.trim()) {
        ctx.ui.setEditorText(draft);
    } else {
        ctx.ui.setEditorText("");
    }
    return;
}
```

Notes for the implementer:

- `ctx.ui.getEditorText()` exists (`pi-coding-agent/dist/core/extensions/types.d.ts:133`; maps to `this.editor.getExpandedText?.() ?? getText()` — the expanded variant is correct since paste markers may be present).
- The conditional is defensive: built-in branches leave `""`, the idle extension-command path leaves the command text — both should get the draft back. If some future/edge handler deliberately sets new text, it wins.
- The pre-submit `setText(binding.command)` at `index.ts:235` is arguably unnecessary for execution (`onSubmit` receives the text as an argument and never reads the buffer on this path), but it gives the visible "command appears in the editor" effect and syncs autocomplete/history state — keep it; the save/restore makes it harmless.
- Do **not** touch `index.ts:258` (`clearEditor`) — that clearing is deliberate.

## Confidence

High. Every link verified against installed sources: the extension's dispatch (`index.ts:234-238`), the UI-context wiring (`interactive-mode.js:1920`), the custom-editor identity (`interactive-mode.js:2086`, `2125`), pi's built-in-command clears (`interactive-mode.js:2366-2497`), and `Editor.setText` semantics (`pi-tui/dist/components/editor.js:917`). Not reproduced live in a TUI session (no runtime reproduction), but the code path is fully static and unambiguous; a live repro would only add confirmation that matches all three kill points.

## Verification (after fix)

Manual TUI check: type some text in the editor → press leader key → fire a `command` binding (e.g. one bound to `/model`). Editor must show the original typed text after the command's UI closes. Automated option: add a logic test is not possible (pi-facing glue is excluded from `logic.ts`), so an integration-style test would need the pi TUI harness — manual verification plus a code-review assert that `draft` is captured *before* line 235's `setText` is the practical check.

## Handoff

status: ready
consumer: implementer — apply the save/restore change in `dispatchBinding` (index.ts:234-238) exactly as specified
blockers: none
pointers: index.ts:234-238 (fix site), index.ts:258 (do not touch), pi-coding-agent dist/modes/interactive/interactive-mode.js:2362 (pi's own submit handler, for reference)

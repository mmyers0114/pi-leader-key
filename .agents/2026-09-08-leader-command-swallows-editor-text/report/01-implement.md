# Implement: draft save/restore in command dispatch

Supersedes the diagnosis' proposed code in one respect: its `else { ctx.ui.setEditorText("") }` branch would have wiped a handler's deliberate new text (contradicting its own "if some future handler deliberately sets new text, it wins" note). The correct form is a conditional restore with no else.

## Semantics verified against installed sources (not guessed)

- `ctx.ui.getEditorText()` exists — `pi-coding-agent/dist/core/extensions/types.d.ts:133`; wired as `this.editor.getExpandedText?.() ?? this.editor.getText()` (`dist/modes/interactive/interactive-mode.js:1921`). Expanded variant is correct (paste markers expand).
- `Editor.setText` is a destructive replace — `pi-tui/dist/components/editor.js:917`; pushes an undo snapshot but nothing restores it automatically.
- Pi's built-in command branches call `this.editor.setText("")` before running (`interactive-mode.js:2366-2497`); the extension-command idle path (`:2540-2550`) does not clear, leaving the submitted command text in the buffer.

## Restore condition chosen

Restore the pre-dispatch draft iff the post-submit buffer, trimmed, is empty (built-in path cleared it) or equals the binding's command trimmed (idle extension path left it). Anything else is the handler's deliberate output and wins. Implemented as `shouldRestoreDraft(afterText, command)` in logic.ts so the decision is testable under tsx (index.ts itself can't load outside pi).

## Diff

- `index.ts:234-245` — command branch: capture `draft = leaderEditor?.getText() ?? ""` before `setText(binding.command)`; after `await onSubmit(...)`, `if (shouldRestoreDraft(ctx.ui.getEditorText(), binding.command)) ctx.ui.setEditorText(draft)`. Import added at `index.ts:77`. `clearEditor` branch (index.ts:265) untouched as instructed.
- `logic.ts:117-131` — new pure `shouldRestoreDraft(afterText, command)`; no pi imports.
- `__tests__/logic.test.ts:770-805` — `shouldRestoreDraft` section: empty/whitespace after-text restores, command-left-in-buffer restores (incl. whitespace-tolerant compare), handler's new text wins, empty-draft case.

## Verification

- `npm test` → `Passed: 148  Failed: 0` (was 142 before; +6 asserts).
- Typecheck: no `typecheck` script exists (package.json has only `test`). LSP diagnostics on the three files are clean. One pre-existing error in untouched code: `index.ts:405` `pi.registerShortcut(config.leaderKey, …)` — `KeyId` is a template-literal union (`pi-tui/dist/keys.d.ts:42`), `leaderKey` loads as `string`. Present before this change (stash-baseline attempt aborted only because typescript isn't a devDep; the line and its operands are untouched by the diff). Not fixed here — out of scope.

## Skipped

- Testing `dispatchBinding` end-to-end with a fake ctx/editor — impossible under tsx (pi imports don't resolve); the decision predicate is the testable unit and is covered.

## Handoff

status: ready
consumer: human — optional manual TUI check (type text → leader key → `/model` binding → draft must reappear); the pre-existing KeyId type error at index.ts:405 if it's wanted fixed
blockers: none
pointers: index.ts:234-245 (fix), logic.ts:117-131 (predicate), __tests__/logic.test.ts:770-805 (test)

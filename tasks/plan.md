# Plan: Binding Wizard (`/leader-bind`)

Implements SPEC-leader-bind.md. Work happens on branch `feat/binding-wizard`.

## Components & Order

1. **Pure logic (logic.ts)** — foundation, no UI dependency
   - `validateSequence(seq: string): string | null` — returns error message or null if valid (non-empty, printable ASCII, no whitespace, trimmed).
   - `findConflicts(bindings, seq): string[]` — exact matches + prefix relations (new is prefix of existing, existing is prefix of new), same rules as runtime matching.
   - `mergeBinding(config, seq, binding): LeaderConfig` — returns NEW config (no input mutation), adds/replaces one binding, preserves all others.
2. **Config write (logic.ts)** — `saveBinding(config, seq, binding): void` — read file → parse → merge → write back. On read/write error: notify and leave file untouched. Lives in logic.ts except the `ctx.ui.notify` call, which stays in index.ts (keeps logic pi-free; return a result object instead).
3. **Wizard overlay (index.ts)** — single `ctx.ui.custom` component, `questionnaire.ts` pattern:
   - Step machine: type → value → sequence → (conflict confirm, conditional) → confirm.
   - Type step: SelectList (3 options + descriptions).
   - Value step: command → existing picker (extract `/leader-commands`'s SelectList rendering into a reusable function); action → SelectList; exec → embedded Editor.
   - Sequence step: Editor + inline validation via `validateSequence`.
   - Conflict step: only rendered when `findConflicts` returns non-empty; lists collisions, explicit confirm.
   - Confirm step: summary + save via `saveBinding`; Escape anywhere → `done(null)`, nothing written.
4. **Entry points (index.ts)**
   - `pi.registerCommand("leader-bind", …)`.
   - "Add binding" item at the top of the `/leader-commands` menu.
5. **Cache check** — verify dispatch re-reads config each press (suspected: `dispatchBinding` takes `current: LeaderConfig` from a cached variable). If cached, reload config after a successful save.
6. **Docs** — README + AGENTS.md: `/leader-bind` mention in binding/config sections.

## Risks & Mitigations

- **Overlay complexity** (5 steps in one component) → step machine as a plain state variable, render function per step, borrowed wholesale from questionnaire.ts's tab pattern.
- **Config write race** (two pi sessions) → out of scope v1; single-user tool, last-write-wins acceptable. Note in code as `ponytail:` comment only if a lock is trivially cheap — otherwise skip.
- **Picker reuse churn** — extracting the shared picker may touch `/leader-commands` rendering; keep the diff surgical, no behavior change to the existing command (its deprecation is deferred and gated on re-discussion).

## Verification Checkpoints

- After step 1–2: full suite green (`npx tsx __tests__/logic.test.ts`).
- After step 3: manual `/leader-bind` run in dev-installed pi session (per spec Commands).
- After step 4–5: success criteria checklist in the spec, item by item.

## Sequencing

Strictly sequential (1→2→3→4→5→6): each layer depends on the previous. No parallel work.

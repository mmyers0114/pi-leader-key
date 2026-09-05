# Tasks: Binding Wizard (`/leader-bind`)

Ordered by dependency. Each task verifiable on its own.

- [ ] Task 1: Pure binding logic in logic.ts
  - Acceptance: `validateSequence`, `findConflicts`, `mergeBinding` exported from logic.ts; no pi imports; new tests in __tests__/logic.test.ts cover empty/whitespace/non-ASCII/valid sequences, exact/prefix/no conflicts, add/replace/preserve/no-mutation for merge.
  - Verify: `npx tsx __tests__/logic.test.ts` — full suite green.
  - Files: logic.ts, __tests__/logic.test.ts

- [ ] Task 2: Config persistence helper in logic.ts
  - Acceptance: `saveBinding(seq, binding)` reads ~/.pi/agent/leader-key.json, merges, writes back; returns `{ ok: true }` or `{ ok: false, error }`; never writes on parse/read/write failure; existing file formatting may be rewritten (JSON.stringify) but all bindings preserved.
  - Verify: tests with a temp config file path (injectable path param) — merge+write round-trip, failure path leaves file untouched.
  - Files: logic.ts, __tests__/logic.test.ts

- [ ] Task 3: Wizard overlay in index.ts
  - Acceptance: single ctx.ui.custom overlay; step machine type → value (command picker / action SelectList / exec Editor) → sequence Editor → conditional conflict-confirm → summary+save; Escape at any step exits writing nothing; command step reuses extracted picker.
  - Verify: manual /leader-bind run in dev-installed pi session (per SPEC-leader-bind.md Commands).
  - Files: index.ts

- [ ] Task 4: Entry points
  - Acceptance: `/leader-bind` registered via pi.registerCommand; "Add binding" item at top of /leader-commands menu opens the same wizard; /leader-commands otherwise unchanged.
  - Verify: both entry points open the wizard; /leader-commands browse behavior unchanged.
  - Files: index.ts

- [ ] Task 5: Immediate-usability cache check
  - Acceptance: after successful save, leader+new-sequence fires without restart; if dispatchBinding uses a cached config, cache is invalidated/reloaded on save.
  - Verify: manual — create an exec binding in-session, fire it immediately.
  - Files: index.ts (only if cache invalidation needed)

- [ ] Task 6: Docs
  - Acceptance: README and AGENTS.md document /leader-bind; /leader-commands section unchanged (deprecation deferred).
  - Verify: read-through against spec's Boundaries ("schema identical to docs").
  - Files: README.md, AGENTS.md

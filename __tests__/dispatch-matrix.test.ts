/**
 * Automated dispatch matrix for command+args bindings (Task 5).
 *
 * Fires each matrix row through the exact command branch mirrored from
 * index.ts dispatchBinding — compose → setText → onSubmit →
 * shouldRestoreDraft — against a stub editor whose post-submit text
 * simulates pi's real handler behavior (built-ins clear the editor,
 * extension commands on the idle path leave the command text, handlers
 * with output leave new text). No pi imports; runs standalone under tsx.
 *
 * Run: npx tsx __tests__/dispatch-matrix.test.ts
 */

import { writeFileSync, unlinkSync } from "node:fs";

import {
    composeCommand,
    loadConfig,
    shouldRestoreDraft,
    type CommandBinding,
} from "../logic.ts";

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${label}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

// ---------------------------------------------------------------------------
// Stub editor + dispatch harness (mirrors index.ts command branch)
// ---------------------------------------------------------------------------

/** Post-submit editor text per simulated handler behavior. */
type HandlerSim = "builtin-clears" | "idle-leaves-text" | "handler-output";

function fireCommand(
    binding: CommandBinding,
    draft: string,
    sim: HandlerSim,
): { submitted: string; finalText: string } {
    const submitted = composeCommand(binding);
    let editorText = submitted; // setText(submitted)
    // onSubmit(submitted): simulate what pi's pipeline leaves behind.
    if (sim === "builtin-clears") editorText = "";
    else if (sim === "idle-leaves-text") editorText = submitted;
    else editorText = "handler output";
    // Draft restore check, exactly as dispatchBinding does it.
    if (shouldRestoreDraft(editorText, submitted)) editorText = draft;
    return { submitted, finalText: editorText };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

console.log("\nDispatch matrix");

{
    // 1. Built-in command with args — submits composed string, draft back.
    const r = fireCommand(
        { command: "/model", args: "opus" },
        "my draft",
        "builtin-clears",
    );
    assertEq(
        r.submitted,
        "/model opus",
        "built-in+args submits composed string",
    );
    assertEq(r.finalText, "my draft", "built-in+args restores draft");
}

{
    // 2. Extension command with args — same pipeline, idle path.
    const r = fireCommand(
        { command: "/om:view", args: "--all" },
        "draft",
        "idle-leaves-text",
    );
    assertEq(
        r.submitted,
        "/om:view --all",
        "extension+args submits composed string",
    );
    assertEq(r.finalText, "draft", "extension+args restores draft");
}

{
    // 3. Skill reference, no args — byte-identical to before.
    const r = fireCommand({ command: "/review:1" }, "", "idle-leaves-text");
    assertEq(r.submitted, "/review:1", "skill ref dispatches bare");
    assertEq(r.finalText, "", "skill ref empty draft is harmless no-op");
}

{
    // 4. Prompt template with args — interior whitespace preserved.
    const r = fireCommand(
        { command: "/reload", args: "a  b" },
        "d",
        "builtin-clears",
    );
    assertEq(r.submitted, "/reload a  b", "args interior kept verbatim");
    assertEq(r.finalText, "d", "prompt+args restores draft");
}

{
    // 5. Unknown command — no guard, passes through untouched.
    const r = fireCommand(
        { command: "/nope-not-real", args: "x" },
        "d",
        "idle-leaves-text",
    );
    assertEq(r.submitted, "/nope-not-real x", "unknown command passes through");
    assertEq(r.finalText, "d", "unknown command restores draft");
}

{
    // 6. Legacy double-space embedded args normalize to split-form bytes.
    const path = "/tmp/lk-matrix-legacy.json";
    writeFileSync(
        path,
        JSON.stringify({
            bindings: {
                legacy: { command: "/model  opus" },
                split: { command: "/model", args: "opus" },
            },
        }),
    );
    const loaded = loadConfig(path).config.bindings;
    unlinkSync(path);
    assertEq(
        composeCommand(loaded.legacy as CommandBinding),
        "/model opus",
        "legacy double-space normalizes",
    );
    assertEq(
        composeCommand(loaded.legacy as CommandBinding),
        composeCommand(loaded.split as CommandBinding),
        "legacy and split dispatch byte-identically",
    );
}

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log("Matrix green.");
}

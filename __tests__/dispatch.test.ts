/**
 * Tests for the dispatch path: what happens after a binding fires.
 *
 * Run: npx tsx --test __tests__/dispatch.test.ts
 *
 * dispatch.ts holds the side effects behind dispatchPlan()'s decision —
 * draft save and restore, command submission, action routing, exec
 * output, reload detection. It takes its pi dependencies as a plain
 * object and imports nothing from pi, so it loads standalone under tsx
 * like logic.ts. index.ts builds that object from ctx and pi.exec and
 * does nothing else.
 *
 * These are characterization tests: they lock the behavior index.ts had
 * before the code moved here, not a newly chosen contract.
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
    dispatchBinding,
    isReloadBinding,
    leaderPressOutcome,
    submitViaEditor,
    type DispatchDeps,
} from "../dispatch.ts";
import {
    DEFAULT_CONFIG,
    loadConfig,
    type BindingAction,
    type MountedEditor,
} from "../logic.ts";

/**
 * Records what dispatch asked pi to do, so a test can read it back.
 *
 * The UI accessors write through to the stub editor, the way pi's
 * `ctx.ui.setEditorText` writes through to its own editor instance —
 * without that, submitValue() would submit nothing.
 */
function stubDeps(over: Partial<DispatchDeps> = {}) {
    const calls: string[] = [];
    const notifications: Array<{ message: string; kind: string }> = [];
    let editorText = "";
    const editor = stubEditor();
    const deps: DispatchDeps = {
        editor,
        notify: (message, kind) => {
            notifications.push({ message, kind });
            calls.push(`notify:${kind}`);
        },
        getEditorText: () => editorText,
        setEditorText: (text) => {
            editorText = text;
            editor.setText(text);
            calls.push(`setEditorText:${text}`);
        },
        compact: () => calls.push("compact"),
        shutdown: () => calls.push("shutdown"),
        exec: async (cmd, timeoutMs) => {
            calls.push(`exec:${cmd}:${timeoutMs}`);
            return { code: 0, stdout: "", stderr: "" };
        },
        ...over,
    };
    return {
        deps,
        calls,
        notifications,
        editor: deps.editor as ReturnType<typeof stubEditor>,
        editorText: () => editorText,
        setEditorText: (t: string) => {
            editorText = t;
            editor.setText(t);
        },
    };
}

/**
 * An editor shaped like pi's: submitValue() is what the Enter handler
 * calls, and it submits whatever text the editor holds.
 */
function stubEditor(text = "") {
    const editor: {
        render: () => string[];
        text: string;
        submitted: string | undefined;
        submitValue: (() => void) | null;
        onSubmit: ((value: string) => void | Promise<void>) | undefined;
        setText(value: string): void;
        getText(): string;
    } = {
        render: () => [text],
        text,
        submitted: undefined,
        submitValue: null,
        onSubmit: (value: string) => {
            editor.submitted = value;
        },
        setText(value: string) {
            editor.text = value;
        },
        getText: () => editor.text,
    };
    editor.submitValue = () => {
        editor.submitted = editor.getText();
    };
    return editor as MountedEditor & {
        submitted: string | undefined;
        submitValue: (() => void) | null;
    };
}

test("command binding: submits through the editor and restores the draft", async () => {
    const stub = stubDeps();
    stub.setEditorText("half-typed thought");

    await dispatchBinding(stub.deps, "m", { command: "/model", args: "opus" });

    assert.equal(
        stub.editor.submitted,
        "/model opus",
        "the composed command was submitted",
    );
    assert.equal(
        stub.editorText(),
        "half-typed thought",
        "the draft is back, because the command left nothing behind",
    );
});

test("command binding: keeps what the command left in the editor", async () => {
    // A command that pre-fills the editor is deliberate output: the draft
    // must not overwrite it. Model that by having the UI accessor report
    // the new text once the command has been submitted.
    const stub = stubDeps();
    stub.setEditorText("original draft");
    const afterSubmit = "/model opus\nnext question";
    stub.deps.getEditorText = () =>
        stub.editor.submitted === undefined
            ? stub.editorText()
            : afterSubmit;

    await dispatchBinding(stub.deps, "m", { command: "/model", args: "opus" });

    assert.equal(
        stub.deps.getEditorText(),
        afterSubmit,
        "the pre-fill survived",
    );
    assert.ok(
        !stub.calls.includes("setEditorText:original draft"),
        "the draft was not written back over it",
    );
});

test("command binding with no editor focused: warns and types nothing", async () => {
    const stub = stubDeps({ editor: null });

    await dispatchBinding(stub.deps, "m", { command: "/model" });

    assert.deepEqual(stub.notifications, [
        {
            message: "That leader command needs the editor focused.",
            kind: "warning",
        },
    ]);
    assert.deepEqual(
        stub.calls.filter((c) => c.startsWith("setEditorText")),
        [],
        "nothing was written anywhere",
    );
});

test("action compact, shutdown, and clearEditor each reach their own hook", async () => {
    const compact = stubDeps();
    await dispatchBinding(compact.deps, "c", { action: "compact" });
    assert.deepEqual(compact.calls, ["compact"]);

    const shutdown = stubDeps();
    await dispatchBinding(shutdown.deps, "q", { action: "shutdown" });
    assert.deepEqual(shutdown.calls, ["shutdown"]);

    const clear = stubDeps();
    clear.setEditorText("something to wipe");
    await dispatchBinding(clear.deps, "x", { action: "clearEditor" });
    assert.deepEqual(clear.calls, ["setEditorText:"]);
});

test("a binding that is none of the three shapes is reported, not run", async () => {
    const stub = stubDeps();
    // loadConfig drops this shape, so it can only arrive from a caller that
    // skipped validation — dispatchPlan() calls it unknown and dispatch
    // says so rather than guessing.
    await dispatchBinding(stub.deps, "z", { action: "explode" } as unknown as BindingAction);

    assert.deepEqual(stub.notifications, [
        {
            message:
                'Binding "z" isn\'t a command, action, or shell command — check leader-key.json.',
            kind: "warning",
        },
    ]);
    assert.deepEqual(
        stub.calls.filter((c) => !c.startsWith("notify")),
        [],
        "nothing else ran",
    );
});

test("exec binding: runs through bash and shows stdout", async () => {
    const stub = stubDeps({
        exec: async () => ({ code: 0, stdout: "on branch main", stderr: "" }),
    });

    await dispatchBinding(stub.deps, "gs", { exec: "git status" });

    assert.deepEqual(stub.notifications, [
        { message: "on branch main", kind: "info" },
    ]);
});

test("exec binding: a failure shows stderr with an [exit N] prefix", async () => {
    const stub = stubDeps({
        exec: async () => ({ code: 2, stdout: "", stderr: "no such branch" }),
    });

    await dispatchBinding(stub.deps, "gs", { exec: "git checkout gone" });

    assert.deepEqual(stub.notifications, [
        { message: "[exit 2] no such branch", kind: "info" },
    ]);
});

test("exec binding: says so when there is no output to show", async () => {
    const stub = stubDeps({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });

    await dispatchBinding(stub.deps, "q", { exec: "true" });

    assert.deepEqual(stub.notifications, [{ message: "[exit 0]", kind: "info" }]);
});

test("exec binding: a failure with no stderr still reports the exit code", async () => {
    const stub = stubDeps({ exec: async () => ({ code: 127, stdout: "", stderr: "" }) });

    await dispatchBinding(stub.deps, "q", { exec: "nope" });

    assert.deepEqual(stub.notifications, [
        { message: "[exit 127] no output", kind: "info" },
    ]);
});

test("exec binding: output is capped and stripped of control sequences", async () => {
    const stub = stubDeps({
        exec: async () => ({
            code: 0,
            stdout: `\x1b[31mred\x1b[0m${"x".repeat(3000)}`,
            stderr: "",
        }),
    });

    await dispatchBinding(stub.deps, "c", { exec: "cat log" });

    const { message } = stub.notifications[0];
    assert.ok(!message.includes("\x1b"), "escape sequences are gone");
    assert.match(message, /… \(\d+ more characters\)$/, "the tail is truncated, not dropped");
});

test("exec binding: the shell command itself is capped", async () => {
    // pi.exec accumulates stdout into a plain string with no bound
    // (pi's dist/core/exec.js), so capping after the fact still leaves
    // `yes` growing it for the whole timeout. The cap has to be in the
    // command, or nothing is capped.
    const stub = stubDeps();
    await dispatchBinding(stub.deps, "y", { exec: "yes" });

    const [call] = stub.calls;
    assert.match(call, /head -c 65536/, `expected a head cap, got: ${call}`);
    assert.match(call, /yes/, "the user's command is still what runs");
    assert.match(call, /15000/, "the timeout is still passed through");
});

test("an unbound key does nothing", async () => {
    const stub = stubDeps();
    await dispatchBinding(stub.deps, "zz", undefined);
    assert.deepEqual(stub.calls, []);
});

test("submitViaEditor prefers submitValue", async () => {
    const editor = stubEditor("hello");
    await submitViaEditor(editor);
    assert.equal(editor.submitted, "hello");
});

test("submitViaEditor leaves onSubmit as it found it", async () => {
    const editor = stubEditor("hello");
    const original = editor.onSubmit;
    await submitViaEditor(editor);
    assert.equal(editor.onSubmit, original);
});

test("submitViaEditor falls back to onSubmit when pi drops submitValue", async () => {
    const editor = stubEditor("hello");
    editor.submitValue = null;
    await submitViaEditor(editor);
    assert.equal(editor.submitted, "hello", "the editor's own text was submitted");
});

test("submitViaEditor with no editor is a no-op", async () => {
    await submitViaEditor(null);
});

test("only a /reload command binding counts as a reload", () => {
    assert.equal(isReloadBinding({ command: "/reload" }), true);
    assert.equal(isReloadBinding({ command: "/reload", args: "now" }), true);
    assert.equal(isReloadBinding({ exec: "/reload" }), false);
    assert.equal(isReloadBinding({ action: "compact" }), false);
    assert.equal(isReloadBinding(undefined), false);
});

function loadFrom(raw: string | null) {
    const path = `/tmp/leader-press-${process.pid}-${raw === null ? "none" : raw.length}.json`;
    if (raw === null) rmSync(path, { force: true });
    else writeFileSync(path, raw);
    return { path, result: loadConfig(path) };
}

test("no config file yet opens the setup wizard", () => {
    const { result } = loadFrom(null);
    assert.deepEqual(leaderPressOutcome(result), { kind: "wizard" });
});

test("an unparseable file is reported, never handed to the wizard", () => {
    const { result } = loadFrom("{nope");
    const outcome = leaderPressOutcome(result);
    assert.equal(outcome.kind, "warn");
    assert.match(
        outcome.kind === "warn" ? outcome.message : "",
        /could not be parsed.*leader-key\.json/,
        "the message names the file and what is wrong with it",
    );
});

test("a file that is not a config object is reported the same way", () => {
    const { result } = loadFrom("[1, 2, 3]");
    const outcome = leaderPressOutcome(result);
    assert.equal(outcome.kind, "warn");
    assert.match(
        outcome.kind === "warn" ? outcome.message : "",
        /is not a leader-key config.*leader-key\.json/,
    );
});

test("a valid config with no bindings says so, and does not open the wizard", () => {
    const { result } = loadFrom(JSON.stringify({ bindings: {} }));
    assert.deepEqual(leaderPressOutcome(result), {
        kind: "warn",
        message: "No leader bindings configured.",
    });
});

test("a usable config goes to the capture overlay", () => {
    const { result } = loadFrom(
        JSON.stringify({ bindings: { r: { command: "/reload" } } }),
    );
    assert.deepEqual(leaderPressOutcome(result), { kind: "capture" });
    assert.equal(DEFAULT_CONFIG.editorEffect, "grayedOut");
});
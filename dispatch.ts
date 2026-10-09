/**
 * Executing a leader-key binding: the side effects behind the plan that
 * `dispatchPlan()` (logic.ts) decides on.
 *
 * Deliberately free of pi imports and driven by a structural `DispatchDeps`,
 * so the suite can load it standalone under tsx — the same trade logic.ts
 * makes. index.ts supplies pi's ctx and pi.exec and does nothing else.
 */

import {
    capOutput,
    dispatchPlan,
    shouldRestoreDraft,
    type BindingAction,
    type ConfigResult,
    type MountedEditor,
} from "./logic.ts";

/** What a shell binding ran: the exit code and both streams. */
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Long enough for a build step, short enough not to hang a keypress. */
export const EXEC_TIMEOUT_MS = 15000;

/**
 * Bytes of output the child is allowed to produce before it is cut off.
 *
 * pi.exec accumulates stdout into one plain string with no bound of its
 * own (pi's `dist/core/exec.js`), so `capOutput()` below only trims what
 * has already been buffered. Without this, `yes` grows that string for
 * the whole timeout. capOutput still does the user-facing trimming; this
 * is the memory ceiling under it.
 */
export const EXEC_OUTPUT_BYTES = 65536;

/**
 * The command `bash -c` actually runs, capped at both ends.
 *
 * stderr goes through the same pipe so a chatty failure cannot dodge the
 * cap. PIPESTATUS carries the user's command's exit code past `head`;
 * when the cap truncates, the writer dies of SIGPIPE and that code
 * becomes 141, which the caller reports verbatim.
 */
export function cappedExecCommand(cmd: string): string {
    return `{ ${cmd}; } 2>&1 | head -c ${EXEC_OUTPUT_BYTES}; exit \${PIPESTATUS[0]}`;
}

/**
 * Everything the dispatch path needs from pi, structurally typed so this
 * module has no pi import. `editor` is the component the capture overlay
 * found, or null when nothing editor-shaped had focus.
 */
export interface DispatchDeps {
    editor: MountedEditor | null;
    notify(message: string, kind: "info" | "warning" | "error"): void;
    getEditorText(): string;
    setEditorText(text: string): void;
    compact(): void;
    shutdown(): void;
    exec(cmd: string, timeoutMs: number): Promise<ExecResult>;
}

/**
 * Submit a command binding through the editor's own submit path.
 *
 * pi-tui keeps submitValue() private, but the Enter handler calls it
 * and it is what a typed command needs: it cancels autocomplete, exits
 * history browsing, and — unlike setText — leaves no undo entry
 * holding the synthetic command text. Going through handleInput("\r")
 * instead would depend on the user not having remapped
 * `tui.input.submit`. onSubmit is wrapped for the duration of the call
 * so the real handler's return value stays awaitable; if a future pi
 * drops submitValue, fall back to calling onSubmit directly.
 */
export function submitViaEditor(editor: MountedEditor | null): Promise<void> {
    if (!editor) return Promise.resolve();
    let pending: void | Promise<void> = undefined;
    const original = editor.onSubmit;
    editor.onSubmit = (value) => {
        pending = original?.(value);
    };
    try {
        // SAFETY: pi-tui marks submitValue private in its .d.ts but the
        // method exists at runtime (the Enter handler calls it), and
        // the typeof guard below falls back if a future pi drops it.
        const submit = (editor as unknown as { submitValue?: () => void })
            .submitValue;
        if (typeof submit === "function") submit.call(editor);
        else original?.(editor.getText());
    } finally {
        editor.onSubmit = original;
    }
    return Promise.resolve(pending).then(() => undefined);
}

/**
 * Run one binding. Deciding what it means is `dispatchPlan()`'s job; this
 * only carries it out, so the routing rules stay testable on their own.
 */
export async function dispatchBinding(
    deps: DispatchDeps,
    key: string,
    binding: BindingAction | undefined,
): Promise<void> {
    if (!binding) return;

    const plan = dispatchPlan(binding);
    if (plan.kind === "command") {
        // Submitting means driving the mounted editor's own handler,
        // which needs the instance the overlay captured. With no editor
        // focused there is nothing to submit into, and silently typing
        // the command somewhere else would be worse than saying so.
        if (!deps.editor) {
            deps.notify(
                "That leader command needs the editor focused.",
                "warning",
            );
            return;
        }
        const submitted = plan.text;
        // Snapshot through the UI accessor, not editor.getText(): a large
        // paste is stored collapsed as a marker, getText() returns that
        // marker, and getEditorText() expands it. Restoring the marker
        // after submitValue() wiped the paste map would lose the pasted
        // text for good.
        const draft = deps.getEditorText();
        // setEditorText writes through pi's own editor instance — the one
        // the capture overlay focused on in practice — so the draft and
        // the submission below land on the same instance.
        deps.setEditorText(submitted);
        await submitViaEditor(deps.editor);
        // Give the draft back unless the command left new text behind.
        if (shouldRestoreDraft(deps.getEditorText(), submitted)) {
            deps.setEditorText(draft);
        }
        return;
    }

    if (plan.kind === "action") {
        switch (plan.action) {
            case "compact":
                deps.compact();
                break;
            case "shutdown":
                deps.shutdown();
                break;
            case "clearEditor":
                deps.setEditorText("");
                break;
            default:
                deps.notify(
                    `Unknown action for "${key}" — check leader-key.json.`,
                    "warning",
                );
                break;
        }
    } else if (plan.kind === "exec") {
        const r = await deps.exec(cappedExecCommand(plan.cmd), EXEC_TIMEOUT_MS);
        // Cap what reaches the TUI — `cat huge.log` shouldn't flood it
        // — and strip control sequences so a command can't move the
        // cursor or rewrite the terminal title through its output.
        const failed = r.code !== 0;
        const body = capOutput(failed && r.stderr ? r.stderr : r.stdout);
        deps.notify(
            failed
                ? `[exit ${r.code}] ${body || "no output"}`
                : body || `[exit ${r.code}]`,
            "info",
        );
    } else {
        deps.notify(
            `Binding "${key}" isn't a command, action, or shell command — check leader-key.json.`,
            "warning",
        );
    }
}

/**
 * True for a binding that reloads the session. Dispatching `/reload`
 * invalidates ctx — pi's runner warns: "This extension ctx is stale after
 * session replacement or reload" — so the shortcut handler must not touch
 * the UI afterwards. Called from a finally block, which is why it takes
 * the raw binding rather than anything it can observe.
 */
export function isReloadBinding(
    binding: BindingAction | undefined,
): boolean {
    return (
        binding !== undefined &&
        "command" in binding &&
        binding.command === "/reload"
    );
}

/**
 * What a leader press should do, given what `loadConfig()` found.
 *
 * A corrupt or wrongly-shaped file is not the same as an empty one: with
 * no bindings at all the user just has nothing bound yet, but a broken
 * file needs saying out loud or the press looks like a dead key. It also
 * must never reach the wizard — nothing overwrites a file it could not
 * read.
 */
export type PressOutcome =
    | { kind: "wizard" }
    | { kind: "warn"; message: string }
    | { kind: "capture" };

export function leaderPressOutcome(result: ConfigResult): PressOutcome {
    if (result.error === "missing") return { kind: "wizard" };
    if (result.error !== null) {
        return {
            kind: "warn",
            message: `${result.error === "parse" ? "could not be parsed" : "is not a leader-key config"} — fix or remove leader-key.json.`,
        };
    }
    if (Object.keys(result.config.bindings).length === 0)
        return { kind: "warn", message: "No leader bindings configured." };
    return { kind: "capture" };
}
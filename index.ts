/**
 * Leader Key Extension — vim-style leader key shortcuts for pi.
 *
 * Reads bindings from ~/.pi/agent/leader-key.json and activates them when
 * you press the configured leader key. An invisible overlay captures
 * keystrokes and matches them against configured bindings. Command bindings
 * are submitted through the editor's own submit path (its normal
 * submit pipeline) for full slash-command processing.
 *
 * Pure logic (config loading, key matching, command-menu building) lives in
 * logic.ts, and executing a binding (draft save and restore, submission,
 * actions, exec output, reload detection) in dispatch.ts. Both are free of
 * pi imports and are imported directly by the test suite; index.ts only
 * wires pi's ctx and pi.exec into them.
 *
 * With no leader-key.json the first leader press opens the setup wizard.
 * Nothing is written until the user confirms, and the package ships no
 * config file.
 *
 * /find-commands opens a picker over pi.getCommands() for command-binding
 * discovery; selection echoes the exact invokable string. It also hosts an
 * "Add binding" entry that opens the /leader-bind wizard.
 *
 * /leader-bind creates a binding interactively: pick a type (command,
 * action, exec), enter the value, choose a key sequence (with conflict
 * detection), confirm, and it's saved to the config and usable immediately
 * (the leader-key handler re-reads the config on every press).
 *
 * ## Config: ~/.pi/agent/leader-key.json
 *
 * {
 *   "leaderKey": "ctrl+space",
 *   "leaderTimeoutMs": 1000,
 *   "sequenceTimeoutMs": 400,
 *   "editorEffect": "grayedOut",
 *   "bindings": {
 *     "c":  { "action": "compact" },
 *     "q":  { "action": "shutdown" },
 *     "gs": { "exec": "git status" },
 *     "su": { "command": "/spin-up" },
 *     "m":  { "command": "/model" },
 *     "mo": { "command": "/model", "args": "opus" }
 *   }
 * }
 *
 * Legacy embedded args ({ "command": "/model opus" }) normalize
 * identically at load; new writes use the split form.
 *
 * ## editorEffect values
 *
 *   "grayedOut" — Gray the mounted editor (pi's own or a custom one) while
 *     leader mode is open (default). Falls back to the LEADER status line
 *     when no editor has focus.
 *   "none"      — LEADER status line only; the editor is left alone.
 *
 * ## Binding types
 *
 *   command — Submitted through the editor's submit path for full
 *     slash-command processing. Works for extension commands and
 *     built-in commands alike. Arguments go in the explicit `args`
 *     field and are composed as `command + " " + args`.
 *
 *   action — Calls a pi API directly.
 *     "compact"      — trigger conversation compaction
 *     "shutdown"     — graceful shutdown
 *     "clearEditor"  — clear the editor text
 *
 *   exec — Runs a shell command via bash -c. Output shown as a
 *     notification.
 */

import {
    DynamicBorder,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    matchesKey,
    Text,
    type KeyId,
} from "@earendil-works/pi-tui";
import {
    buildCommandMenu,
    CONFIG_PATH,
    focusedEditor,
    isMountedEditor,
    isPrintableKey,
    leaderIndicator,
    loadConfig,
    processKey,
    renderEditor,
    type LeaderConfig,
    type MountedEditor,
} from "./logic.ts";
import {
    dispatchBinding,
    isReloadBinding,
    leaderPressOutcome,
    type DispatchDeps,
} from "./dispatch.ts";
import {
    makeCommandPicker,
    runBindingWizard,
    runSetupWizard,
} from "./wizard.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clear an existing timer (if any) and start a new one. */
function resetTimer(
    timer: ReturnType<typeof setTimeout> | null,
    ms: number,
    fn: () => void,
): ReturnType<typeof setTimeout> {
    if (timer) clearTimeout(timer);
    return setTimeout(fn, ms);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    const { config } = loadConfig();

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /**
     * The editor pi has mounted, captured when the capture overlay opens
     * (that is when the TUI can still name it). Left null when focus is
     * not on an editor, in which case leader mode falls back to the
     * LEADER status line.
     */
    let activeEditor: MountedEditor | null = null;
    /** True while a leader press is in flight — pi fires shortcuts without awaiting. */
    let capturing = false;
    /** One warning per extension load: leader mode found no editor to gray. */
    let warnedNoEditor = false;

    /**
     * Surface config problems once per session rather than on every press:
     * an unusable `leaderKey` or an unparseable binding is a standing
     * problem, not a per-keystroke event.
     */
    function reportConfigProblems(ctx: ExtensionContext): void {
        const { error, dropped, reasons, notes } = loadConfig();
        if (error === "parse") {
            ctx.ui.notify(
                `Failed to parse ${CONFIG_PATH} — using defaults.`,
                "error",
            );
            return;
        }
        for (const note of notes) ctx.ui.notify(note, "warning");
        if (dropped.length > 0)
            ctx.ui.notify(
                `Ignored ${dropped.length} invalid binding(s): ${dropped
                    .map((k) => `"${k}" (${reasons[k] ?? "invalid"})`)
                    .join(", ")} — check leader-key.json.`,
                "warning",
            );
    }

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------

    pi.on("session_shutdown", () => {
        activeEditor = null;
    });

    pi.on("session_start", (_event, ctx) => {
        // A session switch can drop an in-flight capture overlay without
        // resolving it; reset so the leader key is live again afterwards.
        activeEditor = null;
        capturing = false;
        reportConfigProblems(ctx);
    });

    // ------------------------------------------------------------------
    // Capture overlay + effect renderer
    // ------------------------------------------------------------------

    async function runEffectCapture(
        ctx: ExtensionContext,
        current: LeaderConfig,
    ): Promise<string | null> {
        return ctx.ui.custom<string | null>(
            (tui, theme, _keybindings, done) => {
                // Whatever editor pi has mounted — its own or a custom one
                // from another extension — is still the focused component at
                // this point, and it stays mounted behind this overlay. Gray
                // it in place instead of swapping in a look-alike. Focus does
                // move to the overlay while it is up, so a text cursor
                // disappears for the duration; the editor's text, keys, and
                // undo history are untouched.
                const editor = focusedEditor(tui);
                activeEditor = editor;
                const indicator = leaderIndicator(
                    current.editorEffect,
                    editor !== null,
                );
                if (indicator.warnNoEditor && !warnedNoEditor) {
                    warnedNoEditor = true;
                    ctx.ui.notify(
                        "Leader mode found no editor to gray — falling back to the LEADER indicator.",
                        "warning",
                    );
                }
                if (indicator.status) {
                    ctx.ui.setStatus("leader", indicator.status);
                }
                // Hoisted: this is a per-frame call, and pi's editor renders
                // lazily, so the closure is reused rather than rebuilt.
                const mutedBorder = (s: string) => theme.fg("muted", s);

                let buffer = "";
                let leaderTimer: ReturnType<typeof setTimeout> | null = null;
                let sequenceTimer: ReturnType<typeof setTimeout> | null = null;

                const cleanup = () => {
                    if (leaderTimer) clearTimeout(leaderTimer);
                    if (sequenceTimer) clearTimeout(sequenceTimer);
                };

                const dismiss = () => {
                    cleanup();
                    done(null);
                };
                const fire = (key: string) => {
                    cleanup();
                    done(key);
                };

                leaderTimer = resetTimer(
                    leaderTimer,
                    current.leaderTimeoutMs,
                    dismiss,
                );

                return {
                    render(width: number): string[] {
                        // Frozen at open: the editor reference never changes
                        // under this overlay, so a session switch cannot leave
                        // a live read and a stale flag disagreeing.
                        if (!editor) return [""];
                        return renderEditor(editor, width, {
                            dim: indicator.dim,
                            borderColor: mutedBorder,
                        });
                    },
                    invalidate(): void {
                        editor?.invalidate?.();
                    },
                    // The host drops overlays on a session switch without
                    // resolving them, so the timers have to die here too.
                    dispose(): void {
                        buffer = "";
                        cleanup();
                    },

                    handleInput(data: string): void {
                        if (matchesKey(data, "escape")) {
                            dismiss();
                            return;
                        }
                        if (!isPrintableKey(data)) return;

                        leaderTimer = resetTimer(
                            leaderTimer,
                            current.leaderTimeoutMs,
                            dismiss,
                        );

                        buffer += data;

                        const result = processKey(buffer, current.bindings);
                        if (result.action === "fire") {
                            fire(result.key);
                        } else if (result.action === "wait") {
                            sequenceTimer = resetTimer(
                                sequenceTimer,
                                current.sequenceTimeoutMs,
                                result.exact ? () => fire(buffer) : dismiss,
                            );
                        } else {
                            dismiss();
                        }
                    },
                };
            },
        );
    }

    // ------------------------------------------------------------------
    // Dispatch wiring
    // ------------------------------------------------------------------

    /**
     * Hand pi's ctx and pi.exec to the extracted dispatch module. It only
     * executes a plan; deciding what a binding means is logic.ts's job, and
     * running it is dispatch.ts's — this is the seam between them.
     */
    function dispatchDeps(ctx: ExtensionContext): DispatchDeps {
        return {
            editor: activeEditor,
            notify: (message, kind) => ctx.ui.notify(message, kind),
            getEditorText: () => ctx.ui.getEditorText(),
            setEditorText: (text) => ctx.ui.setEditorText(text),
            compact: () =>
                ctx.compact({
                    onComplete: () =>
                        ctx.ui.notify("Compaction complete", "info"),
                    onError: (err: Error) =>
                        ctx.ui.notify(
                            `Compaction failed: ${err.message}`,
                            "error",
                        ),
                }),
            shutdown: () => ctx.shutdown(),
            exec: (cmd, timeoutMs) =>
                pi.exec("bash", ["-c", cmd], { timeout: timeoutMs }),
        };
    }

    // ------------------------------------------------------------------
    // /leader-bind — entry point
    // ------------------------------------------------------------------

    pi.registerCommand("leader-bind", {
        description: "Create a leader-key binding interactively",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/leader-bind needs a TUI session.", "warning");
                return;
            }
            await runBindingWizard(ctx, pi.getCommands());
        },
    });

    // ------------------------------------------------------------------
    // /find-commands — runtime command discovery
    // ------------------------------------------------------------------

    pi.registerCommand("find-commands", {
        description: "Browse every invokable command for leader-key bindings",
        handler: async (_args, ctx) => {
            const commands = pi.getCommands();
            if (commands.length === 0) {
                ctx.ui.notify("No commands available to bind.", "warning");
                return;
            }

            if (ctx.mode !== "tui") {
                ctx.ui.notify(
                    buildCommandMenu(commands)
                        .map(
                            (e) =>
                                `${e.label}${e.description ? ` — ${e.description}` : ""}`,
                        )
                        .join("\n"),
                    "info",
                );
                return;
            }

            const menu: Array<{
                value: string;
                label: string;
                description: string;
            }> = [
                {
                    value: "__add__",
                    label: "+ Add binding",
                    description: "open the binding wizard (/leader-bind)",
                },
                ...buildCommandMenu(commands),
            ];

            // pi's built-in extension selector renders every option with no
            // scrolling, so long lists push the cursor off screen — use the
            // documented ui.custom + SelectList pattern instead (windowed to 10).
            const picked = await ctx.ui.custom<string | null>(
                (tui, theme, _kb, done) => {
                    let query = "";
                    const picker = makeCommandPicker(theme, menu, {
                        getQuery: () => query,
                        setQuery: (q) => {
                            query = q;
                        },
                        onPick: (value) => done(value),
                        onCancel: () => done(null),
                    });

                    const container = new Container();
                    container.addChild(
                        new DynamicBorder((s) => theme.fg("accent", s)),
                    );
                    container.addChild(
                        new Text(
                            theme.fg("accent", theme.bold("Command to bind")),
                            1,
                            0,
                        ),
                    );
                    container.addChild(picker);
                    container.addChild(
                        new Text(
                            theme.fg(
                                "dim",
                                "type to filter • ↑↓ navigate • tab fill • enter insert • esc cancel",
                            ),
                            1,
                            0,
                        ),
                    );
                    container.addChild(
                        new DynamicBorder((s) => theme.fg("accent", s)),
                    );

                    return {
                        render: (w) => container.render(w),
                        invalidate: () => container.invalidate(),
                        handleInput: (data) => {
                            picker.handleInput(data);
                            tui.requestRender();
                        },
                    };
                },
            );

            if (picked == null) return;
            if (picked === "__add__") {
                await runBindingWizard(ctx, commands);
                return;
            }
            const entry = menu.find((e) => e.value === picked);
            // Put the command in the editor instead of echoing it: the
            // caller is standing at the prompt about to type it, and pi's
            // own autocomplete completes into the editor the same way.
            // Only when the editor is empty or already holds a command —
            // appending to unrelated text would produce a line pi cannot
            // run.
            const editor = ctx.ui.getEditorComponent?.();
            if (editor && isMountedEditor(editor)) {
                const draft = editor.getText().trim();
                if (draft === "" || draft.startsWith("/")) {
                    editor.setText(`${draft}${draft ? " " : ""}/${picked} `);
                    return;
                }
            }
            ctx.ui.notify(
                `/${picked}${entry?.description ? ` — ${entry.description}` : ""}`,
                "info",
            );
        },
    });

    // ------------------------------------------------------------------
    // Shortcut
    // ------------------------------------------------------------------

    pi.registerShortcut(config.leaderKey as KeyId, {
        description: "Leader key",
        handler: async (ctx) => {
            if (ctx.mode !== "tui") return;
            // pi fires shortcuts without awaiting the handler and swaps the
            // editor in a microtask, so two leader presses in one stdin
            // chunk would otherwise start two overlapping overlays.
            if (capturing) return;

            capturing = true;
            try {
                const loaded = loadConfig();
                // Deciding what a press does with a missing, broken, or
                // merely empty config lives in dispatch.ts, so the rules
                // are testable without a TUI. `config` is what pi
                // registered the shortcut with, so it is the key the user
                // can actually press right now.
                const outcome = leaderPressOutcome(loaded);
                if (outcome.kind === "wizard") {
                    await runSetupWizard(ctx, config.leaderKey);
                    return;
                }
                if (outcome.kind === "warn") {
                    ctx.ui.notify(outcome.message, "warning");
                    return;
                }
                const current = loaded.config;

                // The overlay captures the mounted editor and renders it
                // grayed; when there is no editor to gray it puts up the
                // LEADER status line itself.

                // Declared out here so the finally below can tell whether the dispatch
                // that ran was a reload.
                let result: string | null = null;
                try {
                    result = await runEffectCapture(ctx, current);
                    if (typeof result === "string")
                        await dispatchBinding(
                            dispatchDeps(ctx),
                            result,
                            current.bindings[result],
                        );
                } finally {
                    // Drop the editor reference and the indicator: the next
                    // press recaptures both, and a throw in the overlay or
                    // the dispatch must not leave LEADER on screen.
                    activeEditor = null;
                    // Dispatching `r` → `/reload` invalidates `ctx` — pi's
                    // runner warns: "This extension ctx is stale after
                    // session replacement or reload. Do not use a captured
                    // pi or command ctx after ctx.reload()." The whole UI is
                    // being torn down as it goes, so there is nothing to
                    // clear, and touching `ctx` here would only raise an
                    // error toast over the reload it was clearing for.
                    const reloading = isReloadBinding(
                        typeof result === "string"
                            ? current.bindings[result]
                            : undefined,
                    );
                    if (!reloading) ctx.ui.setStatus("leader", undefined);
                }
            } finally {
                capturing = false;
            }
        },
    });
}

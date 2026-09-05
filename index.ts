/**
 * Leader Key Extension — vim-style leader key shortcuts for pi.
 *
 * Reads bindings from ~/.pi/agent/leader-key.json and activates them when
 * you press the configured leader key. An invisible overlay captures
 * keystrokes and matches them against configured bindings. Command bindings
 * are routed through the editor's onSubmit pipeline for full slash-command
 * processing.
 *
 * Pure logic (config loading, key matching, command-menu building) lives in
 * logic.ts, which the test suite imports directly.
 *
 * On first startup (no leader-key.json), a blank default config is written
 * to ~/.pi/agent/leader-key.json — outside the package dir, so it survives
 * updates. The package itself ships no config file.
 *
 * /leader-commands opens a picker over pi.getCommands() for command-binding
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
 *   "leaderTimeoutMs": 3600,
 *   "sequenceTimeoutMs": 750,
 *   "editorEffect": "grayedOut",
 *   "bindings": {
 *     "c":  { "action": "compact" },
 *     "q":  { "action": "shutdown" },
 *     "gs": { "exec": "git status" },
 *     "su": { "command": "/spin-up" },
 *     "m":  { "command": "/model" }
 *   }
 * }
 *
 * ## editorEffect values
 *
 *   "grayedOut" — Dim the entire editor via ANSI faint (default)
 *   "none"      — No visual indicator; fallback LEADER status
 *
 * ## Binding types
 *
 *   command — Routes through the editor's onSubmit pipeline for full
 *     slash-command processing. Works for extension commands and
 *     built-in commands alike.
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
    CustomEditor,
    DynamicBorder,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import {
    buildCommandMenu,
    CONFIG_PATH,
    ensureConfig,
    isPrintableKey,
    loadConfig,
    processKey,
    type EditorEffect,
    type LeaderConfig,
} from "./logic.ts";
import { makeCommandPicker, runBindingWizard } from "./wizard.ts";

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
    // First run in this install: write a blank config to edit. Guarded —
    // never overwrites an existing file; failure falls back to defaults.
    ensureConfig();

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    let activeTui: TUI | undefined;
    let leaderEditor: CustomEditor | null = null;
    let activeEffect: EditorEffect | null = null;

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------

    pi.on("session_shutdown", () => {
        activeEffect = null;
        activeTui = undefined;
        leaderEditor = null;
    });

    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            activeTui = tui;
            leaderEditor = new CustomEditor(tui, theme, keybindings);
            return leaderEditor;
        });
    });

    // ------------------------------------------------------------------
    // Capture overlay + effect renderer
    // ------------------------------------------------------------------

    async function runEffectCapture(
        ctx: ExtensionContext,
        current: LeaderConfig,
    ): Promise<string | null> {
        return ctx.ui.custom<string | null>(
            (_tui, theme, _keybindings, done) => {
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
                        if (!leaderEditor) return [""];
                        if (activeEffect === "grayedOut") {
                            const saved = leaderEditor.borderColor;
                            try {
                                leaderEditor.borderColor = (s: string) =>
                                    theme.fg("muted", s);
                                return leaderEditor
                                    .render(width)
                                    .map((line) => `\x1b[90m${line}\x1b[0m`);
                            } finally {
                                leaderEditor.borderColor = saved;
                            }
                        }
                        return leaderEditor.render(width);
                    },
                    invalidate(): void {
                        leaderEditor?.invalidate();
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
    // Dispatch helper
    // ------------------------------------------------------------------

    async function dispatchBinding(
        ctx: ExtensionContext,
        current: LeaderConfig,
        key: string,
    ): Promise<void> {
        const binding = current.bindings[key];
        if (!binding) return;

        if ("command" in binding) {
            leaderEditor?.setText(binding.command);
            await leaderEditor?.onSubmit?.(binding.command);
            ctx.ui.setEditorText("");
            return;
        }

        if ("action" in binding) {
            switch (binding.action) {
                case "compact":
                    ctx.compact({
                        onComplete: () =>
                            ctx.ui.notify("Compaction complete", "info"),
                        onError: (err: Error) =>
                            ctx.ui.notify(
                                `Compaction failed: ${err.message}`,
                                "error",
                            ),
                    });
                    break;
                case "shutdown":
                    ctx.shutdown();
                    break;
                case "clearEditor":
                    ctx.ui.setEditorText("");
                    break;
            }
        } else if ("exec" in binding) {
            const r = await pi.exec("bash", ["-c", binding.exec], {
                timeout: 15000,
            });
            // Cap what reaches the TUI — `cat huge.log` shouldn't flood it.
            const cap = (s: string) =>
                s.length > 2000 ? `${s.slice(0, 2000)}\n…[truncated]` : s;
            ctx.ui.notify(
                r.code !== 0 && r.stderr
                    ? `[exit ${r.code}] ${cap(r.stderr.trim())}`
                    : cap(r.stdout.trim()) || `[exit ${r.code}]`,
                "info",
            );
        }
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
    // /leader-commands — runtime command discovery
    // ------------------------------------------------------------------

    pi.registerCommand("leader-commands", {
        description: "Browse every invokable command for leader-key bindings",
        handler: async (_args, ctx) => {
            const commands = pi.getCommands();
            if (commands.length === 0) {
                ctx.ui.notify("No commands available to bind.", "warning");
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

            if (ctx.mode !== "tui") {
                ctx.ui.notify(
                    menu
                        .map(
                            (e) =>
                                `${e.label}${e.description ? ` — ${e.description}` : ""}`,
                        )
                        .join("\n"),
                    "info",
                );
                return;
            }

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
                                "type to filter • ↑↓ navigate • enter select • esc cancel",
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
            ctx.ui.notify(
                `/${picked}${entry?.description ? ` — ${entry.description}` : ""}`,
                "info",
            );
        },
    });

    // ------------------------------------------------------------------
    // Shortcut
    // ------------------------------------------------------------------

    pi.registerShortcut(config.leaderKey, {
        description: "Leader key",
        handler: async (ctx) => {
            if (ctx.mode !== "tui") return;

            const { config: current, error } = loadConfig();
            if (error === "parse") {
                ctx.ui.notify(
                    `Failed to parse ${CONFIG_PATH} — using defaults.`,
                    "error",
                );
            }
            if (Object.keys(current.bindings).length === 0) {
                ctx.ui.notify("No leader bindings configured.", "warning");
                return;
            }

            const effect = current.editorEffect;

            // ---- Activate visual indicator ----
            if (effect === "none") {
                ctx.ui.setStatus("leader", "LEADER");
            } else {
                activeEffect = "grayedOut";
                activeTui?.requestRender();
            }

            // ---- Capture overlay ----
            const result = await runEffectCapture(ctx, current);

            // ---- Clean up visual indicator ----
            if (effect !== "none") {
                activeEffect = null;
                activeTui?.requestRender();
            }
            ctx.ui.setStatus("leader", undefined);

            if (typeof result !== "string") return;
            await dispatchBinding(ctx, current, result);
        },
    });
}

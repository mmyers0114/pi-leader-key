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
import {
    Container,
    Editor,
    fuzzyFilter,
    Key,
    matchesKey,
    SelectList,
    Text,
    type EditorTheme,
} from "@earendil-works/pi-tui";
import {
    buildCommandMenu,
    CONFIG_PATH,
    ensureConfig,
    findConflicts,
    isPrintableKey,
    loadConfig,
    processKey,
    saveBinding,
    validateSequence,
    type BindingAction,
    type CommandMenuEntry,
    type EditorEffect,
    type LeaderConfig,
    type PiCommand,
} from "./logic.ts";

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
            ctx.ui.notify(
                r.code !== 0 && r.stderr
                    ? `[exit ${r.code}] ${r.stderr.trim()}`
                    : r.stdout.trim() || `[exit ${r.code}]`,
                "info",
            );
        }
    }

    // ------------------------------------------------------------------
    // /leader-bind — interactive binding wizard
    // ------------------------------------------------------------------

    /** SelectList theme shared by every picker in the extension. */
    function selectListTheme(
        theme: ReturnType<ExtensionContext["ui"]["getTheme"]>,
    ) {
        return {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
        };
    }

    interface SelectItem {
        value: string;
        label: string;
        description?: string;
    }

    function makeSelectList(
        theme: ReturnType<ExtensionContext["ui"]["getTheme"]>,
        items: SelectItem[],
        onSelect: (value: string) => void,
        onCancel: () => void,
    ): SelectList {
        const list = new SelectList(
            items,
            Math.min(items.length, 10),
            selectListTheme(theme),
        );
        list.onSelect = (item) => onSelect(item.value);
        list.onCancel = onCancel;
        return list;
    }

    function makeEditor(
        tui: TUI,
        theme: ReturnType<ExtensionContext["ui"]["getTheme"]>,
    ): Editor {
        const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: selectListTheme(theme),
        };
        return new Editor(tui, editorTheme);
    }

    /**
     * Fuzzy-filtered command picker: query line + SelectList over `menu`.
     * Shared by /leader-commands (enter on a selection = pick) and the
     * wizard's command step (enter = fill query; the caller confirms when
     * the query starts with "/"). Query state lives in the caller.
     */
    function makeCommandPicker(
        theme: ReturnType<ExtensionContext["ui"]["getTheme"]>,
        menu: CommandMenuEntry[],
        opts: {
            getQuery: () => string;
            setQuery: (q: string) => void;
            onPick: (value: string) => void;
            onCancel: () => void;
        },
    ) {
        const queryText = new Text("", 1, 0);
        const listContainer = new Container();
        const container = new Container();
        container.addChild(queryText);
        container.addChild(listContainer);

        let list: SelectList;
        const rebuild = () => {
            const q = opts.getQuery();
            queryText.setText(theme.fg("accent", `> ${q}▏`));
            const filtered = q.trim()
                ? fuzzyFilter(menu, q, (e) => `${e.label} ${e.description}`)
                : menu;
            list = makeSelectList(theme, filtered, opts.onPick, opts.onCancel);
            listContainer.clear();
            listContainer.addChild(list);
        };
        rebuild();

        return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
                if (matchesKey(data, "escape")) {
                    opts.onCancel();
                    return;
                }
                if (data === "\x7f") {
                    opts.setQuery(opts.getQuery().slice(0, -1));
                    rebuild();
                } else if (isPrintableKey(data)) {
                    opts.setQuery(opts.getQuery() + data);
                    rebuild();
                } else {
                    // Arrows etc. go to the live list; no rebuild, so the
                    // selection survives the keystroke.
                    list.handleInput(data);
                }
            },
        };
    }

    /**
     * Run the create-binding wizard in a single overlay. Steps: type →
     * value → sequence → (conflict confirm) → summary + save. Escape walks
     * back a step; nothing is written until the final save. Returns true
     * when a binding was saved.
     */
    async function runBindingWizard(ctx: ExtensionContext): Promise<boolean> {
        const commands: PiCommand[] = pi.getCommands();
        const menu: CommandMenuEntry[] = buildCommandMenu(commands);

        return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
            type Step =
                | "type"
                | "command"
                | "action"
                | "exec"
                | "sequence"
                | "conflict"
                | "confirm";

            let step: Step = "type";
            let bindingType: "command" | "action" | "exec" | null = null;
            let commandValue = "/";
            let execValue = "";
            let sequence = "";
            let status = "";

            const editor = makeEditor(tui, theme);
            editor.onSubmit = (value) => {
                if (step === "exec") {
                    execValue = value.trim();
                    if (!execValue) {
                        status = "enter a shell command";
                        refresh();
                        return;
                    }
                    goSequence();
                } else if (step === "sequence") {
                    const err = validateSequence(value);
                    if (err) {
                        status =
                            err === "empty"
                                ? "sequence cannot be empty"
                                : err === "whitespace"
                                  ? "no spaces in a sequence"
                                  : "printable ASCII keys only";
                        refresh();
                        return;
                    }
                    sequence = value.trim();
                    const conflicts = findConflicts(
                        currentBindings(),
                        sequence,
                    );
                    step = conflicts.length > 0 ? "conflict" : "confirm";
                    status = "";
                    refresh();
                }
            };

            const currentBindings = () => loadConfig().config.bindings;

            const back = () => {
                status = "";
                if (step === "command" || step === "action" || step === "exec")
                    step = "type";
                else if (step === "sequence") step = valueStep();
                else if (step === "conflict" || step === "confirm")
                    step = "sequence";
                refresh();
            };

            const valueStep = (): Step =>
                bindingType === "command"
                    ? "command"
                    : bindingType === "action"
                      ? "action"
                      : "exec";

            const goSequence = () => {
                step = "sequence";
                status = "";
                editor.setText("");
                refresh();
            };

            const save = () => {
                if (!bindingType || !sequence) return;
                const binding: BindingAction =
                    bindingType === "command"
                        ? { command: commandValue.trim() }
                        : bindingType === "action"
                          ? { action: chosenAction }
                          : { exec: execValue };
                const result = saveBinding(sequence, binding);
                if (result.ok) {
                    ctx.ui.notify(
                        `Bound: ${sequence} → ${describeBinding(binding)}`,
                        "info",
                    );
                    done(true);
                } else {
                    status = result.error;
                    refresh();
                }
            };

            let chosenAction: "compact" | "shutdown" | "clearEditor" =
                "compact";

            const describeBinding = (b: BindingAction): string =>
                "command" in b
                    ? b.command
                    : "exec" in b
                      ? `!${b.exec}`
                      : `action: ${b.action}`;

            const summaryLines = (): string[] => {
                if (!bindingType) return [];
                const binding: BindingAction =
                    bindingType === "command"
                        ? { command: commandValue.trim() }
                        : bindingType === "action"
                          ? { action: chosenAction }
                          : { exec: execValue };
                return [
                    theme.fg(
                        "text",
                        `  ${sequence} → ${describeBinding(binding)}`,
                    ),
                    "",
                ];
            };

            const conflictLines = (): string[] => {
                const bindings = currentBindings();
                const lines = [
                    theme.fg(
                        "warning",
                        "  Conflicts with existing binding(s):",
                    ),
                    "",
                ];
                for (const key of findConflicts(bindings, sequence)) {
                    lines.push(
                        `    ${key} → ${describeBinding(bindings[key]!)}`,
                    );
                }
                lines.push("");
                return lines;
            };

            // ---- Command picker state (command step) ----
            let query = "";
            let list: SelectList | null = null;
            let picker: ReturnType<typeof makeCommandPicker> | null = null;

            const container = new Container();

            function refresh() {
                container.clear();
                container.addChild(
                    new DynamicBorder((s) => theme.fg("accent", s)),
                );

                const titles: Record<Step, string> = {
                    type: "New leader binding — what kind?",
                    command: "New leader binding — which command?",
                    action: "New leader binding — which action?",
                    exec: "New leader binding — shell command",
                    sequence: "New leader binding — key sequence",
                    conflict: "New leader binding — conflict",
                    confirm: "New leader binding — confirm",
                };
                container.addChild(
                    new Text(
                        theme.fg("accent", theme.bold(titles[step])),
                        1,
                        0,
                    ),
                );

                if (status) {
                    container.addChild(
                        new Text(theme.fg("warning", `  ${status}`), 0, 0),
                    );
                }

                let hint = "";
                list = null;

                if (step === "type") {
                    list = makeSelectList(
                        theme,
                        [
                            {
                                value: "command",
                                label: "command",
                                description: "slash command",
                            },
                            {
                                value: "action",
                                label: "action",
                                description: "compact, shutdown, clearEditor",
                            },
                            {
                                value: "exec",
                                label: "exec",
                                description: "shell one-liner",
                            },
                        ],
                        (value) => {
                            bindingType = value as
                                | "command"
                                | "action"
                                | "exec";
                            status = "";
                            if (bindingType === "command") {
                                step = "command";
                                query = "";
                            } else if (bindingType === "action") {
                                step = "action";
                            } else {
                                step = "exec";
                                editor.setText("");
                            }
                            refresh();
                        },
                        () => done(false),
                    );
                    hint = "↑↓ navigate • enter select • esc cancel";
                } else if (step === "action") {
                    list = makeSelectList(
                        theme,
                        [
                            {
                                value: "compact",
                                label: "compact",
                                description: "trigger conversation compaction",
                            },
                            {
                                value: "shutdown",
                                label: "shutdown",
                                description: "graceful shutdown",
                            },
                            {
                                value: "clearEditor",
                                label: "clearEditor",
                                description: "clear the editor text",
                            },
                        ],
                        (value) => {
                            chosenAction = value as
                                | "compact"
                                | "shutdown"
                                | "clearEditor";
                            goSequence();
                        },
                        back,
                    );
                    hint = "↑↓ navigate • enter select • esc back";
                } else if (step === "conflict") {
                    for (const line of conflictLines())
                        container.addChild(new Text(line, 0, 0));
                    list = makeSelectList(
                        theme,
                        [
                            {
                                value: "overwrite",
                                label: "overwrite",
                                description: "replace the existing binding(s)",
                            },
                            {
                                value: "back",
                                label: "back",
                                description: "pick another sequence",
                            },
                        ],
                        (value) => {
                            if (value === "overwrite") {
                                step = "confirm";
                                refresh();
                            } else {
                                back();
                            }
                        },
                        back,
                    );
                    hint = "↑↓ navigate • enter select • esc back";
                } else if (step === "confirm") {
                    for (const line of summaryLines())
                        container.addChild(new Text(line, 0, 0));
                    list = makeSelectList(
                        theme,
                        [
                            {
                                value: "save",
                                label: "save",
                                description:
                                    "write to ~/.pi/agent/leader-key.json",
                            },
                            {
                                value: "back",
                                label: "back",
                                description: "edit the sequence",
                            },
                        ],
                        (value) => {
                            if (value === "save") save();
                            else back();
                        },
                        back,
                    );
                    hint = "↑↓ navigate • enter select • esc back";
                } else if (step === "sequence") {
                    container.addChild(
                        new Text(
                            theme.fg(
                                "dim",
                                "  e.g. gs, c, ox — printable keys, no spaces",
                            ),
                            0,
                            0,
                        ),
                    );
                    container.addChild(editor);
                    hint = "enter confirm • esc back";
                } else if (step === "exec") {
                    container.addChild(
                        new Text(
                            theme.fg(
                                "dim",
                                "  run via bash -c, e.g. git status",
                            ),
                            0,
                            0,
                        ),
                    );
                    container.addChild(editor);
                    hint = "enter confirm • esc back";
                } else if (step === "command") {
                    picker = makeCommandPicker(theme, menu, {
                        getQuery: () => query,
                        setQuery: (q) => {
                            query = q;
                        },
                        onPick: (value) => {
                            query = `/${value}`;
                            refresh();
                        },
                        onCancel: back,
                    });
                    container.addChild(picker);
                    hint =
                        "enter fill command • enter again (add args first if you like) to confirm • esc back";
                }

                if (list) container.addChild(list);
                container.addChild(
                    new Text(theme.fg("dim", `  ${hint}`), 1, 0),
                );
                container.addChild(
                    new DynamicBorder((s) => theme.fg("accent", s)),
                );
                tui.requestRender();
            }

            refresh();

            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    if (matchesKey(data, "escape")) {
                        if (step === "type") done(false);
                        else back();
                        return;
                    }
                    if (step === "command") {
                        if (
                            matchesKey(data, Key.enter) &&
                            query.startsWith("/")
                        ) {
                            commandValue = query.trim();
                            goSequence();
                            return;
                        }
                        picker?.handleInput(data);
                        tui.requestRender();
                        return;
                    }
                    if (step === "exec" || step === "sequence") {
                        editor.handleInput(data);
                        tui.requestRender();
                        return;
                    }
                    list?.handleInput(data);
                    tui.requestRender();
                },
            };
        });
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
            await runBindingWizard(ctx);
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
                await runBindingWizard(ctx);
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

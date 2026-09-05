// wizard.ts — /leader-bind interactive binding wizard and the shared
// fuzzy-filter command picker. UI only; pure logic lives in logic.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
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
    findConflicts,
    isPrintableKey,
    loadConfig,
    saveBinding,
    validateSequence,
    type BindingAction,
    type CommandMenuEntry,
    type PiCommand,
} from "./logic.ts";

// ---------------------------------------------------------------------------
// Shared picker helpers
// ---------------------------------------------------------------------------

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
export function makeCommandPicker(
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
export async function runBindingWizard(
    ctx: ExtensionContext,
    commands: PiCommand[],
): Promise<boolean> {
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
                    if (err === "empty") status = "sequence cannot be empty";
                    else if (err === "whitespace")
                        status = "no spaces in a sequence";
                    else status = "printable ASCII keys only";
                    refresh();
                    return;
                }
                sequence = value.trim();
                const conflicts = findConflicts(currentBindings(), sequence);
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

        const valueStep = (): Step => {
            if (bindingType === "command") return "command";
            return bindingType === "action" ? "action" : "exec";
        };

        const goSequence = () => {
            step = "sequence";
            status = "";
            editor.setText("");
            refresh();
        };

        const makeBinding = (): BindingAction => {
            if (bindingType === "command")
                return { command: commandValue.trim() };
            if (bindingType === "action") return { action: chosenAction };
            return { exec: execValue };
        };

        const save = () => {
            if (!bindingType || !sequence) return;
            const binding = makeBinding();
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

        let chosenAction: "compact" | "shutdown" | "clearEditor" = "compact";

        const describeBinding = (b: BindingAction): string => {
            if ("command" in b) return b.command;
            if ("exec" in b) return `!${b.exec}`;
            return `action: ${b.action}`;
        };

        const summaryLines = (): string[] => {
            if (!bindingType) return [];
            const binding = makeBinding();
            return [
                theme.fg("text", `  ${sequence} → ${describeBinding(binding)}`),
                "",
            ];
        };

        const conflictLines = (): string[] => {
            const bindings = currentBindings();
            const lines = [
                theme.fg("warning", "  Conflicts with existing binding(s):"),
                "",
            ];
            for (const key of findConflicts(bindings, sequence)) {
                lines.push(`    ${key} → ${describeBinding(bindings[key]!)}`);
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
            container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

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
                new Text(theme.fg("accent", theme.bold(titles[step])), 1, 0),
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
                        bindingType = value as "command" | "action" | "exec";
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
                            description: "write to ~/.pi/agent/leader-key.json",
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
                        theme.fg("dim", "  run via bash -c, e.g. git status"),
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
            container.addChild(new Text(theme.fg("dim", `  ${hint}`), 1, 0));
            container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
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
                        query.trim().length > 1
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

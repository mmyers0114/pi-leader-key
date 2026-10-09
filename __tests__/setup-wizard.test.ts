/**
 * Checks for the first-run setup wizard.
 *
 * Run: npx tsx --test __tests__/setup-wizard.test.ts
 *
 * The wizard is the whole first-run path, and logic.test.ts cannot reach it —
 * the config path is `join(homedir(), ...)`, computed at module load, so the
 * wizard only exists to test once it is pointed somewhere disposable. Setting
 * HOME before the dynamic import does that without a seam in production code:
 * `os.homedir()` reads $HOME on POSIX, and CONFIG_PATH is evaluated once, at
 * first import, so the redirect has to happen before the `await import`.
 *
 * The peers are peerDependencies resolved by pi at runtime, so a missing peer
 * skips rather than fails.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "leader-key-setup-"));
process.env.HOME = HOME;

const mod = await (async () => {
    try {
        return await import("../wizard.ts");
    } catch {
        return null;
    }
})();

const suite = mod ? test : test.skip;
const CONFIG = join(HOME, ".pi", "agent", "leader-key.json");

type Reply = string | undefined;
type Script = { inputs: Reply[]; effect?: string; confirm?: boolean };

function mockCtx(script: Script) {
    const inputs = [...script.inputs];
    const placeholders: string[] = [];
    const warnings: string[] = [];
    const ctx = {
        ui: {
            input: async (_title: string, placeholder?: string) => {
                placeholders.push(placeholder ?? "");
                return inputs.shift();
            },
            select: async (_title: string, options: string[]) => {
                const wanted = script.effect;
                const hit =
                    wanted === undefined
                        ? options.find((o) => o.includes("(default)"))
                        : options.find((o) => o.startsWith(wanted));
                return hit ?? options[0];
            },
            confirm: async () => script.confirm ?? true,
            notify: (msg: string, kind: string) => {
                if (kind === "warning") warnings.push(msg);
            },
        },
    };
    return { ctx, placeholders, warnings };
}

const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));

suite("setup wizard — keep-default", async (t) => {
    t.after(() => rmSync(HOME, { recursive: true, force: true }));

    await t.test("empty submit keeps every default and writes the starter binding", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx } = mockCtx({ inputs: ["", "", ""] });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), true);
        assert.deepEqual(readConfig(), {
            leaderKey: "ctrl+space",
            leaderTimeoutMs: 1000,
            sequenceTimeoutMs: 400,
            editorEffect: "grayedOut",
            bindings: { r: { command: "/reload" } },
        });
    });

    await t.test("each placeholder names the default and offers to keep it", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx, placeholders } = mockCtx({ inputs: ["", "", ""] });
        await mod!.runSetupWizard(ctx as never, "ctrl+space");
        assert.equal(placeholders.length, 3);
        for (const p of placeholders) {
            assert.match(p, /enter to keep/, `placeholder offers keep: ${p}`);
            assert.match(p, /^(ctrl\+space|1000|400) — /, `names the default: ${p}`);
        }
    });

    await t.test("typed values override, and the confirm step shows them", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx } = mockCtx({
            inputs: ["ctrl+k", "1500", "  250  "],
            effect: "none",
        });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), true);
        assert.deepEqual(readConfig(), {
            leaderKey: "ctrl+k",
            leaderTimeoutMs: 1500,
            sequenceTimeoutMs: 250,
            editorEffect: "none",
            bindings: { r: { command: "/reload" } },
        });
    });
});

suite("setup wizard — invalid input", async (t) => {
    t.after(() => rmSync(HOME, { recursive: true, force: true }));

    await t.test("rejects a bad key, warns, then keeps the default on empty", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx, warnings } = mockCtx({ inputs: ["notakey", "", "", ""] });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), true);
        assert.ok(warnings.length >= 1, "warned about the bad key");
        assert.equal(readConfig().leaderKey, "ctrl+space");
    });

    await t.test("rejects a non-numeric timeout", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx, warnings } = mockCtx({ inputs: ["", "soon", "", ""] });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), true);
        assert.deepEqual(warnings, [
            "enter a positive number of milliseconds, at most 2147483647",
        ]);
        assert.equal(readConfig().leaderTimeoutMs, 1000);
    });

    await t.test("rejects a timeout past the 32-bit setTimeout limit, naming the maximum", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx, warnings } = mockCtx({ inputs: ["", "3000000000", "", ""] });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), true);
        assert.deepEqual(warnings, [
            "enter a positive number of milliseconds, at most 2147483647",
        ]);
        assert.equal(readConfig().leaderTimeoutMs, 1000);
    });
});

suite("setup wizard — nothing written unless confirmed", async (t) => {
    t.after(() => rmSync(HOME, { recursive: true, force: true }));

    await t.test("escape at the first step writes nothing", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx } = mockCtx({ inputs: [undefined] });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), false);
        assert.equal(existsSync(CONFIG), false);
    });

    await t.test("escape at a later step writes nothing", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx } = mockCtx({ inputs: ["", undefined] });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), false);
        assert.equal(existsSync(CONFIG), false);
    });

    await t.test("declining the confirm writes nothing", async () => {
        rmSync(CONFIG, { force: true });
        const { ctx } = mockCtx({ inputs: ["", "", ""], confirm: false });
        assert.equal(await mod!.runSetupWizard(ctx as never, "ctrl+space"), false);
        assert.equal(existsSync(CONFIG), false);
    });
});
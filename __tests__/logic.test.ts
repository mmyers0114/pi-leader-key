/**
 * Tests for the leader-key extension's pure logic.
 *
 * Run: npx tsx __tests__/logic.test.ts
 *   or: node --import tsx __tests__/logic.test.ts
 *
 * Imports the real implementation from logic.ts (kept pi-import-free
 * so it loads standalone under tsx) — no mirrored copies.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  buildCommandMenu,
  defaultConfigJson,
  ensureConfig,
  isProperPrefix,
  isPrintableKey,
  loadConfig,
  processKey,
  type BindingAction,
  type LeaderConfig,
  findConflicts,
  mergeBinding,
  saveBinding,
  validateSequence,
  type PiCommand,
} from "../logic.ts";

// Isolated temp config dir — the suite never touches the user's real config.
// Unique per process: recursive mkdirSync returns undefined for pre-existing
// dirs, so reusing a name would crash line 39 on the second run.
const CONFIG_DIR = join(tmpdir(), `leader-key-test-${process.pid}`);
mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_PATH = join(CONFIG_DIR, "leader-key.json");

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

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

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// isPrintableKey
// ---------------------------------------------------------------------------

section("isPrintableKey");

// Printable ASCII
assert(isPrintableKey("a"), "lowercase a");
assert(isPrintableKey("z"), "lowercase z");
assert(isPrintableKey("A"), "uppercase A");
assert(isPrintableKey("Z"), "uppercase Z");
assert(isPrintableKey("0"), "digit 0");
assert(isPrintableKey("9"), "digit 9");
assert(isPrintableKey(" "), "space");
assert(isPrintableKey("!"), "exclamation");
assert(isPrintableKey("~"), "tilde");
assert(isPrintableKey("."), "dot");
assert(isPrintableKey("-"), "dash");
assert(isPrintableKey("_"), "underscore");

// Non-printable
assert(!isPrintableKey("\x1b"), "escape char");
assert(!isPrintableKey("\x01"), "ctrl-a");
assert(!isPrintableKey("\x7f"), "DEL");
assert(!isPrintableKey("\t"), "tab");
assert(!isPrintableKey("\n"), "newline");
assert(!isPrintableKey("\r"), "carriage return");

// Multi-byte / special
assert(!isPrintableKey("\x1b[A"), "up arrow escape sequence");
assert(!isPrintableKey("ab"), "two chars");
assert(!isPrintableKey(""), "empty string");

// Unicode letters (multi-byte UTF-8) — note: restricted to ASCII 32-126
assert(!isPrintableKey("é"), "e-acute is outside ASCII range");

// ---------------------------------------------------------------------------
// isPrefix
// ---------------------------------------------------------------------------

section("isProperPrefix");

assert(isProperPrefix("g", "gs"), "'g' is proper prefix of 'gs'");
assert(isProperPrefix("g", "gd"), "'g' is proper prefix of 'gd'");
assert(isProperPrefix("ga", "gab"), "'ga' is proper prefix of 'gab'");
assert(isProperPrefix("foo", "foobar"), "'foo' is proper prefix of 'foobar'");

assert(!isProperPrefix("g", "g"), "identical strings => not a proper prefix");
assert(!isProperPrefix("gs", "g"), "longer is not prefix of shorter");
assert(!isProperPrefix("a", "b"), "unrelated strings");
assert(!isProperPrefix("ga", "gb"), "partial match but not prefix");
assert(!isProperPrefix("", "a"), "empty string is not a prefix");

// ---------------------------------------------------------------------------
// processKey — the 4 cases
// ---------------------------------------------------------------------------

section("processKey — unique exact match => fire immediately");

{
  const bindings = {
    w: { command: "/model" },
    q: { action: "shutdown" },
    n: { exec: "true" },
  };
  assertEq(
    processKey("w", bindings),
    { action: "fire", key: "w" },
    "single key 'w'",
  );
  assertEq(
    processKey("q", bindings),
    { action: "fire", key: "q" },
    "single key 'q'",
  );
  assertEq(
    processKey("n", bindings),
    { action: "fire", key: "n" },
    "single key 'n'",
  );
}

section("processKey — exact match that is also a prefix => wait, exact");

{
  const bindings = {
    g: { command: "/git" },
    gs: { exec: "git status" },
    gd: { exec: "git diff" },
  };
  assertEq(
    processKey("g", bindings),
    { action: "wait", exact: true },
    "'g' matches but 'gs'/'gd' exist",
  );
}

{
  const bindings = { f: { command: "/fork" }, foo: { command: "/fork:all" } };
  assertEq(
    processKey("f", bindings),
    { action: "wait", exact: true },
    "'f' matches but 'foo' exists",
  );
}

section("processKey — partial match only (prefix, not exact) => wait");

{
  const bindings = { gs: { exec: "git status" }, gd: { exec: "git diff" } }; // no "g" by itself
  assertEq(
    processKey("g", bindings),
    { action: "wait", exact: false },
    "'g' is prefix of 'gs'/'gd', no exact 'g'",
  );
}

{
  const bindings = { abc: { command: "/abc" }, abd: { command: "/abd" } };
  assertEq(
    processKey("a", bindings),
    { action: "wait", exact: false },
    "'a' is prefix of 'abc'/'abd'",
  );
  assertEq(
    processKey("ab", bindings),
    { action: "wait", exact: false },
    "'ab' is prefix of 'abc'/'abd'",
  );
}

section("processKey — dead end => dismiss");

{
  const bindings = { w: { command: "/model" }, q: { action: "shutdown" } };
  assertEq(
    processKey("x", bindings),
    { action: "dismiss" },
    "'x' not in bindings, not a prefix",
  );
  assertEq(
    processKey("z", bindings),
    { action: "dismiss" },
    "'z' not in bindings",
  );
  assertEq(
    processKey("wa", bindings),
    { action: "dismiss" },
    "'wa' not a prefix of anything",
  );
}

section("processKey — multi-key sequences accumulate correctly");

{
  // Simulate: leader → g → s
  const bindings = {
    gs: { exec: "git status" },
    gd: { exec: "git diff" },
    w: { command: "/model" },
  };
  assertEq(
    processKey("g", bindings),
    { action: "wait", exact: false },
    "step 1: after 'g', waiting",
  );
  assertEq(
    processKey("gs", bindings),
    { action: "fire", key: "gs" },
    "step 2: after 'gs', fire",
  );
}

{
  // Simulate: leader → g → z (dead end)
  const bindings = { gs: { exec: "git status" }, gd: { exec: "git diff" } };
  assertEq(
    processKey("g", bindings),
    { action: "wait", exact: false },
    "step 1: after 'g', waiting",
  );
  assertEq(
    processKey("gz", bindings),
    { action: "dismiss" },
    "step 2: 'gz' is dead end",
  );
}

{
  // Simulate: leader → a → b → c
  const bindings = {
    abc: { command: "/abc" },
    abd: { command: "/abd" },
    xyz: { command: "/xyz" },
  };
  assertEq(
    processKey("a", bindings),
    { action: "wait", exact: false },
    "'a' is prefix of 'abc'/'abd'",
  );
  assertEq(
    processKey("ab", bindings),
    { action: "wait", exact: false },
    "'ab' is prefix of 'abc'/'abd'",
  );
  assertEq(
    processKey("abc", bindings),
    { action: "fire", key: "abc" },
    "'abc' is exact, not a prefix of anything longer",
  );
}

section("processKey — edge cases");

{
  // Empty bindings
  const bindings: Record<string, BindingAction> = {};
  assertEq(
    processKey("a", bindings),
    { action: "dismiss" },
    "any key in empty bindings => dismiss",
  );
  assertEq(
    processKey("", bindings),
    { action: "dismiss" },
    "empty buffer in empty bindings => dismiss",
  );
}

{
  // Single binding
  const bindings = { x: { command: "/model" } };
  assertEq(
    processKey("x", bindings),
    { action: "fire", key: "x" },
    "only binding matches",
  );
  assertEq(
    processKey("y", bindings),
    { action: "dismiss" },
    "non-matching in single binding",
  );
}

{
  // Numbers as keys (e.g. binding "0" for something)
  const bindings = {
    "0": { command: "/zero" },
    "1": { command: "/one" },
    "10": { command: "/ten" },
  };
  assertEq(
    processKey("1", bindings),
    { action: "wait", exact: true },
    "'1' matches but '10' is a prefix extension",
  );
  assertEq(
    processKey("10", bindings),
    { action: "fire", key: "10" },
    "'10' is unique exact",
  );
  assertEq(
    processKey("0", bindings),
    { action: "fire", key: "0" },
    "'0' is unique exact",
  );
}

{
  // Many keys sharing prefix
  const bindings: Record<string, BindingAction> = {};
  for (const k of ["ga", "gb", "gc", "gd", "ge", "gf", "gg", "gh"]) {
    bindings[k] = { command: `/${k}` };
  }
  assertEq(
    processKey("g", bindings),
    { action: "wait", exact: false },
    "'g' prefix of 8 bindings",
  );
  assertEq(
    processKey("ga", bindings),
    { action: "fire", key: "ga" },
    "'ga' is exact and not a prefix",
  );
  assertEq(
    processKey("gz", bindings),
    { action: "dismiss" },
    "'gz' not a prefix",
  );
}

// ---------------------------------------------------------------------------
// buildCommandMenu (/leader-commands discovery)
// ---------------------------------------------------------------------------

section("buildCommandMenu");

function cmd(
  overrides: Partial<PiCommand> & Pick<PiCommand, "name">,
): PiCommand {
  return {
    source: "extension",
    sourceInfo: {
      path: "/tmp/x.ts",
      source: "test",
      scope: "user",
      origin: "top-level",
    },
    ...overrides,
  };
}

{
  const menu = buildCommandMenu([
    cmd({ name: "om:view", description: "View the oracle" }),
    cmd({ name: "reload", source: "prompt" }),
    cmd({ name: "review:1", source: "skill", description: "Review changes" }),
    cmd({ name: "review:2", source: "skill" }),
  ]);

  assertEq(menu.length, 4, "one entry per command");
  // Order preserved (pi's native ordering: extensions, templates, skills)
  assertEq(
    menu.map((e) => e.value),
    ["om:view", "reload", "review:1", "review:2"],
    "native order preserved",
  );
  assertEq(menu[0]!.label, "/om:view", "label is the invokable string");
  assertEq(
    menu[0]!.description,
    "extension — View the oracle",
    "description encodes source then description",
  );
  assertEq(
    menu[1]!.description,
    "prompt",
    "description omits absent description",
  );
  assertEq(menu[2]!.value, "review:1", "suffixed duplicate keeps exact name");
  assertEq(menu[3]!.description, "skill", "second suffixed duplicate distinct");
  // value stays verbatim for echoing /name on selection
  assert(
    menu.every((e) => !e.value.includes("/")),
    "values carry no leading slash",
  );
}

{
  assertEq(buildCommandMenu([]), [], "empty command set => empty menu");
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

section("Config loading");

{
  // Test: missing config => defaults, reported as "missing" (normal)
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  const r1 = loadConfig(CONFIG_PATH);
  assertEq(r1.error, "missing", "missing config reports 'missing'");
  assertEq(r1.config.leaderKey, DEFAULT_CONFIG.leaderKey, "default leaderKey");
  assertEq(
    r1.config.leaderTimeoutMs,
    DEFAULT_CONFIG.leaderTimeoutMs,
    "default leaderTimeoutMs",
  );
  assertEq(
    r1.config.sequenceTimeoutMs,
    DEFAULT_CONFIG.sequenceTimeoutMs,
    "default sequenceTimeoutMs",
  );
  assertEq(r1.config.bindings, {}, "default empty bindings");
  assertEq(r1.config.editorEffect, "grayedOut", "default editorEffect");

  // Test: valid config
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      leaderKey: "ctrl+\\",
      leaderTimeoutMs: 5000,
      sequenceTimeoutMs: 1000,
      bindings: { w: { command: "/model" } },
    }),
  );
  const r2 = loadConfig(CONFIG_PATH);
  assertEq(r2.error, null, "valid config has no error");
  assertEq(r2.config.leaderKey, "ctrl+\\", "custom leaderKey");
  assertEq(r2.config.leaderTimeoutMs, 5000, "custom leaderTimeoutMs");
  assertEq(r2.config.sequenceTimeoutMs, 1000, "custom sequenceTimeoutMs");
  assert(
    typeof r2.config.bindings === "object" && r2.config.bindings !== null,
    "bindings is object",
  );
  assert("w" in r2.config.bindings, "binding 'w' exists");

  // Test: editorEffect field
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      editorEffect: "grayedOut",
      bindings: { a: {} },
    }),
  );
  assertEq(
    loadConfig(CONFIG_PATH).config.editorEffect,
    "grayedOut",
    "custom editorEffect grayedOut",
  );

  // Test: explicit "none" is the only other supported value
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      editorEffect: "none",
      bindings: { a: {} },
    }),
  );
  assertEq(
    loadConfig(CONFIG_PATH).config.editorEffect,
    "none",
    "custom editorEffect none",
  );

  // Test: spinner-era config with editorEffect "spinner" coerces to default grayedOut
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      editorEffect: "spinner",
      spinnerName: "aurora",
      bindings: { b: {} },
    }),
  );
  assertEq(
    loadConfig(CONFIG_PATH).config.editorEffect,
    "grayedOut",
    "spinner-era editorEffect coerces to grayedOut",
  );

  // Test: partial config (some fields missing)
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      bindings: { x: {} },
    }),
  );
  const r3 = loadConfig(CONFIG_PATH);
  assertEq(r3.config.leaderKey, "ctrl+space", "missing leaderKey => default");
  assertEq(
    r3.config.leaderTimeoutMs,
    3600,
    "missing leaderTimeoutMs => default",
  );
  assert("x" in r3.config.bindings, "partial config bindings preserved");

  // Test: wrong-typed fields => rejected to defaults (hand-edited config is
  // an untyped text file; garbage must not reach setTimeout/registerShortcut)
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      leaderKey: 123,
      leaderTimeoutMs: true,
      sequenceTimeoutMs: "750",
    }),
  );
  const rType = loadConfig(CONFIG_PATH);
  assertEq(
    rType.config.leaderKey,
    DEFAULT_CONFIG.leaderKey,
    "non-string leaderKey => default",
  );
  assertEq(
    rType.config.leaderTimeoutMs,
    DEFAULT_CONFIG.leaderTimeoutMs,
    "non-number leaderTimeoutMs => default",
  );
  assertEq(
    rType.config.sequenceTimeoutMs,
    DEFAULT_CONFIG.sequenceTimeoutMs,
    "non-number sequenceTimeoutMs => default",
  );

  // Test: non-positive timeouts => rejected to defaults (setTimeout with
  // <= 0 / NaN collapses to ~1ms, which reads as "leader key is broken")
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ leaderTimeoutMs: -5, sequenceTimeoutMs: 0 }),
  );
  const rNeg = loadConfig(CONFIG_PATH);
  assertEq(
    rNeg.config.leaderTimeoutMs,
    DEFAULT_CONFIG.leaderTimeoutMs,
    "negative leaderTimeoutMs => default",
  );
  assertEq(
    rNeg.config.sequenceTimeoutMs,
    DEFAULT_CONFIG.sequenceTimeoutMs,
    "zero sequenceTimeoutMs => default",
  );

  // Test: invalid JSON => defaults + "parse" error (surfaces on shortcut press)
  writeFileSync(CONFIG_PATH, "not valid json {{{");
  const rParse = loadConfig(CONFIG_PATH);
  assertEq(rParse.error, "parse", "invalid JSON reports 'parse'");
  assertEq(rParse.config.bindings, {}, "invalid JSON => empty bindings");
  assertEq(
    rParse.config.leaderKey,
    "ctrl+space",
    "invalid JSON => default leaderKey",
  );

  // Test: bindings is not an object (array) => treated as empty
  writeFileSync(CONFIG_PATH, JSON.stringify({ bindings: [1, 2, 3] }));
  const rArray = loadConfig(CONFIG_PATH);
  assertEq(rArray.config.bindings, {}, "array bindings treated as empty");

  // Test: empty file
  writeFileSync(CONFIG_PATH, "");
  const rEmpty = loadConfig(CONFIG_PATH);
  assertEq(rEmpty.config.bindings, {}, "empty file => empty bindings");
  assertEq(rEmpty.error, "parse", "empty file reports 'parse'");

  // Test: valid JSON with no bindings => no error, empty bindings
  writeFileSync(CONFIG_PATH, JSON.stringify({}));
  const rEmptyValid = loadConfig(CONFIG_PATH);
  assertEq(rEmptyValid.error, null, "valid empty config has no error");
  assertEq(
    rEmptyValid.config.bindings,
    {},
    "valid empty config => empty bindings",
  );
}

// ---------------------------------------------------------------------------
// ensureConfig — first-run blank config (guarded)
// ---------------------------------------------------------------------------

section("ensureConfig");

const ENSURE_PATH = join(CONFIG_DIR, "ensure-leader-key.json");

{
  // Missing file => created with blank defaults
  const r = ensureConfig(ENSURE_PATH);
  assertEq(r, "created", "missing file => created");
  const written = JSON.parse(readFileSync(ENSURE_PATH, "utf-8"));
  assertEq(written, DEFAULT_CONFIG, "written content is blank defaults");
  assertEq(written.bindings, {}, "written bindings are empty");

  // Second call => exists, file untouched
  assertEq(ensureConfig(ENSURE_PATH), "exists", "existing file => exists");
  assertEq(
    JSON.parse(readFileSync(ENSURE_PATH, "utf-8")),
    DEFAULT_CONFIG,
    "second call left content unchanged",
  );

  // Existing invalid file => exists, never clobbered
  writeFileSync(ENSURE_PATH, "garbage {{{");
  assertEq(
    ensureConfig(ENSURE_PATH),
    "exists",
    "invalid existing file => exists",
  );
  assertEq(
    readFileSync(ENSURE_PATH, "utf-8"),
    "garbage {{{",
    "invalid file content untouched",
  );

  // Unwritable location (missing parent dir) => error, no throw
  assertEq(
    ensureConfig(join(CONFIG_DIR, "nope", "x.json")),
    "error",
    "unwritable path => error",
  );

  // Template is valid JSON on its own
  assertEq(JSON.parse(defaultConfigJson()), DEFAULT_CONFIG, "template parses");

  rmSync(ENSURE_PATH);
}

{
  // ---------------------------------------------------------------------------
  // validateSequence (binding wizard)
  // ---------------------------------------------------------------------------

  section("validateSequence");

  assertEq(validateSequence(""), "empty", "empty string rejected");
  assertEq(validateSequence("   "), "empty", "whitespace-only rejected");
  assertEq(validateSequence(" gs "), null, "surrounding whitespace trimmed");
  assert(validateSequence("g s") !== null, "internal whitespace rejected");
  assert(validateSequence("gsé") !== null, "non-ASCII rejected");
  assertEq(validateSequence("gs\t"), null, "trailing tab trimmed away");
  assertEq(validateSequence("\t"), "empty", "tab-only rejected");
  assertEq(validateSequence("gs"), null, "valid multi-key accepted");
  assertEq(validateSequence("c"), null, "valid single key accepted");

  // ---------------------------------------------------------------------------
  // findConflicts (binding wizard)
  // ---------------------------------------------------------------------------

  section("findConflicts");

  const conflictBindings: Record<string, BindingAction> = {
    c: { action: "compact" },
    gs: { exec: "git status" },
  };

  assertEq(
    findConflicts(conflictBindings, "gs"),
    ["gs"],
    "exact match detected",
  );
  assertEq(
    findConflicts(conflictBindings, "g"),
    ["gs"],
    "new sequence is proper prefix of existing",
  );
  assertEq(
    findConflicts(conflictBindings, "gst"),
    ["gs"],
    "existing key is proper prefix of new sequence",
  );
  assertEq(
    findConflicts(conflictBindings, "gd"),
    [],
    "unrelated sequence clean",
  );
  assertEq(findConflicts({}, "gs"), [], "empty bindings clean");

  // ---------------------------------------------------------------------------
  // mergeBinding (binding wizard)
  // ---------------------------------------------------------------------------

  section("mergeBinding");

  const baseConfig: LeaderConfig = {
    ...DEFAULT_CONFIG,
    bindings: { c: { action: "compact" }, gs: { exec: "git status" } },
  };

  const merged = mergeBinding(baseConfig, "gd", { exec: "git diff" });
  assertEq(Object.keys(merged.bindings).length, 3, "merge adds a binding");
  assertEq(merged.bindings.gd, { exec: "git diff" }, "new binding present");
  assertEq(
    merged.bindings.c,
    { action: "compact" },
    "existing binding preserved",
  );
  assertEq(baseConfig.bindings.gd, undefined, "input config not mutated (add)");
  assertEq(
    merged.leaderKey,
    baseConfig.leaderKey,
    "non-binding fields preserved",
  );

  const replaced = mergeBinding(baseConfig, "gs", { command: "/status" });
  assertEq(
    Object.keys(replaced.bindings).length,
    2,
    "merge replaces, does not duplicate",
  );
  assertEq(
    replaced.bindings.gs,
    { command: "/status" },
    "replaced value present",
  );
  assertEq(
    baseConfig.bindings.gs,
    { exec: "git status" },
    "input config not mutated (replace)",
  );
  assertEq(
    Object.keys(replaced.bindings)[0],
    "c",
    "replaced key keeps its original position",
  );
} // end temp-scope bindings

// ---------------------------------------------------------------------------
// saveBinding (binding wizard — config persistence)
// ---------------------------------------------------------------------------

section("saveBinding");

{
  const SAVE_PATH = join(CONFIG_DIR, "save-binding.json");
  if (existsSync(SAVE_PATH)) unlinkSync(SAVE_PATH);

  // Missing file: create it with the new binding over defaults
  const r1 = saveBinding("gh", { exec: "git log" }, SAVE_PATH);
  assertEq(r1.ok, true, "save to missing file succeeds");
  assertEq(
    loadConfig(SAVE_PATH).config.bindings.gh,
    { exec: "git log" },
    "missing-file save writes the binding",
  );

  // Existing file: merge, preserve everything else
  writeFileSync(
    SAVE_PATH,
    JSON.stringify({
      leaderKey: "ctrl+\\",
      bindings: { c: { action: "compact" }, gs: { exec: "git status" } },
    }),
  );
  const r2 = saveBinding("gd", { exec: "git diff" }, SAVE_PATH);
  assertEq(r2.ok, true, "save to existing file succeeds");
  const reloaded = loadConfig(SAVE_PATH).config;
  assertEq(reloaded.bindings.gd, { exec: "git diff" }, "new binding persisted");
  assertEq(
    reloaded.bindings.gs,
    { exec: "git status" },
    "prior bindings intact",
  );
  assertEq(reloaded.leaderKey, "ctrl+\\", "non-binding fields intact");

  // Overwrite an existing sequence
  const r3 = saveBinding("gs", { command: "/branch" }, SAVE_PATH);
  assertEq(r3.ok, true, "overwrite succeeds");
  assertEq(
    loadConfig(SAVE_PATH).config.bindings.gs,
    { command: "/branch" },
    "overwritten binding persisted",
  );

  // Corrupt file: refuse to write, leave it byte-identical
  const corrupt = "{ not json";
  writeFileSync(SAVE_PATH, corrupt);
  const r4 = saveBinding("gx", { exec: "x" }, SAVE_PATH);
  assertEq(r4.ok, false, "corrupt config refuses to save");
  assertEq(readFileSync(SAVE_PATH, "utf-8"), corrupt, "corrupt file untouched");

  // Unwritable path: reports failure, nothing thrown
  const r5 = saveBinding(
    "gx",
    { exec: "x" },
    join(CONFIG_DIR, "no", "such", "dir.json"),
  );
  assertEq(r5.ok, false, "unwritable path reports failure");

  unlinkSync(SAVE_PATH);
}

rmSync(CONFIG_DIR, { recursive: true, force: true });

console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.");
}

/**
 * Pure logic for the leader-key extension: config loading and key
 * matching. Deliberately free of pi imports so the test suite can load
 * this module directly under tsx (the extension's own imports of
 * @earendil-works/pi-* don't resolve outside pi).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types & config
// ---------------------------------------------------------------------------

export type EditorEffect = "grayedOut" | "none";

export type BindingAction =
 | { command: string }
 | { action: "compact" | "shutdown" | "clearEditor" }
 | { exec: string };

export interface LeaderConfig {
 leaderKey: string;
 leaderTimeoutMs: number;
 sequenceTimeoutMs: number;
 editorEffect: EditorEffect;
 bindings: Record<string, BindingAction>;
}

export const DEFAULT_CONFIG: LeaderConfig = {
 leaderKey: "ctrl+space",
 leaderTimeoutMs: 3600,
 sequenceTimeoutMs: 750,
 editorEffect: "grayedOut",
 bindings: {},
};

/**
 * Config lives in pi's own config dir (next to settings.json) so it
 * survives package updates — the package itself ships no config file.
 */
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "leader-key.json");

/** Why the loader fell back to defaults. "missing" is normal (no config yet). */
export type ConfigError = "missing" | "parse" | null;

export interface ConfigResult {
 config: LeaderConfig;
 error: ConfigError;
}

export function loadConfig(path: string = CONFIG_PATH): ConfigResult {
 const defaults = { ...DEFAULT_CONFIG, bindings: {} };
 try {
  if (!existsSync(path)) return { config: defaults, error: "missing" };
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return {
   config: {
    leaderKey: parsed.leaderKey ?? DEFAULT_CONFIG.leaderKey,
    leaderTimeoutMs: parsed.leaderTimeoutMs ?? DEFAULT_CONFIG.leaderTimeoutMs,
    sequenceTimeoutMs:
     parsed.sequenceTimeoutMs ?? DEFAULT_CONFIG.sequenceTimeoutMs,
    // Configs from the spinner era may still carry editorEffect: "spinner";
    // anything that isn't "none" falls back to the default (grayedOut).
    editorEffect:
     parsed.editorEffect === "none" ? "none" : DEFAULT_CONFIG.editorEffect,
    bindings:
     parsed.bindings != null &&
     typeof parsed.bindings === "object" &&
     !Array.isArray(parsed.bindings)
      ? parsed.bindings
      : {},
   },
   error: null,
  };
 } catch {
  return { config: defaults, error: "parse" };
 }
}

// ---------------------------------------------------------------------------
// First-run config bootstrap
// ---------------------------------------------------------------------------

/** Pretty-printed blank config — the template written on first startup. */
export function defaultConfigJson(): string {
 return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}

export type EnsureConfigResult = "created" | "exists" | "error";

/**
 * Write the default config on first startup. Guarded: never touches an
 * existing file (even an invalid one), and a failed write just reports —
 * loadConfig's in-memory defaults keep the extension working.
 */
export function ensureConfig(path: string = CONFIG_PATH): EnsureConfigResult {
 if (existsSync(path)) return "exists";
 try {
  writeFileSync(path, defaultConfigJson());
  return "created";
 } catch {
  return "error";
 }
}

// ---------------------------------------------------------------------------
// Command discovery menu (/leader-commands)
// ---------------------------------------------------------------------------

/**
 * Structural shape of a pi.getCommands() entry (see pi's docs/extensions.md).
 * Declared here so this module loads standalone under the test runner —
 * the handler passes pi's objects straight in, no import needed.
 */
export interface PiCommand {
 name: string;
 description?: string;
 source: "extension" | "prompt" | "skill";
 sourceInfo: {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
 };
}

export interface CommandMenuEntry {
 /** Exact invokable name (without leading slash), echoed on selection. */
 value: string;
 /** Display line: /name */
 label: string;
 /** Provenance + description: "extension — View the oracle" */
 description: string;
}

/** Map getCommands() output to picker entries, preserving pi's native order. */
export function buildCommandMenu(commands: PiCommand[]): CommandMenuEntry[] {
 return commands.map((c) => ({
  value: c.name,
  label: `/${c.name}`,
  description: [c.source, c.description].filter(Boolean).join(" — "),
 }));
}

// ---------------------------------------------------------------------------
// Key matching
// ---------------------------------------------------------------------------

export function isPrintableKey(data: string): boolean {
 if (data.length === 1) {
  const code = data.charCodeAt(0);
  return code >= 32 && code <= 126;
 }
 return false;
}

/** Proper prefix: candidate is longer than prefix and starts with it. */
export function isProperPrefix(prefix: string, candidate: string): boolean {
 if (prefix.length === 0) return false;
 return candidate.startsWith(prefix) && candidate.length > prefix.length;
}

/**
 * Sequence matching engine — pure function that determines the result
 * of a keypress given the current buffer and bindings.
 *
 * Returns:
 *   { action: "fire", key }        — dispatch immediately
 *   { action: "wait", exact }      — start/keep the sequence timer;
 *                                    exact means an exact match is also a
 *                                    prefix (fire after the timeout), false
 *                                    means prefix-only (dismiss after it)
 *   { action: "dismiss" }          — dead end, dismiss
 */
export type SeqResult =
 | { action: "fire"; key: string }
 | { action: "wait"; exact: boolean }
 | { action: "dismiss" };

export function processKey(
 buffer: string,
 bindings: Record<string, BindingAction>,
): SeqResult {
 const exact = Object.hasOwn(bindings, buffer);
 const isPrefixOfAnother = Object.keys(bindings).some((k) =>
  isProperPrefix(buffer, k),
 );

 if (exact && !isPrefixOfAnother) return { action: "fire", key: buffer };
 if (exact && isPrefixOfAnother) return { action: "wait", exact: true };
 if (!exact && isPrefixOfAnother) return { action: "wait", exact: false };
 return { action: "dismiss" };
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OcxProviderConfig } from "../../types";

/**
 * Credential resolution for the `devin-http` provider.
 *
 * The Cascade API authenticates with the SAME session token the Devin CLI stores after
 * `devin auth login`: a `devin-session-token$...` value, ~189 chars, that the server accepts
 * verbatim in the `Metadata.api_key` field (verified 2026-09-12 — no signature, no per-call nonce,
 * no client fingerprint beyond the Windsurf identity fields the encoder always sends).
 *
 * Resolution order:
 *   1. `provider.apiKey` — the explicit configuration path, and the only one that works for a
 *      multi-account setup or a machine without the CLI installed.
 *   2. The Devin CLI's `credentials.toml`, so a user who already ran `devin auth login` needs no
 *      extra configuration. This mirrors the `devin` (ACP) provider, which gets the same login
 *      for free by spawning the CLI that owns it.
 *
 * Order matters: an explicitly configured key must never be silently overridden by whatever
 * account the CLI happens to be logged into.
 */

export class DevinMissingCredentialError extends Error {
  constructor() {
    super(
      "Devin credentials not found. Set the provider API key, or run `devin auth login` "
      + "so the CLI writes its credentials.toml.",
    );
    this.name = "DevinMissingCredentialError";
  }
}

/** The Devin CLI prefixes its stored key; the server tolerates it either way, so normalize once. */
const SESSION_TOKEN_PREFIX = "devin-session-token$";

export function normalizeDevinToken(token: string): string {
  const trimmed = token.trim();
  return trimmed.startsWith(SESSION_TOKEN_PREFIX) ? trimmed : `${SESSION_TOKEN_PREFIX}${trimmed}`;
}

/**
 * Candidates for the CLI's credential file, most specific first.
 *
 * The CLI honours `DEVIN_CONFIG_DIR` (its own override) and otherwise uses the platform data dir.
 * Linux and macOS both resolve to `~/.local/share/devin` in the observed release; Windows uses
 * `%APPDATA%\devin`. Every candidate is relative to `homedir()` or an env override so the test
 * suite can redirect the whole search by rewriting HOME.
 */
export function devinCredentialFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];

  const explicitDir = env.DEVIN_CONFIG_DIR?.trim();
  if (explicitDir) candidates.push(join(explicitDir, "credentials.toml"));

  const home = env.HOME?.trim() || homedir();
  if (env.XDG_DATA_HOME?.trim()) candidates.push(join(env.XDG_DATA_HOME.trim(), "devin", "credentials.toml"));
  candidates.push(join(home, ".local", "share", "devin", "credentials.toml"));

  const appData = env.APPDATA?.trim();
  if (appData) candidates.push(join(appData, "devin", "credentials.toml"));

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) candidates.push(join(localAppData, "devin", "credentials.toml"));

  return candidates;
}

/**
 * The `windsurf_api_key` value from a `credentials.toml`.
 *
 * Written by hand rather than pulled from a TOML dependency: the file is four scalar
 * `key = "value"` lines under optional table headers, and this provider reads exactly one of them.
 * A full parser would be a production dependency for a four-line file.
 *
 * Returns "" when the key is absent or the file is unreadable, so the caller's resolution order
 * simply continues.
 */
export function readDevinCredentialFile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*windsurf_api_key\s*=\s*"([^"]*)"/);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

/** The first readable credential file's key, or "" when none has one. */
export function readDevinTokenFromDisk(env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of devinCredentialFileCandidates(env)) {
    if (!existsSync(candidate)) continue;
    const token = readDevinCredentialFile(candidate);
    if (token) return token;
  }
  return "";
}

/**
 * Resolve the session token, or throw. Never returns an empty string: an absent credential must
 * surface as a configuration error at request time rather than as a 401 from the upstream.
 *
 * The caller's Authorization header is deliberately NOT consulted. The proxy's own auth layer
 * rewrites that header before the adapter sees it (observed live: a loopback bearer arrived as a
 * 1761-char `eyJ...` JWT), so it names the caller's proxy identity, never a Devin credential. A
 * second Devin account is selected by configuring `apiKey` on this provider, not by forwarding a
 * header.
 */
export function resolveDevinToken(provider: OcxProviderConfig): string {
  const configured = provider.apiKey?.trim();
  if (configured) return normalizeDevinToken(configured);

  const disk = readDevinTokenFromDisk();
  if (disk) return normalizeDevinToken(disk);

  throw new DevinMissingCredentialError();
}

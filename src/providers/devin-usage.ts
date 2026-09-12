import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderQuota } from "./quota-types";

/**
 * Devin CLI account quota — read from the CLI's own GetUserStatus cache.
 *
 * The Devin CLI (chisel) refreshes `~/.cache/devin/cli/user_status.<digest>.bin` on every
 * authenticated run: a JSON envelope `{version, identity_digest, fetched_at_secs, payload}`
 * whose `payload` is the base64 protobuf of the seat-management `GetUserStatusResponse`.
 * That response carries the account's plan windows — `plan_status.daily_quota_remaining_percent`,
 * `weekly_quota_remaining_percent`, and the matching reset timestamps.
 *
 * opencodex deliberately does NOT re-derive the seat-management RPC: the CLI layers an
 * encrypted credential transform over the plain API key that we do not reproduce, and a
 * hand-rolled request body fails server validation. Reading the CLI-maintained cache keeps
 * this read-only, account-scoped, and honest about freshness: the file's `fetched_at_secs`
 * travels with the quota, and a stale cache degrades to "no data" rather than a fabricated
 * number. Running any authenticated `devin` command refreshes it.
 *
 * Field numbers below are read off the live wire (devin 3000.10.21, 2026-09-11) with a generic
 * decoder, cross-checked against the schema strings in the CLI binary:
 *   user_status(field 1) → plan_status(field 13):
 *     field 2.1 = daily_quota_reset_at_unix, field 3.1 = weekly_quota_reset_at_unix,
 *     field 14 = daily_quota_remaining_percent, field 15 = weekly_quota_remaining_percent
 *   plan_status → field 1 (plan/user info) → field 2 = plan name ("Pro"/"Max"/...)
 */

/** The cache lives under the CLI's state dir; XDG_CACHE_HOME wins when set (also the test seam),
 * otherwise the platform default (macOS ~/Library/Caches-style ~/​.cache, Windows %LOCALAPPDATA%). */
function devinCacheDir(): string | null {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, "devin", "cli");
  const platform = process.platform;
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local ? join(local, "devin", "cli") : null;
  }
  if (platform === "darwin") return join(homedir(), ".cache", "devin", "cli");
  return join(homedir(), ".cache", "devin", "cli");
}

interface DevineCacheEnvelope {
  fetched_at_secs?: number;
  payload?: string;
}

function readLatestUserStatusCache(): { payload: Buffer; fetchedAtMs: number } | null {
  const dir = devinCacheDir();
  if (!dir || !existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => /^user_status\..+\.bin$/.test(f));
  } catch {
    return null;
  }
  // Newest wins: an account switch changes the identity digest, so multiple caches can coexist.
  let newest: { file: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      // readdir order is not recency; stat each candidate.
      const mtime = statSync(join(dir, file)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    } catch {
      continue;
    }
  }
  if (!newest) return null;
  try {
    const envelope = JSON.parse(readFileSync(join(dir, newest.file), "utf8")) as DevineCacheEnvelope;
    if (typeof envelope.payload !== "string" || envelope.payload.length === 0) return null;
    return {
      payload: Buffer.from(envelope.payload, "base64"),
      fetchedAtMs: (typeof envelope.fetched_at_secs === "number" ? envelope.fetched_at_secs : 0) * 1000,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal protobuf reader: only what the fold-out below needs.
// ---------------------------------------------------------------------------

interface ProtoField {
  field: number;
  wire: number;
  varint?: number;
  bytes?: Buffer;
}

function readVarint(buf: Buffer, i: number): { value: number; next: number } | null {
  let result = 0n;
  let shift = 0n;
  while (i < buf.length) {
    const b = buf[i]!;
    i += 1;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      const num = Number(result);
      return { value: num >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : num, next: i };
    }
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function readFields(buf: Buffer): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return null;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    i = key.next;
    if (field === 0 || wire === 3 || wire === 4) return null;
    if (wire === 0) {
      const val = readVarint(buf, i);
      if (!val) return null;
      i = val.next;
      fields.push({ field, wire, varint: val.value });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len || i + len.value > buf.length) return null;
      fields.push({ field, wire, bytes: buf.subarray(len.next, len.next + len.value) });
      i = len.next + len.value;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else return null;
  }
  return fields;
}

function subfield(buf: Buffer, field: number): Buffer | undefined {
  const fields = readFields(buf);
  if (!fields) return undefined;
  return fields.find(f => f.field === field && f.bytes !== undefined)?.bytes;
}

function subvarint(buf: Buffer, field: number): number | undefined {
  const fields = readFields(buf);
  if (!fields) return undefined;
  return fields.find(f => f.field === field && f.varint !== undefined)?.varint;
}

/** Percent fields are 0..100; anything else means we misread the wire. */
function isPercent(n: number | undefined): n is number {
  return typeof n === "number" && n >= 0 && n <= 100;
}

/** Unix seconds sanity window: 2025-01-01 .. 2050-01-01. */
function isUnixSeconds(n: number | undefined): n is number {
  return typeof n === "number" && n >= 1_735_689_600 && n <= 2_500_000_000;
}

export interface DevinUsageSnapshot {
  planName?: string;
  /** Percent of the plan window REMAINING, as the CLI reports it. */
  dailyRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  dailyResetAt?: number;
  weeklyResetAt?: number;
}

/** Extract the plan windows from a GetUserStatus protobuf buffer.
 *
 * Two wire shapes are accepted: the raw HTTP response (plan_status nested under
 * `user_status`, field 1 → 13) and the CLI cache envelope's payload, where the wrapper
 * message carries plan_status directly at field 13.
 */
export function parseDevinUserStatus(response: Buffer): DevinUsageSnapshot | null {
  const userStatus = subfield(response, 1);
  const planStatus = (userStatus ? subfield(userStatus, 13) : undefined) ?? subfield(response, 13);
  if (!planStatus) return null;

  const dailyRemaining = subvarint(planStatus, 14);
  const weeklyRemaining = subvarint(planStatus, 15);
  // Reset timestamps live in small nested messages (field 2 → subfield 1, field 3 → subfield 1).
  const dailyMsg = subfield(planStatus, 2);
  const weeklyMsg = subfield(planStatus, 3);
  const dailyResetAt = dailyMsg ? subvarint(dailyMsg, 1) : undefined;
  const weeklyResetAt = weeklyMsg ? subvarint(weeklyMsg, 1) : undefined;
  const planInfo = subfield(planStatus, 1);
  const planName = planInfo ? subfield(planInfo, 2)?.toString("utf8") : undefined;

  const validDailyPercent = isPercent(dailyRemaining) ? dailyRemaining : undefined;
  const validWeeklyPercent = isPercent(weeklyRemaining) ? weeklyRemaining : undefined;
  if (validDailyPercent === undefined && validWeeklyPercent === undefined && !planName) return null;

  return {
    ...(planName ? { planName } : {}),
    ...(validDailyPercent !== undefined ? { dailyRemainingPercent: validDailyPercent } : {}),
    ...(validWeeklyPercent !== undefined ? { weeklyRemainingPercent: validWeeklyPercent } : {}),
    ...(isUnixSeconds(dailyResetAt) ? { dailyResetAt: dailyResetAt * 1000 } : {}),
    ...(isUnixSeconds(weeklyResetAt) ? { weeklyResetAt: weeklyResetAt * 1000 } : {}),
  };
}

/**
 * Build the dashboard quota from the CLI cache. `remaining` is inverted into the used-percentage
 * convention every other window on `ProviderQuota` speaks, so the dashboard bars read like the
 * rest: high = draining, not high = healthy.
 */
export function fetchDevinUsageSnapshot(): ProviderQuota | null {
  const cache = readLatestUserStatusCache();
  if (!cache || cache.payload.length === 0) return null;
  const snapshot = parseDevinUserStatus(cache.payload);
  if (!snapshot) return null;

  const customWindows: ProviderQuota["customWindows"] = [];
  if (snapshot.dailyRemainingPercent !== undefined) {
    customWindows.push({
      label: "Daily",
      percent: 100 - snapshot.dailyRemainingPercent,
      ...(snapshot.dailyResetAt !== undefined ? { resetAt: snapshot.dailyResetAt } : {}),
    });
  }
  const quota: ProviderQuota = { updatedAt: cache.fetchedAtMs || Date.now() };
  if (customWindows.length > 0) quota.customWindows = customWindows;
  if (snapshot.weeklyRemainingPercent !== undefined) {
    quota.weeklyPercent = 100 - snapshot.weeklyRemainingPercent;
    if (snapshot.weeklyResetAt !== undefined) quota.weeklyResetAt = snapshot.weeklyResetAt;
  }
  return quota;
}

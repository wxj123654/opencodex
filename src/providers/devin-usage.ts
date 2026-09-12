/**
 * Devin account quota — direct `GetUserStatus` RPC.
 *
 * `fetchDevinQuotaLive(token)` calls the seat-management `GetUserStatus` RPC directly.
 * The RPC accepts the stored session token verbatim in a plain protobuf `Metadata` envelope:
 * no signature, no per-call nonce, no credential transform (verified 2026-09-12 against the
 * live service; the encoded response decodes to the same plan window the CLI cache reports).
 * This is the reader the `devin-http` provider uses, because that provider already holds the
 * token for its chat path.
 *
 * Field numbers below are read off the live wire (devin 3000.10.21, 2026-09-11/12) with a generic
 * decoder, cross-checked against the schema strings in the CLI binary:
 *   user_status(field 1) → plan_status(field 13):
 *     field 2.1 = daily_quota_reset_at_unix, field 3.1 = weekly_quota_reset_at_unix,
 *     field 14 = daily_quota_remaining_percent, field 15 = weekly_quota_remaining_percent
 *   plan_status → field 1 (plan/user info) → field 2 = plan name ("Pro"/"Max"/...)
 */
import type { ProviderQuota } from "./quota-types";
import { buildDevinMetadata, DEVIN_CASCADE_BASE_URL } from "../adapters/devin-http/client";
import { encodeGetUserJwtRequest } from "../adapters/devin-http/proto";

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

export const DEVIN_GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

/**
 * Read the account's plan windows straight from the seat-management RPC.
 *
 * Returns null on any failure — a missing credential, a network error, or an unrecognised response
 * shape — because a quota row is advisory and an invented number is worse than an absent one.
 */
export async function fetchDevinQuotaLive(
  token: string,
  deps: { fetch?: typeof globalThis.fetch; baseUrl?: string } = {},
): Promise<ProviderQuota | null> {
  if (!token.trim()) return null;
  try {
    // The seat-management RPC takes the same `Metadata` envelope as every other Cascade call, so
    // the request is the generic one rather than a bespoke message.
    const response = await (deps.fetch ?? globalThis.fetch)(
      `${(deps.baseUrl ?? DEVIN_CASCADE_BASE_URL).replace(/\/+$/, "")}${DEVIN_GET_USER_STATUS_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/proto",
          "connect-protocol-version": "1",
          accept: "*/*",
        },
        body: encodeGetUserJwtRequest(buildDevinMetadata(token)) as unknown as BodyInit,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return null;
    const payload = Buffer.from(await response.arrayBuffer());
    const snapshot = parseDevinUserStatus(payload);
    if (!snapshot) return null;
    return buildQuotaFromSnapshot(snapshot, Date.now());
  } catch {
    // A quota row is advisory: any transport, auth, or decode failure degrades to "no row"
    // rather than surfacing an error for a dashboard adornment.
    return null;
  }
}

/** Shared shaping so both readers produce identical windows for identical data. */
function buildQuotaFromSnapshot(snapshot: DevinUsageSnapshot, updatedAt: number): ProviderQuota {
  const customWindows: ProviderQuota["customWindows"] = [];
  if (snapshot.dailyRemainingPercent !== undefined) {
    customWindows.push({
      label: "Daily",
      percent: 100 - snapshot.dailyRemainingPercent,
      ...(snapshot.dailyResetAt !== undefined ? { resetAt: snapshot.dailyResetAt } : {}),
    });
  }
  const quota: ProviderQuota = { updatedAt };
  if (customWindows.length > 0) quota.customWindows = customWindows;
  if (snapshot.weeklyRemainingPercent !== undefined) {
    quota.weeklyPercent = 100 - snapshot.weeklyRemainingPercent;
    if (snapshot.weeklyResetAt !== undefined) quota.weeklyResetAt = snapshot.weeklyResetAt;
  }
  return quota;
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDevinUserStatus } from "../../src/providers/devin-usage";
import { fetchDevinUsageSnapshot } from "../../src/providers/devin-usage";

// ---------------------------------------------------------------------------
// Protobuf encoder for fixtures (varint + length-delimited only, all this
// wire needs).
// ---------------------------------------------------------------------------

function varint(n: number): Buffer {
  let value = BigInt(Math.max(0, Math.round(n)));
  const out: number[] = [];
  while (true) {
    const b = Number(value & 0x7fn);
    value >>= 7n;
    if (value === 0n) { out.push(b); return Buffer.from(out); }
    out.push(b | 0x80);
  }
}
function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire);
}
function lenDelim(field: number, payload: Buffer | string): Buffer {
  const b = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}
function v(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

const DAILY_RESET = 1_789_136_543;
const WEEKLY_RESET = 1_791_728_543;

/** PlanStatus exactly as observed on the live wire (devin 3000.10.21). */
function planStatusFixture(): Buffer {
  const planInfo = lenDelim(2, "Pro");
  const user = Buffer.concat([planInfo, v(1, 16), v(3, 1)]);
  return Buffer.concat([
    lenDelim(1, user),
    lenDelim(2, v(1, DAILY_RESET)),
    lenDelim(3, v(1, WEEKLY_RESET)),
    v(8, Number.MAX_SAFE_INTEGER),
    v(14, 100),
    v(15, 100),
    v(17, 1_789_200_000),
    v(18, 1_789_286_400),
  ]);
}

describe("devin user_status parsing", () => {
  test("the raw HTTP response shape nests plan_status under user_status (field 1 → 13)", () => {
    const response = lenDelim(1, lenDelim(13, planStatusFixture()));
    const snapshot = parseDevinUserStatus(response);
    expect(snapshot).toEqual({
      planName: "Pro",
      dailyRemainingPercent: 100,
      weeklyRemainingPercent: 100,
      dailyResetAt: DAILY_RESET * 1000,
      weeklyResetAt: WEEKLY_RESET * 1000,
    });
  });

  test("the CLI cache envelope payload carries plan_status directly at field 13", () => {
    const payload = lenDelim(13, planStatusFixture());
    const snapshot = parseDevinUserStatus(payload);
    expect(snapshot?.planName).toBe("Pro");
    expect(snapshot?.dailyRemainingPercent).toBe(100);
  });

  test("remaining percentages invert into used window percentages", () => {
    const plan = Buffer.concat([
      lenDelim(1, lenDelim(2, "Pro")),
      v(14, 30),
      v(15, 62),
      lenDelim(2, v(1, DAILY_RESET)),
      lenDelim(3, v(1, WEEKLY_RESET)),
    ]);
    const response = lenDelim(1, lenDelim(13, plan));
    const snapshot = parseDevinUserStatus(response)!;
    expect(snapshot.dailyRemainingPercent).toBe(30);
    expect(snapshot.weeklyRemainingPercent).toBe(62);
  });

  test("a response without plan_status or a plan name is rejected, never fabricated", () => {
    expect(parseDevinUserStatus(Buffer.from([0x08, 0x01]))).toBeNull();
    expect(parseDevinUserStatus(Buffer.alloc(0))).toBeNull();
  });

  test("out-of-range percent values are rejected", () => {
    const plan = Buffer.concat([v(14, 240), v(15, 100)]);
    const response = lenDelim(1, lenDelim(13, plan));
    const snapshot = parseDevinUserStatus(response);
    expect(snapshot?.dailyRemainingPercent).toBeUndefined();
    expect(snapshot?.weeklyRemainingPercent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Cache-file reading (fetchDevinUsageSnapshot) against an isolated cache dir.
// ---------------------------------------------------------------------------

const CACHE_DIR = join(tmpdir(), `ocx-devin-usage-${process.pid}`);
let previousXdg: string | undefined;

beforeEach(() => {
  previousXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = CACHE_DIR;
  mkdirSync(join(CACHE_DIR, "devin", "cli"), { recursive: true });
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousXdg;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

function writeCache(payload: Buffer, fetchedAtSecs: number, digest = "a".repeat(16)): void {
  writeFileSync(
    join(CACHE_DIR, "devin", "cli", `user_status.${digest}.bin`),
    JSON.stringify({ version: 1, identity_digest: digest, fetched_at_secs: fetchedAtSecs, payload: payload.toString("base64") }),
  );
}

describe("devin quota from the CLI cache", () => {
  test("reads the newest cache envelope and reports used-percentage windows", () => {
    const now = Math.floor(Date.now() / 1000);
    // Written OLDEST first: the reader picks by file mtime, so the newer identity is written last.
    writeCache(lenDelim(13, Buffer.concat([lenDelim(1, lenDelim(2, "Old")), v(14, 5), v(15, 5)])), now - 3600, "old");
    writeCache(lenDelim(13, planStatusFixture()), now - 60, "new");

    const quota = fetchDevinUsageSnapshot()!;
    expect(quota).not.toBeNull();
    expect(quota.updatedAt).toBe((now - 60) * 1000);
    expect(quota.customWindows).toEqual([{ label: "Daily", percent: 0, resetAt: DAILY_RESET * 1000 }]);
    expect(quota.weeklyPercent).toBe(0);
    expect(quota.weeklyResetAt).toBe(WEEKLY_RESET * 1000);
  });

  test("a missing or corrupt cache resolves to null, never a fabricated quota", () => {
    expect(fetchDevinUsageSnapshot()).toBeNull();
    writeCache(Buffer.from("not proto at all"), Math.floor(Date.now() / 1000));
    expect(fetchDevinUsageSnapshot()).toBeNull();
  });
});

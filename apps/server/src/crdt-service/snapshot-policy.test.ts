import { describe, expect, it } from "vitest";
import { SnapshotPolicy } from "./snapshot-policy.js";

describe("SnapshotPolicy", () => {
  it("is due after everyOps ops", () => {
    const policy = new SnapshotPolicy({ everyOps: 100, everyMs: 30_000, now: () => 0 });
    policy.recordOps(99);
    expect(policy.due()).toBe(false);
    policy.recordOps(1);
    expect(policy.due()).toBe(true);
  });

  it("is due after everyMs when at least one op occurred", () => {
    let t = 0;
    const policy = new SnapshotPolicy({ everyOps: 100, everyMs: 30_000, now: () => t });
    policy.recordOps(1);
    t = 29_999;
    expect(policy.due()).toBe(false);
    t = 30_000;
    expect(policy.due()).toBe(true);
  });

  it("is never due with zero ops, no matter how much time passes", () => {
    let t = 0;
    const policy = new SnapshotPolicy({ everyOps: 100, everyMs: 30_000, now: () => t });
    t = 10_000_000;
    expect(policy.due()).toBe(false);
  });

  it("reset restarts both the op count and the timer", () => {
    let t = 0;
    const policy = new SnapshotPolicy({ everyOps: 3, everyMs: 30_000, now: () => t });
    policy.recordOps(3);
    expect(policy.due()).toBe(true);
    policy.reset();
    expect(policy.due()).toBe(false); // ops cleared
    policy.recordOps(1);
    t = 30_000; // 30s from the reset, not from construction
    expect(policy.due()).toBe(true);
  });
});

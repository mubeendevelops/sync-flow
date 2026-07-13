import { describe, expect, it } from "vitest";
import {
  type CharId,
  ROOT,
  isRoot,
  encodeId,
  decodeId,
  compareId,
  idsEqual,
  LamportClock,
} from "./id.js";

const ids: CharId[] = [
  { clock: 1, replicaId: "a" },
  { clock: 1, replicaId: "b" },
  { clock: 2, replicaId: "a" },
  { clock: 2, replicaId: "b" },
  { clock: 5, replicaId: "a" },
  ROOT,
];

describe("encodeId / decodeId", () => {
  it("round-trips", () => {
    for (const id of ids) {
      expect(decodeId(encodeId(id))).toEqual(id);
    }
  });

  it("encodes as <clock>@<replicaId>", () => {
    expect(encodeId({ clock: 7, replicaId: "tab-xyz" })).toBe("7@tab-xyz");
    expect(encodeId(ROOT)).toBe("0@ROOT");
  });

  it("rejects malformed input", () => {
    expect(() => decodeId("")).toThrow();
    expect(() => decodeId("@a")).toThrow();
    expect(() => decodeId("5@")).toThrow();
    expect(() => decodeId("notanumber@a")).toThrow();
    expect(() => decodeId("-1@a")).toThrow();
  });
});

describe("compareId total order", () => {
  it("orders primarily by clock, then by replicaId", () => {
    expect(compareId({ clock: 1, replicaId: "z" }, { clock: 2, replicaId: "a" })).toBeLessThan(0);
    expect(compareId({ clock: 2, replicaId: "a" }, { clock: 2, replicaId: "b" })).toBeLessThan(0);
    expect(compareId({ clock: 2, replicaId: "b" }, { clock: 2, replicaId: "a" })).toBeGreaterThan(
      0,
    );
  });

  it("is reflexive-zero (equal ids compare 0)", () => {
    for (const id of ids) expect(compareId(id, { ...id })).toBe(0);
  });

  it("is antisymmetric: sign(cmp(a,b)) === -sign(cmp(b,a))", () => {
    const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);
    for (const a of ids) {
      for (const b of ids) {
        expect(sign(compareId(a, b))).toBe(-sign(compareId(b, a)) || 0);
      }
    }
  });

  it("is transitive: a<b and b<c ⇒ a<c", () => {
    for (const a of ids) {
      for (const b of ids) {
        for (const c of ids) {
          if (compareId(a, b) < 0 && compareId(b, c) < 0) {
            expect(compareId(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it("sorts ROOT strictly first", () => {
    const sorted = [...ids].sort(compareId);
    expect(sorted[0]).toEqual(ROOT);
    for (const id of ids) {
      if (!isRoot(id)) expect(compareId(ROOT, id)).toBeLessThan(0);
    }
  });
});

describe("idsEqual / isRoot", () => {
  it("idsEqual matches on both fields", () => {
    expect(idsEqual({ clock: 1, replicaId: "a" }, { clock: 1, replicaId: "a" })).toBe(true);
    expect(idsEqual({ clock: 1, replicaId: "a" }, { clock: 1, replicaId: "b" })).toBe(false);
    expect(idsEqual({ clock: 1, replicaId: "a" }, { clock: 2, replicaId: "a" })).toBe(false);
  });

  it("isRoot recognizes only ROOT", () => {
    expect(isRoot(ROOT)).toBe(true);
    expect(isRoot({ clock: 0, replicaId: "ROOT" })).toBe(true);
    expect(isRoot({ clock: 1, replicaId: "a" })).toBe(false);
  });
});

describe("LamportClock", () => {
  it("ticks strictly upward for local ops", () => {
    const c = new LamportClock();
    expect(c.tick()).toBe(1);
    expect(c.tick()).toBe(2);
    expect(c.peek()).toBe(2);
  });

  it("advances to max(local, remote) + 1 on receive, never backward", () => {
    const c = new LamportClock(3);
    expect(c.receive(10)).toBe(11); // remote ahead
    expect(c.receive(4)).toBe(12); // remote behind → still advances
    expect(c.peek()).toBe(12);
  });

  it("restore sets an exact value (snapshot rehydration)", () => {
    const c = new LamportClock(5);
    c.restore(0);
    expect(c.peek()).toBe(0);
    expect(c.tick()).toBe(1);
  });
});

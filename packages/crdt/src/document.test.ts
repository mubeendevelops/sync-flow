import { describe, it, expect } from "vitest";
import { makeDoc } from "./harness.js";
import { localInsert, localDelete, OP_VERSION } from "./operations.js";
import { ROOT, encodeId } from "./id.js";
import { RGADocument, SNAPSHOT_VERSION, type DocumentSnapshot } from "./document.js";

describe("RGADocument.has", () => {
  it("is true for an integrated char id and false for an unknown one", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    expect(doc.has(a.charId)).toBe(true);
    expect(doc.has({ clock: 999, replicaId: "nobody" })).toBe(false);
  });
});

describe("RGADocument.nearestVisibleLeft", () => {
  it("returns null for ROOT", () => {
    const doc = makeDoc("r1");
    expect(doc.nearestVisibleLeft(ROOT)).toBeNull();
  });

  it("returns null for an id the document has never seen", () => {
    const doc = makeDoc("r1");
    expect(doc.nearestVisibleLeft({ clock: 42, replicaId: "ghost" })).toBeNull();
  });

  it("returns the id itself when it is currently visible", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    expect(doc.nearestVisibleLeft(a.charId)).toEqual(a.charId);
  });

  it("walks left past one or more tombstones to the nearest surviving char", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    localInsert(doc, 1, "b");
    const c = localInsert(doc, 2, "c");
    // Delete "b" and "c"; a cursor anchored at "c" should resolve back to "a".
    localDelete(doc, 2);
    localDelete(doc, 1);
    expect(doc.nearestVisibleLeft(c.charId)).toEqual(a.charId);
  });

  it("returns null when every char at and left of the target is deleted", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    localDelete(doc, 0);
    expect(doc.nearestVisibleLeft(a.charId)).toBeNull();
  });
});

describe("RGADocument snapshot round trip via encodeId (sanity for test helpers above)", () => {
  it("encodes ids the same way toSnapshot does", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    expect(doc.toSnapshot().chars[0]!.id).toBe(encodeId(a.charId));
  });
});

describe("RGADocument delete/revive of ROOT are a no-op", () => {
  it("integrateDelete on ROOT does nothing (ROOT is never a real char)", () => {
    const doc = makeDoc("r1");
    const result = doc.integrateDelete({
      type: "delete",
      charId: ROOT,
      clock: doc.clock.tick(),
      replicaId: doc.replicaId,
      opVersion: OP_VERSION,
    });
    expect(result).toBe("noop");
  });

  it("integrateRevive on ROOT does nothing (ROOT is never a real char)", () => {
    const doc = makeDoc("r1");
    const result = doc.integrateRevive({
      type: "revive",
      charId: ROOT,
      clock: doc.clock.tick(),
      replicaId: doc.replicaId,
      opVersion: OP_VERSION,
    });
    expect(result).toBe("noop");
  });
});

describe("RGADocument.fromSnapshot", () => {
  it("defaults a v1 snapshot char's visibility stamp to its own id when visId is absent", () => {
    const doc = makeDoc("r1");
    const a = localInsert(doc, 0, "a");
    const v1Snapshot: DocumentSnapshot = {
      v: SNAPSHOT_VERSION,
      clock: doc.clock.peek(),
      chars: doc.toSnapshot().chars.map(({ visId: _visId, ...rest }) => rest),
    };
    const rehydrated = RGADocument.fromSnapshot(v1Snapshot, { replicaId: "r2", authorId: "u2" });
    expect(rehydrated.text()).toBe("a");
    // The char defaulted its visibility stamp to its own id, so a delete with a lower
    // stamp than that id would be a no-op — proven indirectly via text() staying "a"
    // after a stale delete attempt with clock 0 (always outranked by a real char id).
    rehydrated.integrateDelete({
      type: "delete",
      charId: a.charId,
      clock: 0,
      replicaId: "zzz-lowest",
      opVersion: OP_VERSION,
    });
    expect(rehydrated.text()).toBe("a");
  });
});

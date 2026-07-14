import { describe, expect, it } from "vitest";
import { encodeId, OP_VERSION, type DeleteOp, type InsertOp, type ReviveOp } from "@sync-flow/crdt";
import { opToRowValues, rowToOp, type OperationRow } from "./row-mapping.js";

const insertOp: InsertOp = {
  type: "insert",
  charId: { clock: 2, replicaId: "r1" },
  afterId: { clock: 1, replicaId: "r1" },
  value: "a",
  authorId: "user-1",
  timestamp: 1234,
  opVersion: OP_VERSION,
};

const deleteOp: DeleteOp = {
  type: "delete",
  charId: { clock: 2, replicaId: "r1" },
  clock: 3,
  replicaId: "r2",
  opVersion: OP_VERSION,
};

const reviveOp: ReviveOp = {
  type: "revive",
  charId: { clock: 2, replicaId: "r1" },
  clock: 4,
  replicaId: "r2",
  opVersion: OP_VERSION,
};

describe("opToRowValues", () => {
  it("maps an insert op, using the char's own clock/replica as identity", () => {
    const row = opToRowValues("doc-1", { op: insertOp, userId: "user-1" });
    expect(row).toMatchObject({
      op_type: "insert",
      char_id: encodeId(insertOp.charId),
      after_id: encodeId(insertOp.afterId),
      value: "a",
      replica_id: "r1",
      lamport_clock: 2,
      user_id: "user-1",
    });
  });

  it("maps a delete op, using the actor's clock/replica, with no after_id/value", () => {
    const row = opToRowValues("doc-1", { op: deleteOp, userId: "user-2" });
    expect(row).toMatchObject({
      op_type: "delete",
      char_id: encodeId(deleteOp.charId),
      after_id: null,
      value: null,
      replica_id: "r2",
      lamport_clock: 3,
      user_id: "user-2",
    });
  });

  it("maps a revive op the same shape as a delete, with its own discriminant", () => {
    const row = opToRowValues("doc-1", { op: reviveOp, userId: null });
    expect(row).toMatchObject({
      op_type: "revive",
      char_id: encodeId(reviveOp.charId),
      after_id: null,
      value: null,
      replica_id: "r2",
      lamport_clock: 4,
      user_id: null,
    });
  });
});

describe("rowToOp", () => {
  const baseRow = {
    replica_id: "r2",
    lamport_clock: "5",
    op_version: OP_VERSION,
    user_id: "user-1",
    created_at: new Date(1000),
  };

  it("decodes an insert row back into an InsertOp", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "insert",
      char_id: encodeId(insertOp.charId),
      after_id: encodeId(insertOp.afterId),
      value: "a",
    };
    expect(rowToOp(row)).toMatchObject({ type: "insert", value: "a", authorId: "user-1" });
  });

  it("defaults authorId to empty string when user_id is NULL (user hard-deleted)", () => {
    const row: OperationRow = {
      ...baseRow,
      user_id: null,
      op_type: "insert",
      char_id: encodeId(insertOp.charId),
      after_id: encodeId(insertOp.afterId),
      value: "a",
    };
    expect(rowToOp(row)).toMatchObject({ authorId: "" });
  });

  it("throws on a corrupt insert row missing after_id/value", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "insert",
      char_id: encodeId(insertOp.charId),
      after_id: null,
      value: null,
    };
    expect(() => rowToOp(row)).toThrow(/corrupt insert row/);
  });

  it("decodes a delete row back into a DeleteOp", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "delete",
      char_id: encodeId(deleteOp.charId),
      after_id: null,
      value: null,
    };
    expect(rowToOp(row)).toMatchObject({ type: "delete", clock: 5, replicaId: "r2" });
  });

  it("decodes a revive row back into a ReviveOp", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "revive",
      char_id: encodeId(reviveOp.charId),
      after_id: null,
      value: null,
    };
    expect(rowToOp(row)).toMatchObject({ type: "revive", clock: 5, replicaId: "r2" });
  });
});

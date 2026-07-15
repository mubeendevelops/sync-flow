import { describe, expect, it } from "vitest";
import {
  encodeId,
  OP_VERSION,
  type DeleteOp,
  type InsertOp,
  type ReviveOp,
  type FormatOp,
} from "@sync-flow/crdt";
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

const boldFormatOp: FormatOp = {
  type: "format",
  charId: { clock: 2, replicaId: "r1" },
  key: "bold",
  value: true,
  clock: 5,
  replicaId: "r2",
  opVersion: OP_VERSION,
};

const linkFormatOp: FormatOp = {
  type: "format",
  charId: { clock: 2, replicaId: "r1" },
  key: "link",
  value: "https://example.com",
  clock: 6,
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

  it("maps a boolean format op, serializing `true` to text and carrying format_key", () => {
    const row = opToRowValues("doc-1", { op: boldFormatOp, userId: "user-2" });
    expect(row).toMatchObject({
      op_type: "format",
      char_id: encodeId(boldFormatOp.charId),
      after_id: null,
      value: "true",
      format_key: "bold",
      replica_id: "r2",
      lamport_clock: 5,
    });
  });

  it("maps a string-valued format op (link) verbatim", () => {
    const row = opToRowValues("doc-1", { op: linkFormatOp, userId: "user-2" });
    expect(row).toMatchObject({
      op_type: "format",
      value: "https://example.com",
      format_key: "link",
    });
  });

  it("maps a cleared format op (value null) to a null column", () => {
    const cleared: FormatOp = { ...boldFormatOp, value: null };
    const row = opToRowValues("doc-1", { op: cleared, userId: "user-2" });
    expect(row).toMatchObject({ value: null, format_key: "bold" });
  });
});

describe("rowToOp", () => {
  const baseRow = {
    replica_id: "r2",
    lamport_clock: "5",
    op_version: OP_VERSION,
    user_id: "user-1",
    created_at: new Date(1000),
    format_key: null,
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

  it("decodes a boolean format row (bold) back to value `true`, not the string \"true\"", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "format",
      char_id: encodeId(boldFormatOp.charId),
      after_id: null,
      value: "true",
      format_key: "bold",
    };
    const op = rowToOp(row);
    expect(op).toMatchObject({ type: "format", key: "bold", value: true, clock: 5 });
  });

  it("decodes a cleared boolean format row (value NULL) back to null", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "format",
      char_id: encodeId(boldFormatOp.charId),
      after_id: null,
      value: null,
      format_key: "bold",
    };
    expect(rowToOp(row)).toMatchObject({ type: "format", key: "bold", value: null });
  });

  it("decodes a string-valued format row (link) verbatim, not coerced to boolean", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "format",
      char_id: encodeId(linkFormatOp.charId),
      after_id: null,
      value: "https://example.com",
      format_key: "link",
    };
    expect(rowToOp(row)).toMatchObject({
      type: "format",
      key: "link",
      value: "https://example.com",
    });
  });

  it("throws on a corrupt format row missing format_key", () => {
    const row: OperationRow = {
      ...baseRow,
      op_type: "format",
      char_id: encodeId(boldFormatOp.charId),
      after_id: null,
      value: "true",
      format_key: null,
    };
    expect(() => rowToOp(row)).toThrow(/corrupt format row/);
  });
});

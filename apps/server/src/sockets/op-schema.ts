/**
 * Runtime validation of client-supplied ops. The CRDT trusts its inputs; the socket
 * boundary does not — every inbound op is shape-, size-, and version-checked here
 * before it is ever applied. A malformed op is rejected (throws `AppError.badRequest`),
 * never partially applied.
 *
 * Wire note: an `Op` crosses the wire as JSON with `CharId` as a nested
 * `{ clock, replicaId }` object (the same value `packages/crdt` mints on the client),
 * NOT the encoded `"<clock>@<uuid>"` string — that encoding is only for storage/compare.
 */

import { z } from "zod";
import { OP_VERSION, type Op } from "@sync-flow/crdt";
import { AppError } from "../errors/app-error.js";

/** Cap a single `edit` batch so one frame of coalesced keystrokes can't be unbounded. */
export const MAX_OPS_PER_EDIT = 256;
const MAX_ID_LEN = 64; // uuid (36) or "ROOT", with headroom
const MAX_AUTHOR_LEN = 128;

const charIdSchema = z.object({
  clock: z.number().int().min(0),
  replicaId: z.string().min(1).max(MAX_ID_LEN),
});

/** Exactly one Unicode code point (matches `localInsert`'s `[...char].length === 1`). */
const singleCharSchema = z.string().refine((s) => [...s].length === 1, {
  message: "value must be exactly one character",
});

const opVersionSchema = z.literal(OP_VERSION);

const insertOpSchema = z.object({
  type: z.literal("insert"),
  charId: charIdSchema,
  afterId: charIdSchema,
  value: singleCharSchema,
  authorId: z.string().max(MAX_AUTHOR_LEN),
  timestamp: z.number().finite(),
  opVersion: opVersionSchema,
});

const deleteOpSchema = z.object({
  type: z.literal("delete"),
  charId: charIdSchema,
  clock: z.number().int().min(0),
  replicaId: z.string().min(1).max(MAX_ID_LEN),
  opVersion: opVersionSchema,
});

const MAX_FORMAT_KEY_LEN = 64;

// NOTE: `revive` is deliberately NOT in this union. Per CLAUDE.md, revive ops are minted only
// server-side (the undo/redo socket handlers) — never accepted from a client's `edit` payload.
// Adding it here would let a client forge a revive of any known char id, bypassing the
// undo/redo flow's own bookkeeping (Redis undo/redo stacks) to resurrect content another user
// deliberately deleted.
const formatOpSchema = z.object({
  type: z.literal("format"),
  charId: charIdSchema,
  key: z.string().min(1).max(MAX_FORMAT_KEY_LEN),
  value: z.union([z.string().max(MAX_AUTHOR_LEN), z.boolean(), z.null()]),
  clock: z.number().int().min(0),
  replicaId: z.string().min(1).max(MAX_ID_LEN),
  opVersion: opVersionSchema,
});

const opSchema = z.discriminatedUnion("type", [insertOpSchema, deleteOpSchema, formatOpSchema]);

const editOpsSchema = z.array(opSchema).min(1).max(MAX_OPS_PER_EDIT);

/**
 * Validate an `edit` payload's `ops` field into a typed `Op[]`, or throw
 * `AppError.badRequest` with a field-level detail. The parsed objects match the
 * CRDT `Op` shape exactly, so the single cast at this boundary is sound.
 */
export function parseEditPayload(rawOps: unknown): Op[] {
  const result = editOpsSchema.safeParse(rawOps);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    throw AppError.badRequest(
      `Invalid op payload${path ? ` at ${path}` : ""}: ${first?.message ?? "malformed"}`,
    );
  }
  return result.data as Op[];
}

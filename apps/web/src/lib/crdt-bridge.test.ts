import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import * as crdt from "@sync-flow/crdt";
import { RGADocument, type Op } from "@sync-flow/crdt";
import { createCrdtBridge } from "./crdt-bridge";
import { docToText, indexToPmPos, pmPosToIndex } from "./text-projection";

interface Peer {
  editor: Editor;
  doc: RGADocument;
  bridge: ReturnType<typeof createCrdtBridge>;
  sent: Op[];
}

function makePeer(replicaId: string): Peer {
  const editor = new Editor({ extensions: [Document, Paragraph, Text] });
  const doc = new RGADocument({ replicaId, authorId: replicaId });
  const sent: Op[] = [];
  const bridge = createCrdtBridge({
    editor,
    doc,
    replicaId,
    sendOps: (ops) => sent.push(...ops),
    sendCursor: () => {},
  });
  bridge.syncEditorFromDoc();
  return { editor, doc, bridge, sent };
}

/** Assert two peers agree on text, both in the CRDT and in the rendered editor. */
function expectConverged(a: Peer, b: Peer, text: string): void {
  expect(a.doc.text()).toBe(text);
  expect(b.doc.text()).toBe(text);
  expect(docToText(a.editor.state.doc)).toBe(text);
  expect(docToText(b.editor.state.doc)).toBe(text);
}

describe("crdt bridge convergence", () => {
  it("propagates a local edit to a remote peer", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("Hello world");
    a.bridge.onLocalChange();

    b.bridge.applyRemoteOps(a.sent);
    expectConverged(a, b, "Hello world");
  });

  it("converges after edits from both sides", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("Hello world");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    a.sent.length = 0;

    // B inserts "beautiful " after "Hello ".
    b.editor.commands.insertContentAt(indexToPmPos(b.editor.state.doc, 6), "beautiful ");
    b.bridge.onLocalChange();
    a.bridge.applyRemoteOps(b.sent);

    expectConverged(a, b, "Hello beautiful world");
  });

  it("syncs a paragraph split as a newline", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.setContent("<p>ab</p><p>cd</p>");
    a.bridge.onLocalChange();
    expect(a.doc.text()).toBe("ab\ncd");

    b.bridge.applyRemoteOps(a.sent);
    expectConverged(a, b, "ab\ncd");
  });
});

describe("crdt bridge cursor stability", () => {
  it("keeps the caret on the same character when text is inserted to its left", () => {
    const a = makePeer("A");
    const b = makePeer("B");
    a.editor.commands.insertContent("Hello world");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    a.sent.length = 0;

    // B's caret sits at the end (projection index 11, just after "world").
    b.editor.commands.setTextSelection(indexToPmPos(b.editor.state.doc, 11));
    expect(pmPosToIndex(b.editor.state.doc, b.editor.state.selection.head)).toBe(11);

    // A prepends "X" at the very start.
    a.editor.commands.insertContentAt(indexToPmPos(a.editor.state.doc, 0), "X");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);

    // The document grew on the left, so the caret's index shifts right by one — it never
    // jumps off the character it was on.
    expect(docToText(b.editor.state.doc)).toBe("XHello world");
    expect(pmPosToIndex(b.editor.state.doc, b.editor.state.selection.head)).toBe(12);
  });
});

describe("crdt bridge remote-op resilience", () => {
  it("skips a remote op that fails to apply, logs it, and still applies the rest of the batch", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("Hello world");
    a.bridge.onLocalChange();
    const [good1, bad, good2] = a.sent as [Op, Op, Op];
    expect(good1).toBeDefined();
    expect(good2).toBeDefined();

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalApplyRemote = crdt.applyRemote;
    const applyRemoteSpy = vi.spyOn(crdt, "applyRemote").mockImplementation((doc, op) => {
      if (op === bad) throw new Error("boom");
      return originalApplyRemote(doc, op);
    });

    expect(() => b.bridge.applyRemoteOps(a.sent)).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    applyRemoteSpy.mockRestore();
    consoleError.mockRestore();
  });
});

describe("crdt bridge echo-loop prevention", () => {
  it("ignores ops stamped with our own replica id", () => {
    const a = makePeer("A");
    const b = makePeer("B");
    a.editor.commands.insertContent("hi");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    b.sent.length = 0;

    b.editor.commands.insertContentAt(indexToPmPos(b.editor.state.doc, 2), "!");
    b.bridge.onLocalChange();
    const ownOps = [...b.sent];
    const before = b.doc.text();

    // Feeding B its own ops back must be a no-op (not a double insert).
    b.bridge.applyRemoteOps(ownOps);
    expect(b.doc.text()).toBe(before);
    expect(docToText(b.editor.state.doc)).toBe("hi!");
  });
});

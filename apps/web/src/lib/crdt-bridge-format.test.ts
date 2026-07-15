import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Heading } from "@tiptap/extension-heading";
import { RGADocument, type Op } from "@sync-flow/crdt";
import { createCrdtBridge, hydrateDocument } from "./crdt-bridge";
import { indexToPmPos, collectProjectedChars } from "./text-projection";

interface Peer {
  editor: Editor;
  doc: RGADocument;
  bridge: ReturnType<typeof createCrdtBridge>;
  sent: Op[];
}

const EXTENSIONS = [Document, Paragraph, Text, Bold, Italic, Heading.configure({ levels: [1, 2, 3] })];

function makePeer(replicaId: string): Peer {
  const editor = new Editor({ extensions: EXTENSIONS });
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

/** Rebuild a peer from `snapshot` under a fresh identity — simulates a page reload/rejoin. */
function reload(source: Peer, replicaId: string): Peer {
  const editor = new Editor({ extensions: EXTENSIONS });
  const doc = hydrateDocument(source.doc.toSnapshot(), { replicaId, authorId: replicaId });
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

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("formatting: bold word sync + reload", () => {
  it("User A bolds a word, User B receives and displays it bold, and it survives both reloading", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("hello world");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    a.sent.length = 0;
    b.sent.length = 0;

    // Bold "hello" (projection indices 0..5).
    a.editor
      .chain()
      .setTextSelection({ from: indexToPmPos(a.editor.state.doc, 0), to: indexToPmPos(a.editor.state.doc, 5) })
      .toggleBold()
      .run();
    a.bridge.onLocalChange();
    expect(a.sent.length).toBeGreaterThan(0);

    b.bridge.applyRemoteOps(a.sent);

    const bChars = collectProjectedChars(b.editor.state.doc);
    expect(bChars.slice(0, 5).every((c) => c.marks.bold === true)).toBe(true);
    expect(bChars.slice(5).some((c) => c.marks.bold === true)).toBe(false);

    // Both reload (fresh doc rebuilt from a snapshot, fresh editor synced from it).
    const aReloaded = reload(a, "A2");
    const bReloaded = reload(b, "B2");
    for (const p of [aReloaded, bReloaded]) {
      const chars = collectProjectedChars(p.editor.state.doc);
      expect(chars.slice(0, 5).every((c) => c.marks.bold === true)).toBe(true);
      expect(chars.slice(5).some((c) => c.marks.bold === true)).toBe(false);
    }
  });
});

describe("formatting: block type sync", () => {
  it("User A changes a paragraph to Heading 1 and User B sees it immediately", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("Title");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    a.sent.length = 0;

    expect(b.editor.state.doc.firstChild?.type.name).toBe("paragraph");

    a.editor.chain().setTextSelection(1).toggleHeading({ level: 1 }).run();
    a.bridge.onLocalChange();
    expect(a.sent.length).toBeGreaterThan(0);

    b.bridge.applyRemoteOps(a.sent);

    const heading = b.editor.state.doc.firstChild;
    expect(heading?.type.name).toBe("heading");
    expect(heading?.attrs.level).toBe(1);
    expect(heading?.textContent).toBe("Title");
  });
});

describe("formatting: concurrent overlapping marks converge", () => {
  it("A bolds [0,2) and B italicizes [1,3) concurrently — every delivery order converges to the same per-char formatting", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("abc");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    const baseOps = [...a.sent];
    a.sent.length = 0;
    b.sent.length = 0;

    // Concurrent, non-overlapping-in-origin edits: A bolds chars [0,1], B italicizes [1,2].
    // Char 1 ("b") is the overlap — it must end up BOTH bold and italic on every replica.
    a.editor
      .chain()
      .setTextSelection({ from: indexToPmPos(a.editor.state.doc, 0), to: indexToPmPos(a.editor.state.doc, 2) })
      .toggleBold()
      .run();
    a.bridge.onLocalChange();
    const boldOps = [...a.sent];

    b.editor
      .chain()
      .setTextSelection({ from: indexToPmPos(b.editor.state.doc, 1), to: indexToPmPos(b.editor.state.doc, 3) })
      .toggleItalic()
      .run();
    b.bridge.onLocalChange();
    const italicOps = [...b.sent];

    expect(boldOps.length).toBeGreaterThan(0);
    expect(italicOps.length).toBeGreaterThan(0);

    const expected = [
      { bold: true, italic: undefined },
      { bold: true, italic: true },
      { bold: undefined, italic: true },
    ];

    const allOps = [...baseOps, ...boldOps, ...italicOps];
    for (let seed = 1; seed <= 10; seed += 1) {
      const observer = makePeer(`observer-${seed}`);
      observer.bridge.applyRemoteOps(shuffle(allOps, seed));

      expect(observer.doc.text()).toBe("abc");
      const chars = collectProjectedChars(observer.editor.state.doc);
      expect(chars.map((c) => ({ bold: c.marks.bold, italic: c.marks.italic }))).toEqual(expected);
    }
  });
});

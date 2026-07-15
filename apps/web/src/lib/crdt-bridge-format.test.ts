import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Strike } from "@tiptap/extension-strike";
import { Highlight } from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Heading } from "@tiptap/extension-heading";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { RGADocument, type Op } from "@sync-flow/crdt";
import { createCrdtBridge, hydrateDocument } from "./crdt-bridge";
import { indexToPmPos, collectProjectedChars, collectBlockInfos } from "./text-projection";

interface Peer {
  editor: Editor;
  doc: RGADocument;
  bridge: ReturnType<typeof createCrdtBridge>;
  sent: Op[];
}

const EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Bold,
  Italic,
  Strike,
  TextStyle,
  Color,
  Highlight.configure({ multicolor: true }),
  Heading.configure({ levels: [1, 2, 3] }),
  TaskList,
  TaskItem.configure({ nested: true }),
];

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

describe("formatting: highlight sync + reload", () => {
  it("User A highlights a word yellow, User B sees it immediately, and it survives both reloading", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("hello world");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    a.sent.length = 0;
    b.sent.length = 0;

    // Highlight "hello" (projection indices 0..5) yellow.
    a.editor
      .chain()
      .setTextSelection({ from: indexToPmPos(a.editor.state.doc, 0), to: indexToPmPos(a.editor.state.doc, 5) })
      .setHighlight({ color: "#facc15" })
      .run();
    a.bridge.onLocalChange();
    expect(a.sent.length).toBeGreaterThan(0);

    b.bridge.applyRemoteOps(a.sent);

    const bChars = collectProjectedChars(b.editor.state.doc);
    expect(bChars.slice(0, 5).every((c) => c.marks.highlight === "#facc15")).toBe(true);
    expect(bChars.slice(5).some((c) => c.marks.highlight)).toBe(false);

    // Both reload (fresh doc rebuilt from a snapshot, fresh editor synced from it).
    const aReloaded = reload(a, "A2");
    const bReloaded = reload(b, "B2");
    for (const p of [aReloaded, bReloaded]) {
      const chars = collectProjectedChars(p.editor.state.doc);
      expect(chars.slice(0, 5).every((c) => c.marks.highlight === "#facc15")).toBe(true);
      expect(chars.slice(5).some((c) => c.marks.highlight)).toBe(false);
    }
  });
});

describe("formatting: task checkbox sync", () => {
  it("User A checks a task item's checkbox and User B sees it checked immediately", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("buy milk");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    a.sent.length = 0;
    b.sent.length = 0;

    // Both sides already have identical taskList structure locally — task-list STRUCTURE
    // isn't (yet) CRDT-synced (see crdt-bridge.ts), so this simulates a document that already
    // has the checklist; only the live `checked` sync is under test here. Wrapping the block
    // doesn't touch the flat text projection (still one block, anchored at ROOT), so the CRDT
    // anchor both sides mint the format op against stays identical.
    a.editor.chain().toggleTaskList().run();
    b.editor.chain().toggleTaskList().run();
    a.bridge.onLocalChange();
    b.bridge.onLocalChange();
    a.sent.length = 0;
    b.sent.length = 0;

    expect(collectBlockInfos(a.editor.state.doc)[0]?.taskItem?.checked).toBe(false);
    expect(collectBlockInfos(b.editor.state.doc)[0]?.taskItem?.checked).toBe(false);

    // A checks the box — the same transaction the checkbox NodeView itself dispatches.
    const taskItemPos = collectBlockInfos(a.editor.state.doc)[0]!.taskItem!.pos;
    a.editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(taskItemPos, "checked", true);
      return true;
    });
    a.bridge.onLocalChange();
    expect(a.sent.length).toBeGreaterThan(0);

    b.bridge.applyRemoteOps(a.sent);

    expect(collectBlockInfos(b.editor.state.doc)[0]?.taskItem?.checked).toBe(true);
  });
});

describe("formatting: concurrent overlapping strike + textColor converge", () => {
  it("A strikes [0,2) and B colors [1,3) concurrently — every delivery order converges to the same per-char formatting", () => {
    const a = makePeer("A");
    const b = makePeer("B");

    a.editor.commands.insertContent("abc");
    a.bridge.onLocalChange();
    b.bridge.applyRemoteOps(a.sent);
    const baseOps = [...a.sent];
    a.sent.length = 0;
    b.sent.length = 0;

    // Concurrent, non-overlapping-in-origin edits: A strikes chars [0,1], B colors [1,2].
    // Char 1 ("b") is the overlap — it must end up BOTH struck-through and colored everywhere.
    a.editor
      .chain()
      .setTextSelection({ from: indexToPmPos(a.editor.state.doc, 0), to: indexToPmPos(a.editor.state.doc, 2) })
      .toggleStrike()
      .run();
    a.bridge.onLocalChange();
    const strikeOps = [...a.sent];

    b.editor
      .chain()
      .setTextSelection({ from: indexToPmPos(b.editor.state.doc, 1), to: indexToPmPos(b.editor.state.doc, 3) })
      .setColor("#60a5fa")
      .run();
    b.bridge.onLocalChange();
    const colorOps = [...b.sent];

    expect(strikeOps.length).toBeGreaterThan(0);
    expect(colorOps.length).toBeGreaterThan(0);

    const expected = [
      { strike: true, textColor: undefined },
      { strike: true, textColor: "#60a5fa" },
      { strike: undefined, textColor: "#60a5fa" },
    ];

    const allOps = [...baseOps, ...strikeOps, ...colorOps];
    for (let seed = 1; seed <= 10; seed += 1) {
      const observer = makePeer(`observer-${seed}`);
      observer.bridge.applyRemoteOps(shuffle(allOps, seed));

      expect(observer.doc.text()).toBe("abc");
      const chars = collectProjectedChars(observer.editor.state.doc);
      expect(chars.map((c) => ({ strike: c.marks.strike, textColor: c.marks.textColor }))).toEqual(expected);
    }
  });
});

import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import {
  RemoteCursors,
  remoteCursorKey,
  setRemoteCursor,
  removeRemoteCursor,
} from "./remote-cursors";

function makeEditor(): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, RemoteCursors],
    content: "<p>Hello world</p>",
  });
}

function state(editor: Editor) {
  const s = remoteCursorKey.getState(editor.state);
  if (!s) throw new Error("plugin state missing");
  return s;
}

describe("remote cursors", () => {
  it("renders a single caret decoration for a collapsed selection", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 3, 3, "#ff0000", "Alice");

    const s = state(editor);
    expect(s.peers.get("u1")).toMatchObject({ anchor: 3, head: 3, name: "Alice" });
    expect(s.decorations.find()).toHaveLength(1); // caret only, no selection wash
    editor.destroy();
  });

  it("adds a selection highlight alongside the caret when anchor != head", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 2, 6, "#00ff00", "Bob");

    // One inline selection decoration + one caret widget.
    expect(state(editor).decorations.find()).toHaveLength(2);
    editor.destroy();
  });

  it("bumps a peer's version on each move (restarts the label fade)", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 2, 2, "#0000ff", "Cy");
    const v1 = state(editor).peers.get("u1")!.version;
    setRemoteCursor(editor, "u1", 5, 5, "#0000ff", "Cy");
    const v2 = state(editor).peers.get("u1")!.version;
    expect(v2).toBe(v1 + 1);
    editor.destroy();
  });

  it("removes a peer's decorations when they leave", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 3, 3, "#ff0000", "Alice");
    removeRemoteCursor(editor, "u1");

    const s = state(editor);
    expect(s.peers.size).toBe(0);
    expect(s.decorations.find()).toHaveLength(0);
    editor.destroy();
  });

  it("treats a null position as a removal", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 3, 3, "#ff0000", "Alice");
    setRemoteCursor(editor, "u1", null, null, "#ff0000", "Alice");
    expect(state(editor).peers.size).toBe(0);
    editor.destroy();
  });

  it("skips decorations for out-of-range positions", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 999, 999, "#000000", "X");
    // The peer is recorded but nothing is painted (position past the doc).
    expect(state(editor).decorations.find()).toHaveLength(0);
    editor.destroy();
  });

  it("keeps a caret tracking the text as the document grows to its left", () => {
    const editor = makeEditor();
    setRemoteCursor(editor, "u1", 6, 6, "#ff0000", "Alice");
    // Insert 3 chars at the very start of the paragraph (pos 1).
    editor.commands.insertContentAt(1, "XYZ");
    // The caret remapped forward by 3 without a cursor update.
    expect(state(editor).peers.get("u1")!.head).toBe(9);
    editor.destroy();
  });
});

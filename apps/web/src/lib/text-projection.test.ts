import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import {
  docToText,
  indexToPmPos,
  pmPosToIndex,
  diffText,
  buildRemoteTransaction,
} from "./text-projection";

function makeEditor(content?: string): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, Heading.configure({ levels: [1, 2, 3] })],
    content,
  });
}

describe("docToText", () => {
  it("joins block text with a single newline", () => {
    const editor = makeEditor("<p>Hello</p><p>World</p>");
    expect(docToText(editor.state.doc)).toBe("Hello\nWorld");
    editor.destroy();
  });

  it("represents an empty paragraph as an empty line", () => {
    const editor = makeEditor("<p>a</p><p></p><p>b</p>");
    expect(docToText(editor.state.doc)).toBe("a\n\nb");
    editor.destroy();
  });
});

describe("index <-> PM position round-trips", () => {
  it("is a bijection across every projection index", () => {
    const editor = makeEditor("<h1>Title</h1><p>Body text</p><p>More</p>");
    const text = docToText(editor.state.doc);
    for (let i = 0; i <= text.length; i++) {
      const pos = indexToPmPos(editor.state.doc, i);
      expect(pmPosToIndex(editor.state.doc, pos)).toBe(i);
    }
    editor.destroy();
  });
});

describe("diffText", () => {
  it("returns null for equal strings", () => {
    expect(diffText("abc", "abc")).toBeNull();
  });
  it("detects a pure insertion", () => {
    expect(diffText("abc", "aXbc")).toEqual({ from: 1, deleted: 0, inserted: "X" });
  });
  it("detects a pure deletion", () => {
    expect(diffText("abc", "ac")).toEqual({ from: 1, deleted: 1, inserted: "" });
  });
  it("detects a replacement", () => {
    expect(diffText("hello", "help")).toEqual({ from: 3, deleted: 2, inserted: "p" });
  });
  it("handles append at the end", () => {
    expect(diffText("ab", "abcd")).toEqual({ from: 2, deleted: 0, inserted: "cd" });
  });
});

describe("buildRemoteTransaction", () => {
  const cases: Array<{ name: string; start: string; next: string }> = [
    { name: "insert mid-word", start: "<p>Helo</p>", next: "Hello" },
    { name: "delete a char", start: "<p>Hello</p>", next: "Hllo" },
    { name: "append to end", start: "<p>Hi</p>", next: "Hi there" },
    { name: "insert at start", start: "<p>world</p>", next: "hello world" },
    { name: "split a paragraph (newline)", start: "<p>abcd</p>", next: "ab\ncd" },
    { name: "join paragraphs (delete newline)", start: "<p>ab</p><p>cd</p>", next: "abcd" },
    { name: "add a whole new line", start: "<p>one</p>", next: "one\ntwo" },
  ];

  for (const { name, start, next } of cases) {
    it(name, () => {
      const editor = makeEditor(start);
      const diff = diffText(docToText(editor.state.doc), next);
      expect(diff).not.toBeNull();
      const tr = buildRemoteTransaction(editor.state, diff!);
      const newState = editor.state.apply(tr);
      expect(docToText(newState.doc)).toBe(next);
      editor.destroy();
    });
  }
});

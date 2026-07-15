/**
 * Slash-command menu: filtering, keyboard selection, the block transform, and — most
 * importantly — that the transient `/` + filter text never reaches the CRDT bridge.
 *
 * The task's end-to-end scenario ("type /head, arrow down to Heading 2, Enter → block is an
 * h2 and neither `/` nor the filter text is in the content") is covered across three
 * deterministic slices: `filterCommands` narrows to the headings, the menu's keyboard handle
 * moves to Heading 2 and Enter picks it, and the Heading-2 command deletes the `/…` range and
 * retypes the block as an h2. A fourth slice drives the REAL Suggestion plugin to prove the
 * trigger-position rule (empty block / after whitespace, never mid-word).
 */

import { createRef } from "react";
import { act } from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import { BulletList } from "@tiptap/extension-bullet-list";
import { OrderedList } from "@tiptap/extension-ordered-list";
import { ListItem } from "@tiptap/extension-list-item";
import { CodeBlock } from "@tiptap/extension-code-block";
import { RGADocument, type Op } from "@sync-flow/crdt";
import { createCrdtBridge } from "@/lib/crdt-bridge";
import { SLASH_COMMANDS, filterCommands } from "./commands";
import { SlashCommand, slashCommandPluginKey } from "./slash-command";
import { SlashCommandMenu, type SlashCommandMenuRef } from "./slash-command-menu";

// Tippy needs real layout it doesn't get in jsdom; the menu's DOM/behavior is what we test.
vi.mock("tippy.js", () => ({
  default: () => [{ setProps: () => {}, destroy: () => {} }],
}));

const heading2 = SLASH_COMMANDS.find((c) => c.id === "heading2")!;

function key(name: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name });
}

describe("filterCommands", () => {
  it("narrows to the headings for '/head' and preserves order", () => {
    const results = filterCommands("head");
    expect(results.map((c) => c.id)).toEqual(["heading1", "heading2", "heading3"]);
  });

  it("returns everything for an empty query and nothing unmatched", () => {
    expect(filterCommands("")).toHaveLength(SLASH_COMMANDS.length);
    expect(filterCommands("zzzznope")).toHaveLength(0);
  });

  it("matches on keywords, not just the title", () => {
    expect(filterCommands("todo").map((c) => c.id)).toEqual(["taskList"]);
    expect(filterCommands("unordered").map((c) => c.id)).toEqual(["bulletList"]);
  });
});

describe("SlashCommandMenu keyboard selection", () => {
  it("arrows down to Heading 2 and Enter selects it", () => {
    const items = filterCommands("head");
    const command = vi.fn();
    const ref = createRef<SlashCommandMenuRef>();
    render(<SlashCommandMenu items={items} command={command} ref={ref} />);

    // Starts highlighted at index 0 (Heading 1); one ArrowDown → Heading 2.
    act(() => {
      ref.current!.onKeyDown(key("ArrowDown"));
    });
    act(() => {
      ref.current!.onKeyDown(key("Enter"));
    });

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(items[1]);
    expect(items[1]!.id).toBe("heading2");
  });

  it("renders 'No results' when nothing matches", () => {
    const { getByText } = render(<SlashCommandMenu items={[]} command={vi.fn()} />);
    expect(getByText("No results")).toBeTruthy();
  });
});

describe("Heading 2 command transform", () => {
  it("deletes the '/…' range and retypes the block as an h2 with no slash text", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, Heading.configure({ levels: [1, 2, 3] })],
    });
    editor.commands.insertContent("/head");
    // Range spanning the '/head' in the (only) block: block content starts at pos 1.
    const to = 1 + editor.state.doc.firstChild!.content.size;

    heading2.run(editor, { from: 1, to });

    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe("heading");
    expect(first.attrs.level).toBe(2);
    expect(editor.state.doc.textContent).toBe("");
    expect(editor.state.doc.textContent).not.toContain("/");
    editor.destroy();
  });
});

describe("CRDT suppression — the slash + filter never become ops", () => {
  it("emits nothing for '/head' while the menu is open, then only the block transform", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, Heading.configure({ levels: [1, 2, 3] })],
    });
    const doc = new RGADocument({ replicaId: "local", authorId: "local" });
    const sent: Op[] = [];
    const controller = { active: false, onDismiss: undefined as (() => void) | undefined };
    const bridge = createCrdtBridge({
      editor,
      doc,
      replicaId: "local",
      sendOps: (ops) => sent.push(...ops),
      sendCursor: () => {},
      isSuppressed: () => controller.active,
    });
    controller.onDismiss = () => bridge.onLocalChange();
    bridge.syncEditorFromDoc();

    // Menu opens; user types the filter. Every onUpdate is suppressed.
    controller.active = true;
    editor.commands.insertContent("/head");
    bridge.onLocalChange();
    expect(sent).toHaveLength(0);

    // Pick Heading 2: the transform deletes '/head' + retypes the block; the menu closes and
    // flushes via onDismiss.
    controller.active = false;
    const to = 1 + editor.state.doc.firstChild!.content.size;
    heading2.run(editor, { from: 1, to });
    controller.onDismiss!();

    // No character of '/head' was ever inserted into the CRDT...
    expect(sent.filter((o) => o.type === "insert")).toHaveLength(0);
    expect(doc.text()).not.toContain("/");
    expect(doc.text()).toBe("");
    // ...only the block-type change reached the CRDT.
    const blockTypeOps = sent.filter((o) => o.type === "format" && o.key === "blockType");
    expect(blockTypeOps.length).toBeGreaterThan(0);
    expect(blockTypeOps.at(-1)).toMatchObject({ value: "heading2" });
    editor.destroy();
  });
});

describe("trigger-position rule (real Suggestion plugin)", () => {
  function makeEditor(): Editor {
    return new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        Heading.configure({ levels: [1, 2, 3] }),
        BulletList,
        OrderedList,
        ListItem,
        CodeBlock,
        SlashCommand.configure({ controller: { active: false } }),
      ],
    });
  }
  const isActive = (editor: Editor): boolean =>
    (slashCommandPluginKey.getState(editor.state) as { active?: boolean } | undefined)?.active ===
    true;

  it("activates at the start of an empty block", () => {
    const editor = makeEditor();
    editor.commands.insertContent("/");
    expect(isActive(editor)).toBe(true);
    editor.destroy();
  });

  it("activates after a whitespace character", () => {
    const editor = makeEditor();
    editor.commands.insertContent("hello /");
    expect(isActive(editor)).toBe(true);
    editor.destroy();
  });

  it("does NOT activate mid-word", () => {
    const editor = makeEditor();
    editor.commands.insertContent("ab/");
    expect(isActive(editor)).toBe(false);
    editor.destroy();
  });

  it("does NOT activate inside a code block", () => {
    const editor = makeEditor();
    editor.chain().setCodeBlock().insertContent("/").run();
    expect(isActive(editor)).toBe(false);
    editor.destroy();
  });
});

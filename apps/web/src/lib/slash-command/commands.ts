import type { Editor, Range } from "@tiptap/core";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  SquareCode,
  Table as TableIcon,
  Type,
  type LucideIcon,
} from "lucide-react";

/** One entry in the slash command menu. */
export interface SlashCommand {
  /** Stable id — also the cmdk item value used to drive keyboard highlighting. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** Extra terms (beyond the title) the filter matches against, e.g. "h1", "ul", "todo". */
  readonly keywords: readonly string[];
  /**
   * Apply the transformation. ALWAYS deletes the `/` + filter text first (so the slash never
   * survives), then re-types the current block. This is a standard TipTap transaction — the
   * only thing about the whole slash flow that reaches the CRDT bridge.
   */
  readonly run: (editor: Editor, range: Range) => void;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "paragraph",
    title: "Text",
    description: "Plain paragraph",
    icon: Type,
    keywords: ["paragraph", "text", "body", "p"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "heading1",
    title: "Heading 1",
    description: "Large section heading",
    icon: Heading1,
    keywords: ["h1", "title", "heading", "big"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    id: "heading2",
    title: "Heading 2",
    description: "Medium section heading",
    icon: Heading2,
    keywords: ["h2", "subtitle", "heading"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    id: "heading3",
    title: "Heading 3",
    description: "Small section heading",
    icon: Heading3,
    keywords: ["h3", "heading"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    id: "bulletList",
    title: "Bullet List",
    description: "Unordered list",
    icon: List,
    keywords: ["ul", "unordered", "bullet", "list"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "orderedList",
    title: "Numbered List",
    description: "Ordered list",
    icon: ListOrdered,
    keywords: ["ol", "ordered", "numbered", "list"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "taskList",
    title: "To-do List",
    description: "Checklist with checkboxes",
    icon: ListTodo,
    keywords: ["todo", "task", "checkbox", "checklist"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: "codeBlock",
    title: "Code Block",
    description: "Fenced code with a language label",
    icon: SquareCode,
    keywords: ["code", "pre", "fenced", "snippet"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    id: "blockquote",
    title: "Quote",
    description: "Blockquote callout",
    icon: Quote,
    keywords: ["quote", "blockquote", "callout"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: "horizontalRule",
    title: "Divider",
    description: "Horizontal rule",
    icon: Minus,
    keywords: ["divider", "hr", "rule", "separator", "line"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    id: "table",
    title: "Table",
    description: "3×3 table",
    icon: TableIcon,
    keywords: ["table", "grid", "rows", "columns"],
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
];

/** Case-insensitive filter by title + keywords. Empty query returns everything. */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((cmd) => {
    if (cmd.title.toLowerCase().includes(q)) return true;
    return cmd.keywords.some((k) => k.toLowerCase().includes(q));
  });
}

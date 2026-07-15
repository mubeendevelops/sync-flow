import type { Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Strikethrough,
  Type,
  Underline as UnderlineIcon,
} from "lucide-react";

export interface ToolbarItem {
  readonly label: string;
  readonly icon: typeof Bold;
  readonly shortcut?: string;
  readonly isActive: (editor: Editor) => boolean;
  readonly run: (editor: Editor) => void;
}

/** One entry in the paragraph-style dropdown (fixed toolbar's Group 1). */
export interface ParagraphStyleItem extends ToolbarItem {
  /** Stable id, also used as the dropdown's current-selection label lookup. */
  readonly id: string;
}

/** Paragraph-style dropdown: Text / H1-3 / Quote / Code Block — the fixed toolbar's Group 1. */
export const PARAGRAPH_STYLE_ITEMS: readonly ParagraphStyleItem[] = [
  {
    id: "paragraph",
    label: "Text",
    icon: Type,
    isActive: (editor) =>
      editor.isActive("paragraph") && !editor.isActive("heading") && !editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  {
    id: "heading1",
    label: "Heading 1",
    icon: Heading1,
    isActive: (editor) => editor.isActive("heading", { level: 1 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: "heading2",
    label: "Heading 2",
    icon: Heading2,
    isActive: (editor) => editor.isActive("heading", { level: 2 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: "heading3",
    label: "Heading 3",
    icon: Heading3,
    isActive: (editor) => editor.isActive("heading", { level: 3 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: "blockquote",
    label: "Quote",
    icon: Quote,
    isActive: (editor) => editor.isActive("blockquote"),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "codeBlock",
    label: "Code Block",
    icon: Code2,
    isActive: (editor) => editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
];

/** Inline text marks — the fixed toolbar's Group 2 and the floating toolbar's first four. */
export const MARK_ITEMS: readonly ToolbarItem[] = [
  {
    label: "Bold",
    icon: Bold,
    shortcut: "Ctrl+B",
    isActive: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    label: "Italic",
    icon: Italic,
    shortcut: "Ctrl+I",
    isActive: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    label: "Underline",
    icon: UnderlineIcon,
    shortcut: "Ctrl+U",
    isActive: (editor) => editor.isActive("underline"),
    run: (editor) => editor.chain().focus().toggleUnderline().run(),
  },
  {
    label: "Strikethrough",
    icon: Strikethrough,
    shortcut: "Ctrl+Shift+S",
    isActive: (editor) => editor.isActive("strike"),
    run: (editor) => editor.chain().focus().toggleStrike().run(),
  },
];

/** Inline code — its own toolbar entry (grouped with Link, not the bold/italic cluster). */
export const INLINE_CODE_ITEM: ToolbarItem = {
  label: "Inline code",
  icon: Code,
  shortcut: "Ctrl+E",
  isActive: (editor) => editor.isActive("code"),
  run: (editor) => editor.chain().focus().toggleCode().run(),
};

/** List types — the fixed toolbar's Group 4. */
export const LIST_ITEMS: readonly ToolbarItem[] = [
  {
    label: "Bullet list",
    icon: List,
    isActive: (editor) => editor.isActive("bulletList"),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    icon: ListOrdered,
    isActive: (editor) => editor.isActive("orderedList"),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "To-do list",
    icon: ListTodo,
    isActive: (editor) => editor.isActive("taskList"),
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
];

/** Link — paired with inline code in the fixed toolbar's Group 5 and the floating toolbar. */
export const LINK_ICON = Link2;

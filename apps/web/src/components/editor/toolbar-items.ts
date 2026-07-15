import type { Editor } from "@tiptap/react";
import { Bold, Code2, Heading1, Heading2, Heading3, Italic, List, ListOrdered } from "lucide-react";

export interface ToolbarItem {
  readonly label: string;
  readonly icon: typeof Bold;
  readonly isActive: (editor: Editor) => boolean;
  readonly run: (editor: Editor) => void;
}

/** Block-level formatting — the fixed toolbar's row on desktop, one section of the mobile
 * "Format" bottom sheet. */
export const BLOCK_ITEMS: readonly ToolbarItem[] = [
  {
    label: "Heading 1",
    icon: Heading1,
    isActive: (editor) => editor.isActive("heading", { level: 1 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    icon: Heading2,
    isActive: (editor) => editor.isActive("heading", { level: 2 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    icon: Heading3,
    isActive: (editor) => editor.isActive("heading", { level: 3 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
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
    label: "Code block",
    icon: Code2,
    isActive: (editor) => editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
];

/** Inline marks — the floating bubble menu's toggles on desktop, the other section of the
 * mobile "Format" sheet. Link is handled separately (it needs an inline URL editor). */
export const MARK_ITEMS: readonly ToolbarItem[] = [
  {
    label: "Bold",
    icon: Bold,
    isActive: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    label: "Italic",
    icon: Italic,
    isActive: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
];

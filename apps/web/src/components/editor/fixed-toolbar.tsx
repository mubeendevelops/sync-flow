"use client";

import type { Editor } from "@tiptap/react";
import { Heading1, Heading2, Heading3, List, ListOrdered, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ITEMS = [
  {
    label: "Heading 1",
    icon: Heading1,
    isActive: (editor: Editor) => editor.isActive("heading", { level: 1 }),
    run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    icon: Heading2,
    isActive: (editor: Editor) => editor.isActive("heading", { level: 2 }),
    run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    icon: Heading3,
    isActive: (editor: Editor) => editor.isActive("heading", { level: 3 }),
    run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: "Bullet list",
    icon: List,
    isActive: (editor: Editor) => editor.isActive("bulletList"),
    run: (editor: Editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    icon: ListOrdered,
    isActive: (editor: Editor) => editor.isActive("orderedList"),
    run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "Code block",
    icon: Code2,
    isActive: (editor: Editor) => editor.isActive("codeBlock"),
    run: (editor: Editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
] as const;

/** Fixed toolbar for block-level formatting — always visible, sticky under the document header. */
export function FixedToolbar({ editor }: { editor: Editor | null }) {
  return (
    <div className="sticky top-[65px] z-10 flex items-center justify-center gap-0.5 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      {ITEMS.map(({ label, icon: Icon, isActive, run }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", editor && isActive(editor) && "bg-accent text-accent-foreground")}
          aria-label={label}
          aria-pressed={editor ? isActive(editor) : false}
          disabled={!editor}
          onClick={() => editor && run(editor)}
        >
          <Icon className="h-4 w-4" />
        </Button>
      ))}
    </div>
  );
}

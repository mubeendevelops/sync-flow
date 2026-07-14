"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Italic, Link2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Floating toolbar for inline marks — appears above the selection on text highlight. */
export function FloatingToolbar({ editor }: { editor: Editor | null }) {
  const [editingLink, setEditingLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");

  if (!editor) return null;

  function openLinkEditor() {
    setLinkDraft(editor!.getAttributes("link").href ?? "");
    setEditingLink(true);
  }

  function commitLink() {
    const url = linkDraft.trim();
    if (url) {
      editor!.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      editor!.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setEditingLink(false);
  }

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", onHide: () => setEditingLink(false) }}
      shouldShow={({ editor: e, state }) => !e.isActive("codeBlock") && !state.selection.empty}
      className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {editingLink ? (
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitLink();
              } else if (e.key === "Escape") {
                setEditingLink(false);
              }
            }}
            placeholder="https://…"
            className="h-7 w-48 px-2 text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Apply link"
            onClick={commitLink}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", editor.isActive("bold") && "bg-accent text-accent-foreground")}
            aria-label="Bold"
            aria-pressed={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", editor.isActive("italic") && "bg-accent text-accent-foreground")}
            aria-label="Italic"
            aria-pressed={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", editor.isActive("link") && "bg-accent text-accent-foreground")}
            aria-label={editor.isActive("link") ? "Edit link" : "Add link"}
            aria-pressed={editor.isActive("link")}
            onClick={openLinkEditor}
          >
            <Link2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </BubbleMenu>
  );
}

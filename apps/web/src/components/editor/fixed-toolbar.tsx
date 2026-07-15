"use client";

import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BLOCK_ITEMS } from "@/components/editor/toolbar-items";

/** Fixed toolbar for block-level formatting — always visible, sticky under the document header.
 * Hidden below `sm` (390px-class viewports): `MobileFormatSheet` covers the same actions from a
 * single "Format" button + bottom sheet, since a 6-icon row doesn't fit that width. */
export function FixedToolbar({ editor }: { editor: Editor | null }) {
  return (
    <div className="sticky top-[65px] z-10 hidden items-center justify-center gap-0.5 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur sm:flex supports-[backdrop-filter]:bg-background/75">
      {BLOCK_ITEMS.map(({ label, icon: Icon, isActive, run }) => (
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

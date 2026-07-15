"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, Link2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/editor/toolbar-button";

/** Fixed toolbar's Link button (Group 5): a small popover with a URL field, same commit
 * semantics as the floating toolbar's inline link editor (`setLink`/`unsetLink`, both normal
 * mark commands that flow through the CRDT bridge like any other mark). */
export function LinkButton({ editor, className }: { editor: Editor; className?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(): void {
    const url = draft.trim();
    if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    else editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(false);
  }

  // DropdownMenuContent doesn't expose `onOpenAutoFocus` (Radix's DropdownMenu deliberately
  // omits it — see @radix-ui/react-menu's `MenuRootContentTypeProps`), so grab focus ourselves
  // one frame after open, after Radix's own initial-focus pass has run.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft((editor.getAttributes("link").href as string | undefined) ?? "");
      }}
    >
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          label={editor.isActive("link") ? "Edit link" : "Link"}
          shortcut="Ctrl+K"
          isActive={editor.isActive("link")}
          className={className}
        >
          <Link2 className="h-4 w-4" />
        </ToolbarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex w-64 items-center gap-1 p-1.5">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder="https://…"
          className="h-7 flex-1 px-2 text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Apply link"
          onClick={commit}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

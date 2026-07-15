"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, Link2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BLOCK_ITEMS, MARK_ITEMS } from "@/components/editor/toolbar-items";
import { cn } from "@/lib/utils";

/**
 * Mobile equivalent of `FixedToolbar` + `FloatingToolbar` combined: below `sm` (390px-class
 * viewports), a 6-icon row and a selection-tracking bubble menu don't fit/work well, so both are
 * replaced by one "Format" button that opens a bottom sheet with every formatting action.
 */
export function MobileFormatSheet({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");

  function openLinkEditor() {
    if (!editor) return;
    setLinkDraft(editor.getAttributes("link").href ?? "");
    setEditingLink(true);
  }

  function commitLink() {
    if (!editor) return;
    const url = linkDraft.trim();
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setEditingLink(false);
  }

  return (
    <>
      <div className="sticky top-[65px] z-10 flex items-center border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur sm:hidden supports-[backdrop-filter]:bg-background/75">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={!editor}
          onClick={() => setOpen(true)}
        >
          <Type className="h-3.5 w-3.5" />
          Format
        </Button>
      </div>

      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setEditingLink(false);
        }}
      >
        <SheetContent side="bottom" className="sm:hidden">
          <SheetHeader>
            <SheetTitle>Format</SheetTitle>
          </SheetHeader>

          {editor && (
            <div className="space-y-4 px-4 pb-6">
              <div className="grid grid-cols-4 gap-2">
                {BLOCK_ITEMS.map(({ label, icon: Icon, isActive, run }) => (
                  <Button
                    key={label}
                    type="button"
                    variant="outline"
                    aria-label={label}
                    aria-pressed={isActive(editor)}
                    className={cn(
                      "flex h-14 flex-col gap-1 text-[10px]",
                      isActive(editor) && "bg-accent text-accent-foreground",
                    )}
                    onClick={() => run(editor)}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {MARK_ITEMS.map(({ label, icon: Icon, isActive, run }) => (
                  <Button
                    key={label}
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={label}
                    aria-pressed={isActive(editor)}
                    className={cn(isActive(editor) && "bg-accent text-accent-foreground")}
                    onClick={() => run(editor)}
                  >
                    <Icon className="h-4 w-4" />
                  </Button>
                ))}

                {editingLink ? (
                  <div className="flex flex-1 items-center gap-1">
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
                      className="h-9 flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Apply link"
                      onClick={commitLink}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={editor.isActive("link") ? "Edit link" : "Add link"}
                    aria-pressed={editor.isActive("link")}
                    className={cn(editor.isActive("link") && "bg-accent text-accent-foreground")}
                    onClick={openLinkEditor}
                  >
                    <Link2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

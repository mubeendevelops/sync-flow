"use client";

import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Link2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INLINE_CODE_ITEM, MARK_ITEMS } from "@/components/editor/toolbar-items";
import { ToolbarButton } from "@/components/editor/toolbar-button";
import { ColorPicker } from "@/components/editor/color-picker";

const COMPACT_BUTTON = "h-7 w-7";

// Tailwind's `sm` breakpoint — a selection-tracking bubble menu fights with native touch
// selection handles on phone-width viewports, so it's suppressed there in favor of the mobile
// "Format" bottom sheet, which offers the same bold/italic/link actions without that conflict.
const MOBILE_BREAKPOINT_PX = 640;

/** Floating toolbar for inline marks — appears above the selection on text highlight. Desktop
 * only; see `MobileFormatSheet` for the mobile equivalent. */
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
      shouldShow={({ editor: e, state }) =>
        typeof window !== "undefined" &&
        window.innerWidth >= MOBILE_BREAKPOINT_PX &&
        !e.isActive("codeBlock") &&
        !state.selection.empty
      }
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
          {MARK_ITEMS.map(({ label, icon: Icon, shortcut, isActive, run }) => (
            <ToolbarButton
              key={label}
              label={label}
              shortcut={shortcut}
              isActive={isActive(editor)}
              className={COMPACT_BUTTON}
              onClick={() => run(editor)}
            >
              <Icon className="h-3.5 w-3.5" />
            </ToolbarButton>
          ))}
          <ColorPicker editor={editor} mode="highlight" className={COMPACT_BUTTON} />
          <ColorPicker editor={editor} mode="textColor" className={COMPACT_BUTTON} />
          <ToolbarButton
            label={editor.isActive("link") ? "Edit link" : "Add link"}
            shortcut="Ctrl+K"
            isActive={editor.isActive("link")}
            className={COMPACT_BUTTON}
            onClick={openLinkEditor}
          >
            <Link2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label={INLINE_CODE_ITEM.label}
            shortcut={INLINE_CODE_ITEM.shortcut}
            isActive={INLINE_CODE_ITEM.isActive(editor)}
            className={COMPACT_BUTTON}
            onClick={() => INLINE_CODE_ITEM.run(editor)}
          >
            <INLINE_CODE_ITEM.icon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </>
      )}
    </BubbleMenu>
  );
}

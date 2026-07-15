"use client";

import type { Editor } from "@tiptap/react";
import { ParagraphStyleDropdown } from "@/components/editor/paragraph-style-dropdown";
import { ColorPicker } from "@/components/editor/color-picker";
import { LinkButton } from "@/components/editor/link-button";
import { ToolbarButton } from "@/components/editor/toolbar-button";
import { INLINE_CODE_ITEM, LIST_ITEMS, MARK_ITEMS } from "@/components/editor/toolbar-items";

const CodeIcon = INLINE_CODE_ITEM.icon;

function ToolbarDivider() {
  return <div aria-hidden className="mx-1 h-5 w-px bg-border" />;
}

/** Fixed toolbar — always visible, sticky under the document header. Five groups, left to
 * right: paragraph style, inline marks, highlight/color, lists, link/inline code. Hidden below
 * `sm` (390px-class viewports): `MobileFormatSheet` covers the same actions from a single
 * "Format" button + bottom sheet, since this doesn't fit that width. */
export function FixedToolbar({ editor }: { editor: Editor | null }) {
  return (
    <div className="sticky top-[65px] z-10 hidden items-center justify-center gap-0.5 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur sm:flex supports-[backdrop-filter]:bg-background/75">
      {editor ? (
        <>
          {/* Group 1: paragraph style */}
          <ParagraphStyleDropdown editor={editor} />
          <ToolbarDivider />

          {/* Group 2: bold / italic / underline / strikethrough */}
          {MARK_ITEMS.map(({ label, icon: Icon, shortcut, isActive, run }) => (
            <ToolbarButton
              key={label}
              label={label}
              shortcut={shortcut}
              isActive={isActive(editor)}
              onClick={() => run(editor)}
            >
              <Icon className="h-4 w-4" />
            </ToolbarButton>
          ))}
          <ToolbarDivider />

          {/* Group 3: highlight + text color */}
          <ColorPicker editor={editor} mode="highlight" />
          <ColorPicker editor={editor} mode="textColor" />
          <ToolbarDivider />

          {/* Group 4: bullet / numbered / task list */}
          {LIST_ITEMS.map(({ label, icon: Icon, isActive, run }) => (
            <ToolbarButton
              key={label}
              label={label}
              isActive={isActive(editor)}
              onClick={() => run(editor)}
            >
              <Icon className="h-4 w-4" />
            </ToolbarButton>
          ))}
          <ToolbarDivider />

          {/* Group 5: link + inline code */}
          <LinkButton editor={editor} />
          <ToolbarButton
            label={INLINE_CODE_ITEM.label}
            shortcut={INLINE_CODE_ITEM.shortcut}
            isActive={INLINE_CODE_ITEM.isActive(editor)}
            onClick={() => INLINE_CODE_ITEM.run(editor)}
          >
            <CodeIcon className="h-4 w-4" />
          </ToolbarButton>
        </>
      ) : null}
    </div>
  );
}

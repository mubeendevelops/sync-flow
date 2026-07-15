"use client";

import type { Editor } from "@tiptap/react";
import { Baseline, Highlighter } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/editor/toolbar-button";
import { cn } from "@/lib/utils";

/** The shared 6-color palette for both highlight and text color — same swatches, different
 * mark (`highlight`'s `color` attr vs. the shared `textStyle` mark's `color` attr via Color). */
export const TOOLBAR_COLORS = [
  { name: "Yellow", value: "#facc15" },
  { name: "Green", value: "#4ade80" },
  { name: "Blue", value: "#60a5fa" },
  { name: "Pink", value: "#f472b6" },
  { name: "Orange", value: "#fb923c" },
  { name: "Purple", value: "#c084fc" },
] as const;

interface ColorPickerProps {
  readonly editor: Editor;
  readonly mode: "highlight" | "textColor";
  /** Icon-button size — matches whichever toolbar it's dropped into (fixed vs. floating). */
  readonly className?: string;
}

/** Highlight or text-color toolbar button: opens a small popover of 6 swatches + a reset
 * option. Applying a swatch (or resetting) is a normal mark command, so it flows through the
 * CRDT bridge — see `highlight`/`textColor` in `text-projection.ts` + `crdt-bridge.ts`. */
export function ColorPicker({ editor, mode, className }: ColorPickerProps) {
  const isHighlight = mode === "highlight";
  const activeColor = isHighlight
    ? (editor.getAttributes("highlight").color as string | undefined)
    : (editor.getAttributes("textStyle").color as string | undefined);
  const isActive = isHighlight ? editor.isActive("highlight") : Boolean(activeColor);
  const label = isHighlight ? "Highlight" : "Text color";

  function apply(color: string | null): void {
    const chain = editor.chain().focus();
    if (isHighlight) {
      if (color) chain.setHighlight({ color }).run();
      else chain.unsetHighlight().run();
    } else {
      if (color) chain.setColor(color).run();
      else chain.unsetColor().run();
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarButton label={label} isActive={isActive} className={className}>
          {isHighlight ? (
            <Highlighter className="h-4 w-4" style={activeColor ? { color: activeColor } : undefined} />
          ) : (
            <span className="flex flex-col items-center leading-none">
              <Baseline className="h-4 w-4" />
              <span
                aria-hidden
                className="mt-0.5 h-0.5 w-4 rounded-full bg-current"
                style={activeColor ? { backgroundColor: activeColor } : undefined}
              />
            </span>
          )}
        </ToolbarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex w-auto items-center gap-1 p-1.5">
        {TOOLBAR_COLORS.map(({ name, value }) => (
          <button
            key={value}
            type="button"
            aria-label={name}
            title={name}
            onClick={() => apply(value)}
            className={cn(
              "h-6 w-6 shrink-0 rounded-full border border-border transition-transform hover:scale-110",
              activeColor === value && "ring-2 ring-ring ring-offset-1 ring-offset-popover",
            )}
            style={{ backgroundColor: value }}
          />
        ))}
        <button
          type="button"
          aria-label="Reset color"
          title="Reset"
          onClick={() => apply(null)}
          className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-xs text-muted-foreground hover:bg-accent"
        >
          ×
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

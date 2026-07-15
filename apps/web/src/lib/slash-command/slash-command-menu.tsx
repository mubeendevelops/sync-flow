"use client";

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import type { SlashCommand } from "./commands";

export interface SlashCommandMenuProps {
  readonly items: SlashCommand[];
  /** Run the picked command — wired to TipTap Suggestion's `command`, which deletes the
   * `/` + filter range and applies the block transformation. */
  readonly command: (item: SlashCommand) => void;
}

/** Imperative surface the Suggestion `onKeyDown` bridge calls; returns true if it consumed the key. */
export interface SlashCommandMenuRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * The floating slash-command list. Rendered by TipTap Suggestion via a ReactRenderer and
 * positioned with Tippy. Suggestion owns detection, filtering (`items`), and keyboard routing
 * (Arrow/Enter/Escape reach the editor and are forwarded here through `onKeyDown`), so cmdk
 * runs with `shouldFilter={false}` and a controlled highlight rather than its own input.
 */
export const SlashCommandMenu = forwardRef<SlashCommandMenuRef, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    // A new filter result set → reset the highlight to the top so Enter is predictable.
    useEffect(() => setSelectedIndex(0), [items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event) => {
          if (items.length === 0) {
            // Still swallow Enter so it doesn't insert a newline while the (empty) menu is open.
            return event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter";
          }
          if (event.key === "ArrowUp") {
            setSelectedIndex((i) => (i + items.length - 1) % items.length);
            return true;
          }
          if (event.key === "ArrowDown") {
            setSelectedIndex((i) => (i + 1) % items.length);
            return true;
          }
          if (event.key === "Enter") {
            const item = items[selectedIndex];
            if (item) command(item);
            return true;
          }
          return false;
        },
      }),
      [items, selectedIndex, command],
    );

    const selectedId = items[selectedIndex]?.id ?? "";

    return (
      <Command
        shouldFilter={false}
        value={selectedId}
        onValueChange={(v) => {
          const idx = items.findIndex((i) => i.id === v);
          if (idx !== -1) setSelectedIndex(idx);
        }}
        className="w-72 rounded-lg border border-border bg-popover shadow-md"
      >
        <CommandList>
          {items.length === 0 ? (
            <CommandEmpty>No results</CommandEmpty>
          ) : (
            <CommandGroup heading="Blocks">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => command(item)}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{item.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    );
  },
);

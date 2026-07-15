"use client";

import type { Editor } from "@tiptap/react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PARAGRAPH_STYLE_ITEMS } from "@/components/editor/toolbar-items";
import { cn } from "@/lib/utils";

/** Fixed toolbar's Group 1: Text / H1-3 / Quote / Code Block as a single dropdown, showing the
 * current block's style and applying the picked one on select. */
export function ParagraphStyleDropdown({ editor }: { editor: Editor }) {
  const active = PARAGRAPH_STYLE_ITEMS.find((item) => item.isActive(editor)) ?? PARAGRAPH_STYLE_ITEMS[0]!;
  const ActiveIcon = active.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs">
          <ActiveIcon className="h-3.5 w-3.5" />
          {active.label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {PARAGRAPH_STYLE_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.isActive(editor);
          return (
            <DropdownMenuItem
              key={item.id}
              className={cn("gap-2", isActive && "bg-accent text-accent-foreground")}
              onSelect={() => item.run(editor)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ToolbarButtonProps extends ButtonProps {
  /** Tooltip text — also the button's `aria-label` when none is explicitly passed. */
  readonly label: string;
  /** Rendered next to the label in the tooltip, e.g. `"Ctrl+B"`. */
  readonly shortcut?: string;
  readonly isActive?: boolean;
}

/**
 * One icon button shared by every toolbar (fixed, floating, mobile sheet, and the color-picker
 * triggers): a ghost icon Button, active-state highlight, and a tooltip showing the label plus
 * its keyboard shortcut. `forwardRef` + prop passthrough so it composes as a Radix `asChild`
 * trigger (DropdownMenu, Popover) without losing its own tooltip.
 */
export const ToolbarButton = React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  function ToolbarButton({ label, shortcut, isActive, className, children, "aria-label": ariaLabel, ...props }, ref) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={ariaLabel ?? label}
            aria-pressed={isActive}
            className={cn("h-8 w-8", isActive && "bg-accent text-accent-foreground", className)}
            {...props}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {label}
          {shortcut && <span className="ml-1.5 text-muted-foreground">{shortcut}</span>}
        </TooltipContent>
      </Tooltip>
    );
  },
);

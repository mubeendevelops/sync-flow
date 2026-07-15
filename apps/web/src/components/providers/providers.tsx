"use client";

import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "./theme-provider";
import { QueryProvider } from "./query-provider";
import { ToasterProvider } from "./toaster-provider";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <TooltipProvider delayDuration={300}>
          {children}
          <ToasterProvider />
        </TooltipProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}

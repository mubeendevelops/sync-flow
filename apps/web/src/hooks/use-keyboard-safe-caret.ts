"use client";

/**
 * On iOS/Android, a virtual keyboard shrinks `window.visualViewport`, not the layout viewport —
 * the page doesn't resize or scroll on its own, so a caret near the bottom of the screen can end
 * up hidden behind the keyboard with no native recovery. This listens for the visual viewport
 * changing (keyboard opening, closing, or resizing) and nudges the page so the caret's screen
 * position stays inside the visible region.
 */

import { useEffect } from "react";
import type { Editor } from "@tiptap/react";

/** Breathing room between the caret and the visible edge after a scroll correction, in px. */
const CARET_MARGIN_PX = 16;

export function useKeyboardSafeCaret(editor: Editor | null): void {
  useEffect(() => {
    if (!editor || typeof window === "undefined" || !window.visualViewport) return;
    const viewport = window.visualViewport;

    function keepCaretVisible() {
      if (!editor!.isFocused) return;
      const { from } = editor!.state.selection;
      let coords: { top: number; bottom: number };
      try {
        coords = editor!.view.coordsAtPos(from);
      } catch {
        return; // Position not currently rendered/measurable — nothing to correct.
      }

      const visibleTop = viewport.offsetTop;
      const visibleBottom = viewport.offsetTop + viewport.height;

      if (coords.bottom > visibleBottom) {
        window.scrollBy({ top: coords.bottom - visibleBottom + CARET_MARGIN_PX, behavior: "smooth" });
      } else if (coords.top < visibleTop) {
        window.scrollBy({ top: coords.top - visibleTop - CARET_MARGIN_PX, behavior: "smooth" });
      }
    }

    viewport.addEventListener("resize", keepCaretVisible);
    viewport.addEventListener("scroll", keepCaretVisible);
    return () => {
      viewport.removeEventListener("resize", keepCaretVisible);
      viewport.removeEventListener("scroll", keepCaretVisible);
    };
  }, [editor]);
}

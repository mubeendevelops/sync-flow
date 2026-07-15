import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { assignPresenceColor, PRESENCE_COLOR_PALETTE } from "./presence-color.js";

// A minimal, dependency-free WCAG relative-luminance/contrast-ratio calculator, just for this
// test — mirrors the standard formula (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl! + 0.7152 * gl! + 0.0722 * bl!;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: [number, number, number] = [255, 255, 255];
// This app's dark-theme --background: hsl(222.2 84% 4.9%).
const DARK_BG: [number, number, number] = [2, 8, 23];
// WCAG AA non-text/UI-component contrast minimum (SC 1.4.11) — the right bar for a color used
// as a cursor bar / presence dot / avatar fill, as opposed to the stricter 4.5:1 for body text.
const AA_NON_TEXT_MIN = 3.0;

describe("PRESENCE_COLOR_PALETTE", () => {
  it.each(PRESENCE_COLOR_PALETTE)(
    "%s passes WCAG AA contrast against both white and the dark background",
    (hex) => {
      const rgb = hexToRgb(hex);
      expect(contrastRatio(rgb, WHITE)).toBeGreaterThanOrEqual(AA_NON_TEXT_MIN);
      expect(contrastRatio(rgb, DARK_BG)).toBeGreaterThanOrEqual(AA_NON_TEXT_MIN);
    },
  );
});

describe("assignPresenceColor", () => {
  it("is deterministic for the same user id", () => {
    const id = crypto.randomUUID();
    expect(assignPresenceColor(id)).toBe(assignPresenceColor(id));
  });

  it("returns a hex color", () => {
    expect(assignPresenceColor(crypto.randomUUID())).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("distributes across more than one palette entry over many ids", () => {
    const colors = new Set(
      Array.from({ length: 50 }, () => assignPresenceColor(crypto.randomUUID())),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

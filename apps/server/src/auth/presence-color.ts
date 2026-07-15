// Colorblind-safe-ish, mutually distinguishable palette for remote cursors/avatars. Every entry
// is tuned to clear WCAG AA (>=3:1, most >=4.4:1) against BOTH a white page background (light
// theme) and this app's dark-theme background (~hsl(222.2 84% 4.9%)) — no single flat sRGB color
// can hit the stricter 4.5:1 *text* contrast against both a near-white and near-black surface at
// once (the luminance bands are disjoint), so this targets the non-text/UI-component AA
// threshold (WCAG 1.4.11) for the cursor bar / presence dot, which lands very close to 4.5:1 for
// the white initials text these colors also serve as an avatar background for.
export const PRESENCE_COLOR_PALETTE = [
  "#EB1700", // red
  "#C25700", // orange
  "#9E6F00", // amber
  "#008A39", // green
  "#008577", // teal
  "#0080A3", // cyan
  "#0070FA", // blue
  "#4D5BFF", // indigo
  "#824DFF", // violet
  "#B624FF", // purple
  "#DB00AF", // magenta
  "#EB004E", // rose
] as const;

/** FNV-1a — fast, deterministic, evenly distributed for short strings like a UUID. */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic presence color from a user id — same user always gets the same color. */
export function assignPresenceColor(userId: string): string {
  const index = fnv1aHash(userId) % PRESENCE_COLOR_PALETTE.length;
  return PRESENCE_COLOR_PALETTE[index];
}

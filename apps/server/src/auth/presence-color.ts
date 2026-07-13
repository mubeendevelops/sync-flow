// Colorblind-safe-ish, mutually distinguishable palette for remote cursors/avatars —
// mid-saturation so text/cursor overlays stay legible on both light and dark backgrounds.
const PRESENCE_COLOR_PALETTE = [
  "#E53E3E", // red
  "#DD6B20", // orange
  "#D69E2E", // gold
  "#38A169", // green
  "#319795", // teal
  "#3182CE", // blue
  "#5A67D8", // indigo
  "#805AD5", // purple
  "#D53F8C", // pink
  "#718096", // slate
  "#2C7A7B", // dark teal
  "#C05621", // burnt orange
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

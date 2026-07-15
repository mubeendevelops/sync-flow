/**
 * Maps the raw socket {@link ConnectionState} + in-flight-save flag down to the four states the
 * header pill is allowed to show (per CLAUDE.md's polish spec). `connecting` (pre-first-join)
 * reads the same as `reconnecting` — both are "link not ready yet, retry in flight" from the
 * user's point of view, and the spec defines no fifth state for it.
 */

import type { ConnectionState } from "@/lib/websocket";

export type SavedState = "saved" | "saving" | "reconnecting" | "offline";

export function toSavedState(connectionState: ConnectionState, isSaving: boolean): SavedState {
  if (connectionState === "offline") return "offline";
  if (connectionState === "connecting" || connectionState === "reconnecting") {
    return "reconnecting";
  }
  return isSaving ? "saving" : "saved";
}

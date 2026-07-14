import { create } from "zustand";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

/**
 * Skeleton only. Client/editor state that isn't server state and isn't the CRDT itself — the
 * CRDT document lives in a ref, never in Zustand/React state, so remote ops don't re-render the
 * editor (see PLAN.md 3.4/3.5 and CLAUDE.md). This store is for UI that reacts to connection
 * status and which document is active (the header status pill, the collaborator avatar stack).
 */
interface DocumentState {
  activeDocumentId: string | null;
  connectionState: ConnectionState;
  setActiveDocumentId: (documentId: string | null) => void;
  setConnectionState: (state: ConnectionState) => void;
}

export const useDocumentStore = create<DocumentState>((set) => ({
  activeDocumentId: null,
  connectionState: "offline",
  setActiveDocumentId: (activeDocumentId) => set({ activeDocumentId }),
  setConnectionState: (connectionState) => set({ connectionState }),
}));

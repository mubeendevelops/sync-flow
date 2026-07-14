import { create } from "zustand";
import type { PublicUser } from "@sync-flow/schemas";

/**
 * Skeleton only. The real session lives in React Query (GET /api/v1/auth/me is the source of
 * truth — see CLAUDE.md and PLAN.md 3.2); this store exists for client-only UI that needs
 * synchronous access to "who's logged in" without subscribing to a query (e.g. the WebSocket
 * layer in Prompt 19). useAuth (Prompt 16) is responsible for keeping the two in sync.
 */
interface AuthState {
  user: PublicUser | null;
  setUser: (user: PublicUser | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  clear: () => set({ user: null }),
}));

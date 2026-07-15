"use client";

import { memo } from "react";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getInitials } from "@/lib/initials";
import type { PresenceUser } from "@/lib/websocket";

const MAX_VISIBLE = 4;

export interface PresenceAvatarStackProps {
  /** Users currently in the document (already deduplicated by userId). */
  users: PresenceUser[];
  /** The viewing user's id, so their own row can be marked "(you)". */
  selfId?: string;
}

/**
 * The live-presence avatar stack in the editor header: up to four colored avatars (each with a
 * green "online" dot) plus a +N overflow badge, all driven by the realtime presence hash — not
 * the ACL collaborator list. Clicking the stack opens a popover listing everyone currently here.
 *
 * Memoized: the owning page re-renders on every connection-state change (e.g. the header pill
 * flipping Saved/Saving), which has nothing to do with who's present — `React.memo` skips this
 * subtree unless `users`/`selfId` actually changed.
 */
export const PresenceAvatarStack = memo(function PresenceAvatarStack({
  users,
  selfId,
}: PresenceAvatarStackProps) {
  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.length - visible.length;
  const label = `${users.length} ${users.length === 1 ? "person" : "people"} in this document`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Full avatar row — desktop only; a 390px header has no room for overlapping
              circles alongside the title, connection pill, and History/Share buttons. */}
          <span className="hidden items-center -space-x-2 sm:flex">
            {visible.map((user) => (
              <PresenceAvatar key={user.userId} user={user} />
            ))}
            {overflow > 0 && (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background">
                +{overflow}
              </span>
            )}
          </span>
          {/* Mobile: a compact count badge that opens the same "who's here" menu. */}
          <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground sm:hidden">
            <Users aria-hidden className="h-3.5 w-3.5" />
            {users.length}
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>In this document</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ul className="max-h-64 overflow-y-auto py-1">
          {users.map((user) => (
            <li
              key={user.userId}
              className="flex items-center gap-2.5 px-2 py-1.5 text-sm text-foreground"
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                style={{ backgroundColor: user.color }}
              />
              <span className="truncate">{user.displayName}</span>
              {user.userId === selfId && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">you</span>
              )}
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const PresenceAvatar = memo(function PresenceAvatar({ user }: { user: PresenceUser }) {
  return (
    <span className="relative inline-flex">
      <Avatar className="h-8 w-8 ring-2 ring-background" title={user.displayName}>
        <AvatarFallback style={{ backgroundColor: user.color }}>
          {getInitials(user.displayName)}
        </AvatarFallback>
      </Avatar>
      <span
        aria-hidden
        className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-background"
      />
    </span>
  );
});

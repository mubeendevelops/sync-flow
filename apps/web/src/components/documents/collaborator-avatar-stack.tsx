import { memo } from "react";
import type { Collaborator } from "@sync-flow/schemas";
import { CollaboratorAvatar } from "@/components/documents/collaborator-avatar";

const MAX_VISIBLE = 4;

/** Memoized: the dashboard grid re-renders every card on each page fetch/rename/etc — this
 * skips re-rendering a card's avatar stack unless its own `collaborators` array changed. */
export const CollaboratorAvatarStack = memo(function CollaboratorAvatarStack({
  collaborators,
}: {
  collaborators: Collaborator[];
}) {
  const visible = collaborators.slice(0, MAX_VISIBLE);
  const overflow = collaborators.length - visible.length;

  return (
    <div className="flex -space-x-2">
      {visible.map((c) => (
        <CollaboratorAvatar
          key={c.userId}
          displayName={c.displayName}
          presenceColor={c.presenceColor}
        />
      ))}
      {overflow > 0 && (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background">
          +{overflow}
        </div>
      )}
    </div>
  );
});

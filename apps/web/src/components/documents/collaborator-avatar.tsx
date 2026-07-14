import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { getInitials } from "@/lib/initials";
import { cn } from "@/lib/utils";

export interface CollaboratorAvatarProps {
  displayName: string;
  presenceColor: string;
  className?: string;
}

export function CollaboratorAvatar({
  displayName,
  presenceColor,
  className,
}: CollaboratorAvatarProps) {
  return (
    <Avatar className={cn("ring-2 ring-background", className)} title={displayName}>
      <AvatarFallback style={{ backgroundColor: presenceColor }}>
        {getInitials(displayName)}
      </AvatarFallback>
    </Avatar>
  );
}

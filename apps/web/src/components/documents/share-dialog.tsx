"use client";

import { useState } from "react";
import { AlertCircle, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CollaboratorAvatar } from "@/components/documents/collaborator-avatar";
import {
  useDocumentDetail,
  useInviteMember,
  useRemoveMember,
  useTransferOwnership,
} from "@/hooks/use-document-sharing";
import { useUserSearch } from "@/hooks/use-user-search";
import { useAuthStore } from "@/stores/auth-store";
import { ApiError, type PublicUser } from "@sync-flow/schemas";

export interface ShareDialogProps {
  documentId: string;
  documentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ documentId, documentTitle, open, onOpenChange }: ShareDialogProps) {
  const currentUser = useAuthStore((s) => s.user);
  const { data, isLoading, isError, error, refetch } = useDocumentDetail(documentId, open);
  const inviteMember = useInviteMember(documentId);
  const removeMember = useRemoveMember(documentId);
  const transferOwnership = useTransferOwnership(documentId);

  const [searchInput, setSearchInput] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [transferTarget, setTransferTarget] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);

  const isOwner = Boolean(currentUser && data?.document.ownerId === currentUser.id);
  const existingIds = new Set([data?.owner?.id, ...(data?.members.map((m) => m.userId) ?? [])]);
  const { users: searchResults } = useUserSearch(searchInput);
  const availableResults = searchResults.filter((u) => !existingIds.has(u.id));

  function handleInvite(user: PublicUser) {
    inviteMember.mutate({ user, role: inviteRole }, { onSuccess: () => setSearchInput("") });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent onClick={(e) => e.stopPropagation()} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share &ldquo;{documentTitle}&rdquo;</DialogTitle>
            <DialogDescription>Manage who can view and edit this document.</DialogDescription>
          </DialogHeader>

          {isOwner && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    placeholder="Search by name, username, or email"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                  />
                  {availableResults.length > 0 && (
                    <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-md">
                      {availableResults.map((user) => (
                        <li key={user.id}>
                          <button
                            type="button"
                            onClick={() => handleInvite(user)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                          >
                            <CollaboratorAvatar
                              displayName={user.displayName}
                              presenceColor={user.presenceColor}
                              className="h-6 w-6 text-[10px]"
                            />
                            <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {user.email}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Select
                  value={inviteRole}
                  onValueChange={(v) => setInviteRole(v as "editor" | "viewer")}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {isLoading && (
              <div className="space-y-3 py-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}

            {isError && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <AlertCircle className="h-6 w-6 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  {error instanceof ApiError
                    ? (error.detail ?? error.title)
                    : "Couldn't load who has access to this document."}
                </p>
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  Retry
                </Button>
              </div>
            )}

            {data?.owner && (
              <div className="flex items-center gap-3 rounded-md px-2 py-2">
                <CollaboratorAvatar
                  displayName={data.owner.displayName}
                  presenceColor={data.owner.presenceColor}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{data.owner.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{data.owner.email}</p>
                </div>
                <span className="text-xs text-muted-foreground">Owner</span>
              </div>
            )}

            {data?.members.map((member) => (
              <div key={member.userId} className="flex items-center gap-3 rounded-md px-2 py-2">
                <CollaboratorAvatar
                  displayName={member.displayName}
                  presenceColor={member.presenceColor}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{member.displayName}</p>
                  <p className="text-xs capitalize text-muted-foreground">{member.role}</p>
                </div>
                {isOwner && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() =>
                        setTransferTarget({
                          userId: member.userId,
                          displayName: member.displayName,
                        })
                      }
                    >
                      Make owner
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`Remove ${member.displayName}`}
                      onClick={() => removeMember.mutate(member.userId)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            ))}

            {!isLoading && data?.members.length === 0 && (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                Only you have access to this document.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={transferTarget !== null}
        onOpenChange={(o) => !o && setTransferTarget(null)}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Make {transferTarget?.displayName} the owner?</AlertDialogTitle>
            <AlertDialogDescription>
              They&apos;ll become the owner of this document and you&apos;ll become an editor. This
              can be undone by having them transfer ownership back to you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={transferOwnership.isPending}
              onClick={() => {
                if (!transferTarget) return;
                transferOwnership.mutate(transferTarget.userId, {
                  onSuccess: () => setTransferTarget(null),
                });
              }}
            >
              Transfer ownership
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

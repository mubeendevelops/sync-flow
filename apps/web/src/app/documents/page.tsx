"use client";

import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/theme-toggle";
import { CollaboratorAvatar } from "@/components/documents/collaborator-avatar";
import { DocumentGrid } from "@/components/documents/document-grid";
import { DocumentCardSkeleton } from "@/components/documents/document-card-skeleton";
import { useRequireAuth } from "@/hooks/use-auth";

export default function DocumentsPage() {
  const { user, isLoading, logout } = useRequireAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-2 font-semibold">
          <PenLine className="h-5 w-5 text-primary" />
          SyncFlow
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {isLoading || !user ? (
            <Skeleton className="h-8 w-8 rounded-full" />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <CollaboratorAvatar
                  displayName={user.displayName}
                  presenceColor={user.presenceColor}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {user.email}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleLogout}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <h1 className="mb-6 text-2xl font-semibold text-foreground">Your documents</h1>
        {isLoading || !user ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <DocumentCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <DocumentGrid />
        )}
      </main>
    </div>
  );
}

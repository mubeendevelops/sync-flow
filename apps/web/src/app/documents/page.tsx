"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRequireAuth } from "@/hooks/use-auth";

// Placeholder — the real document dashboard (list/create/rename/delete/share) lands next.
// This exists so the auth flow (login → protected route → refresh → logout) has somewhere to land.
export default function DocumentsPage() {
  const { user, isLoading, logout } = useRequireAuth();
  const router = useRouter();

  if (isLoading || !user) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
    );
  }

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold text-foreground">Welcome, {user.displayName}</h1>
      <p className="text-muted-foreground">Your documents will show up here.</p>
      <Button variant="outline" className="w-fit" onClick={handleLogout}>
        Log out
      </Button>
    </div>
  );
}

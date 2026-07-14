"use client";

import { useQuery } from "@tanstack/react-query";
import { healthResponseSchema } from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Proves the schema → API client → React Query wiring end to end: the response type here is
 * inferred from @sync-flow/schemas, the same schema apps/server's /health route is expected to
 * satisfy — no hand-copied type.
 */
export function BackendStatus() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiClient.get("/health", { responseSchema: healthResponseSchema }),
    retry: false,
  });

  if (isLoading) {
    return <Skeleton className="h-5 w-32" />;
  }

  const ok = !isError && data?.status === "ok";

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span
        className={cn("h-2 w-2 rounded-full", ok ? "bg-emerald-500" : "bg-destructive")}
        aria-hidden
      />
      {ok ? "Backend connected" : "Backend unreachable"}
    </div>
  );
}

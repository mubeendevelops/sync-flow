"use client";

import { useQuery } from "@tanstack/react-query";
import { userSearchResponseSchema } from "@sync-flow/schemas";
import { apiClient } from "@/lib/api-client";
import { useDebouncedValue } from "@/hooks/use-debounce";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

/** Backs the share dialog's add-member autocomplete. Debounced client-side and gated on a
 * minimum length so we're not firing a search request per keystroke. */
export function useUserSearch(rawQuery: string) {
  const query = useDebouncedValue(rawQuery.trim(), DEBOUNCE_MS);
  const enabled = query.length >= MIN_QUERY_LENGTH;

  const result = useQuery({
    queryKey: ["users", "search", query],
    queryFn: () =>
      apiClient.get("/api/v1/users/search", {
        query: { q: query },
        responseSchema: userSearchResponseSchema,
      }),
    enabled,
  });

  return { ...result, users: result.data?.users ?? [], enabled };
}

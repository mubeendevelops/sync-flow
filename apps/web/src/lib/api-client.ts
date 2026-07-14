import { createApiClient } from "@sync-flow/schemas";

const baseUrl = process.env.NEXT_PUBLIC_API_URL;
if (!baseUrl) {
  throw new Error("NEXT_PUBLIC_API_URL is not set");
}

/** Single shared instance — every API call in apps/web goes through this. */
export const apiClient = createApiClient({ baseUrl });

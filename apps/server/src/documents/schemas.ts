// Request validation lives in @sync-flow/schemas so apps/web's API client and this backend
// validate against the exact same zod objects — see packages/schemas/src/documents.ts.
export {
  documentIdParamsSchema,
  memberParamsSchema,
  listDocumentsQuerySchema,
  createDocumentBodySchema,
  patchDocumentBodySchema,
  inviteBodySchema,
  listOperationsQuerySchema,
  versionParamsSchema,
  listVersionsQuerySchema,
  transferOwnerBodySchema,
} from "@sync-flow/schemas";

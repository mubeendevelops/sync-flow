// Request validation lives in @sync-flow/schemas so apps/web's forms and this backend
// validate against the exact same zod objects — see packages/schemas/src/auth.ts.
export { signupBodySchema, loginBodySchema } from "@sync-flow/schemas";

import { Router } from "express";
import type { DbClient } from "../db/types.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/require-auth.js";
import { userSearchQuerySchema } from "../auth/schemas.js";
import { searchUsers, toPublicUser } from "../auth/users.repo.js";

export interface UsersRouterDeps {
  db: DbClient;
  jwtAccessSecret: string;
}

const SEARCH_LIMIT = 10;

export function createUsersRouter(deps: UsersRouterDeps): Router {
  const router = Router();
  router.use(requireAuth({ jwtAccessSecret: deps.jwtAccessSecret }));

  router.get("/search", validate({ query: userSearchQuerySchema }), async (req, res, next) => {
    try {
      const { q } = req.query as unknown as { q: string };
      const users = await searchUsers(deps.db, {
        query: q,
        excludeUserId: req.user!.id,
        limit: SEARCH_LIMIT,
      });
      res.status(200).json({ users: users.map(toPublicUser) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

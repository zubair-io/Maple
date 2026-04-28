// src/api/src/auth/middleware.ts
import { Elysia } from "elysia";
import { verifyAccessToken, type AccessClaims } from "./tokens.ts";

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error("MAPLE_JWT_SECRET unset or too short");
  return s;
}

export const requireAuth = new Elysia({ name: "requireAuth" })
  .derive({ as: "scoped" }, ({ headers, set }) => {
    const h = headers["authorization"] ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) {
      set.status = 401;
      throw new Error("missing bearer");
    }
    let claims: AccessClaims;
    try {
      claims = verifyAccessToken(m[1], jwtSecret());
    } catch (e) {
      set.status = 401;
      throw e;
    }
    return { auth: { user: claims } };
  });

export const requireOwner = new Elysia({ name: "requireOwner" })
  .use(requireAuth)
  .onBeforeHandle({ as: "scoped" }, ({ auth, set }) => {
    if (!auth || auth.user.role !== "owner") {
      set.status = 403;
      return { error: "owner role required" };
    }
  });

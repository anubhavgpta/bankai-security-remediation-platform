import type { NextFunction, Request, Response } from "express";
import { readAuthCookies } from "../lib/auth-cookies.js";
import { HttpError } from "../lib/http-error.js";
import { createRequestSupabaseClient } from "../lib/supabase.js";

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const { accessToken } = readAuthCookies(req);

  if (!accessToken) {
    next(new HttpError(401, "Not authenticated"));
    return;
  }

  const supabase = createRequestSupabaseClient();
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data.user) {
    next(new HttpError(401, "Not authenticated"));
    return;
  }

  req.user = data.user;
  req.accessToken = accessToken;
  next();
}

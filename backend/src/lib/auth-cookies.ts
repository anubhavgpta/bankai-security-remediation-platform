import type { CookieOptions, Request, Response } from "express";
import { env } from "../env.js";

const ACCESS_TOKEN_COOKIE = "bankai_at";
const REFRESH_TOKEN_COOKIE = "bankai_rt";
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function baseCookieOptions(): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === "production" || env.COOKIE_SAMESITE === "none",
    sameSite: env.COOKIE_SAMESITE,
    path: "/",
  };

  if (env.COOKIE_DOMAIN) {
    options.domain = env.COOKIE_DOMAIN;
  }

  return options;
}

export interface AuthSessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function setAuthCookies(res: Response, session: AuthSessionTokens): void {
  res.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
    ...baseCookieOptions(),
    maxAge: session.expiresIn * 1000,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_TOKEN_COOKIE, baseCookieOptions());
  res.clearCookie(REFRESH_TOKEN_COOKIE, baseCookieOptions());
}

export function readAuthCookies(req: Request): { accessToken: string | undefined; refreshToken: string | undefined } {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return {
    accessToken: cookies?.[ACCESS_TOKEN_COOKIE],
    refreshToken: cookies?.[REFRESH_TOKEN_COOKIE],
  };
}

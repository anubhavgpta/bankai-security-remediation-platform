import type { User } from "@supabase/supabase-js";

declare global {
  namespace Express {
    interface Request {
      user?: User;
      accessToken?: string;
      project?: { id: string; name: string; keyPrefix: string | null };
    }
  }
}

export {};

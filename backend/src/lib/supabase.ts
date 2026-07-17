import { createClient } from "@supabase/supabase-js";
import { env } from "../env.js";

/**
 * Every auth operation (signUp, signInWithPassword, refreshSession, getUser)
 * is stateless from the backend's point of view — the resulting session is
 * handed back to the caller as cookies, not persisted in this client. A
 * fresh client per request avoids sharing in-memory session state across
 * unrelated requests.
 */
export function createRequestSupabaseClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Service-role client, used only where a privileged operation is required
 * (currently: revoking a user's refresh token on logout). Never expose this
 * client or its key to a request handler that echoes data back unfiltered.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

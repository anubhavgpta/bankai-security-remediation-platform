import type { User } from "@supabase/supabase-js";

export function displayNameFromUser(user: User): string {
  const fullName = typeof user.user_metadata["full_name"] === "string" ? user.user_metadata["full_name"] : null;
  return fullName || user.email || "Account";
}

import { z } from "zod";

// Accepts a bare "owner/repo" or a full GitHub URL and normalizes to "owner/repo".
function normalizeRepo(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return trimmed;
}

export const connectGithubSchema = z.object({
  repo: z
    .string()
    .trim()
    .min(1, "Repository is required")
    .transform(normalizeRepo)
    .refine((value) => /^[\w.-]+\/[\w.-]+$/.test(value), "Enter a repository as owner/repo or a GitHub URL"),
  token: z.string().trim().min(10, "Token looks too short").max(1024, "Token is too long"),
  baseBranch: z.string().trim().max(255, "Base branch name is too long").optional(),
});

export type ConnectGithubInput = z.infer<typeof connectGithubSchema>;

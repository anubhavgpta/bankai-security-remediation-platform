import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(120, "Project name is too long"),
  description: z.string().trim().max(2000, "Description is too long").optional(),
  services: z
    .array(z.string().trim().min(1).max(80))
    .max(50, "Too many services")
    .optional()
    .default([]),
  jiraSite: z.string().trim().max(253, "Jira site is too long").optional(),
  jiraKey: z.string().trim().max(20, "Project key is too long").optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

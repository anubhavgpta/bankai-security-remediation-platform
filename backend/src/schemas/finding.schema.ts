import { z } from "zod";

export const updateFindingSchema = z
  .object({
    bucket: z.enum(["New Delta", "In Progress", "Changed", "Resolved"]).optional(),
    service: z.string().trim().min(1).max(80).optional(),
  })
  .refine((data) => data.bucket !== undefined || data.service !== undefined, {
    message: "Provide a bucket or service to update.",
  });

export type UpdateFindingInput = z.infer<typeof updateFindingSchema>;

import { z } from "zod";

export const updateFindingSchema = z.object({
  bucket: z.enum(["New Delta", "In Progress", "Changed", "Resolved"]),
});

export type UpdateFindingInput = z.infer<typeof updateFindingSchema>;

import { z } from "zod";

export const createTicketsSchema = z.object({
  findingIds: z.array(z.uuid()).min(1, "Select at least one finding").max(100, "Too many findings selected"),
});

export type CreateTicketsInput = z.infer<typeof createTicketsSchema>;

export const updateTicketSchema = z.object({
  status: z.enum(["To Do", "In Progress", "In Review", "Done"]),
});

export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

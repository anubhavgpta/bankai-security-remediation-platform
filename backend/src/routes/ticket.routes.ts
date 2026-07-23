import { Router } from "express";
import { createTickets, listTickets, retryTicketFix, retryTicketPipeline, syncTickets, updateTicket } from "../controllers/ticket.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { createTicketsSchema, updateTicketSchema } from "../schemas/ticket.schema.js";

export const ticketRouter = Router({ mergeParams: true });

ticketRouter.get("/", listTickets);
ticketRouter.post("/", validateBody(createTicketsSchema), createTickets);
ticketRouter.post("/sync", syncTickets);
ticketRouter.patch("/:ticketId", validateBody(updateTicketSchema), updateTicket);
ticketRouter.post("/:ticketId/retry-fix", retryTicketFix);
ticketRouter.post("/:ticketId/retry-pipeline", retryTicketPipeline);

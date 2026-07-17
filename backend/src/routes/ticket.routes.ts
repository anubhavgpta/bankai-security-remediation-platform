import { Router } from "express";
import { createTickets, listTickets, updateTicket } from "../controllers/ticket.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { createTicketsSchema, updateTicketSchema } from "../schemas/ticket.schema.js";

export const ticketRouter = Router({ mergeParams: true });

ticketRouter.get("/", listTickets);
ticketRouter.post("/", validateBody(createTicketsSchema), createTickets);
ticketRouter.patch("/:ticketId", validateBody(updateTicketSchema), updateTicket);

import { Router } from "express";
import { listFindings, updateFinding } from "../controllers/finding.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { updateFindingSchema } from "../schemas/finding.schema.js";

export const findingRouter = Router({ mergeParams: true });

findingRouter.get("/", listFindings);
findingRouter.patch("/:findingId", validateBody(updateFindingSchema), updateFinding);

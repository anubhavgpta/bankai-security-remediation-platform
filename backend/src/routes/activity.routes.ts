import { Router } from "express";
import { listActivity } from "../controllers/activity.controller.js";

export const activityRouter = Router({ mergeParams: true });

activityRouter.get("/", listActivity);

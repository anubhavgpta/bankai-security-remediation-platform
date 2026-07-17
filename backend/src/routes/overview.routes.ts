import { Router } from "express";
import { getOverview } from "../controllers/overview.controller.js";

export const overviewRouter = Router({ mergeParams: true });

overviewRouter.get("/", getOverview);

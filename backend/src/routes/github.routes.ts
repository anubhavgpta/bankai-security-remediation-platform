import { Router } from "express";
import { connectGithub, disconnectGithub, getGithubStatus } from "../controllers/github.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { connectGithubSchema } from "../schemas/github.schema.js";

export const githubRouter = Router({ mergeParams: true });

githubRouter.get("/", getGithubStatus);
githubRouter.post("/connect", validateBody(connectGithubSchema), connectGithub);
githubRouter.post("/disconnect", disconnectGithub);

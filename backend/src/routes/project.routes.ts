import { Router } from "express";
import { createProject, deleteProject, getProject, listProjects } from "../controllers/project.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { loadProject } from "../middleware/load-project.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate-body.js";
import { createProjectSchema, deleteProjectSchema } from "../schemas/project.schema.js";
import { activityRouter } from "./activity.routes.js";
import { findingRouter } from "./finding.routes.js";
import { githubRouter } from "./github.routes.js";
import { jiraRouter } from "./jira.routes.js";
import { memberRouter } from "./member.routes.js";
import { overviewRouter } from "./overview.routes.js";
import { scanRouter } from "./scan.routes.js";
import { slaRouter } from "./sla.routes.js";
import { ticketRouter } from "./ticket.routes.js";

export const projectRouter = Router();

projectRouter.use(requireAuth, baselineProtect);

projectRouter.get("/", listProjects);
projectRouter.post("/", validateBody(createProjectSchema), createProject);
projectRouter.get("/:id", getProject);
projectRouter.delete("/:id", validateBody(deleteProjectSchema), deleteProject);

// Everything under /:projectId/* (scans, findings, tickets, overview,
// activity) is scoped to a single project — loadProject resolves it once
// and 404s here if the caller doesn't own it, before any nested route runs.
const projectScoped = Router({ mergeParams: true });
projectScoped.use(loadProject);
projectScoped.use("/scans", scanRouter);
projectScoped.use("/findings", findingRouter);
projectScoped.use("/tickets", ticketRouter);
projectScoped.use("/jira", jiraRouter);
projectScoped.use("/github", githubRouter);
projectScoped.use("/sla", slaRouter);
projectScoped.use("/members", memberRouter);
projectScoped.use("/overview", overviewRouter);
projectScoped.use("/activity", activityRouter);

projectRouter.use("/:projectId", projectScoped);

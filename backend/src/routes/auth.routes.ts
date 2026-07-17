import { Router } from "express";
import { login, logout, me, refresh, signup } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate-body.js";
import { loginSchema, signupSchema } from "../schemas/auth.schema.js";

export const authRouter = Router();

authRouter.post("/signup", validateBody(signupSchema), signup);
authRouter.post("/login", validateBody(loginSchema), login);
authRouter.post("/logout", logout);
authRouter.post("/refresh", refresh);
authRouter.get("/session", requireAuth, me);

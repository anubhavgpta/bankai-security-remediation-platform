import { Router } from "express";
import { changePassword, login, logout, me, refresh, signup, updateProfile } from "../controllers/auth.controller.js";
import { baselineProtect } from "../middleware/baseline-arcjet.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate-body.js";
import { changePasswordSchema, loginSchema, signupSchema, updateProfileSchema } from "../schemas/auth.schema.js";

export const authRouter = Router();

authRouter.post("/signup", validateBody(signupSchema), signup);
authRouter.post("/login", validateBody(loginSchema), login);
authRouter.post("/logout", logout);
authRouter.post("/refresh", refresh);
authRouter.get("/session", requireAuth, me);
authRouter.patch("/profile", requireAuth, baselineProtect, validateBody(updateProfileSchema), updateProfile);
authRouter.patch("/password", requireAuth, baselineProtect, validateBody(changePasswordSchema), changePassword);

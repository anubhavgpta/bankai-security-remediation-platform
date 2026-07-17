import type { NextFunction, Request, Response } from "express";
import { baselineArcjet } from "../lib/arcjet.js";
import { assertArcjetAllowed } from "../lib/enforce-arcjet.js";

export async function baselineProtect(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const decision = await baselineArcjet.protect(req);
    assertArcjetAllowed(decision);
    next();
  } catch (err) {
    next(err);
  }
}

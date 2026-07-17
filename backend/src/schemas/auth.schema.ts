import { z } from "zod";

export const signupSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(120, "Full name is too long"),
  email: z.email("Enter a valid email address").trim().toLowerCase().max(254, "Email is too long"),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(128, "Password is too long")
    .regex(/[a-z]/, "Password must include a lowercase letter")
    .regex(/[A-Z]/, "Password must include an uppercase letter")
    .regex(/[0-9]/, "Password must include a number"),
});

export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.email("Enter a valid email address").trim().toLowerCase().max(254, "Email is too long"),
  password: z.string().min(1, "Password is required").max(128, "Password is too long"),
});

export type LoginInput = z.infer<typeof loginSchema>;

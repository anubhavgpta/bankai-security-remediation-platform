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

export const forgotPasswordSchema = z.object({
  email: z.email("Enter a valid email address").trim().toLowerCase().max(254, "Email is too long"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(120, "Full name is too long"),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password is too long")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[0-9]/, "Password must include a number");

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(128, "Password is too long"),
  newPassword: passwordSchema,
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.object({
  accessToken: z.string().min(1, "This reset link is invalid or has expired."),
  newPassword: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const deleteAccountSchema = z.object({
  // Optional: SSO-only accounts have no password to confirm with (see
  // auth.controller.ts's deleteAccount, which requires it only when the
  // account actually has a password identity).
  password: z.string().max(128, "Password is too long").optional(),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

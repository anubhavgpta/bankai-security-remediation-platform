import type { Severity, SlaStatus } from "./pipeline-types.js";

// Fixed policy, not yet configurable per project (mirrors the SLA tiers
// shown as static config in the Settings page mock).
export const SLA_POLICY_DAYS: Record<Severity, number> = {
  Critical: 7,
  High: 30,
  Medium: 90,
  Low: 180,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeSlaDueDate(severity: Severity, from: Date): string {
  const due = new Date(from);
  due.setUTCDate(due.getUTCDate() + SLA_POLICY_DAYS[severity]);
  return due.toISOString().slice(0, 10);
}

// "Approaching" fires inside the last 20% of the SLA window, matching the
// policy description shown in Settings.
export function computeSlaStatus(severity: Severity, dueDate: string | null, now: Date = new Date()): SlaStatus {
  if (!dueDate) return "On track";

  const due = new Date(`${dueDate}T00:00:00Z`);
  const totalDays = SLA_POLICY_DAYS[severity];
  const daysRemaining = Math.floor((due.getTime() - now.getTime()) / MS_PER_DAY);

  if (daysRemaining < 0) return "Missed";
  if (daysRemaining <= totalDays * 0.2) return "Approaching";
  return "On track";
}

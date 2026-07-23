import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JiraIssueSummary } from "./jira.js";

const searchIssuesInProject = vi.fn<(creds: unknown, projectKey: string) => Promise<JiraIssueSummary[]>>();
const transitionIssue = vi.fn(async () => true);
const recordActivity = vi.fn(async () => undefined);
const loggerWarn = vi.fn();

vi.mock("./jira.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jira.js")>();
  return { ...actual, searchIssuesInProject, transitionIssue };
});

vi.mock("./activity.js", () => ({ recordActivity }));

vi.mock("./logger.js", () => ({
  logger: {
    warn: loggerWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { reconcileJiraTickets, reopenTicket } = await import("./ticketing.js");

const PROJECT_ID = "95d9544e-3424-4c53-acf6-1f16496f5666";
const REPO_A = "anubhavgpta/js-test-repo-2";
const REPO_B = "anubhavgpta/js-test-repo";
const FP = "sig:src/auth.ts|CWE-79|10";

const JIRA = {
  creds: { site: "bankaisecurity.atlassian.net", email: "dev@example.com", apiToken: "token" },
  projectKey: "TT2",
};

const ACTOR = { id: "user-1", label: "test@example.com" };
const SLA = { Critical: 7, High: 14, Medium: 30, Low: 90 };

function issue(partial: Partial<JiraIssueSummary> & Pick<JiraIssueSummary, "key" | "fingerprint" | "repo">): JiraIssueSummary {
  return {
    url: `https://bankaisecurity.atlassian.net/browse/${partial.key}`,
    title: "XSS in auth",
    severity: "High",
    ...partial,
  };
}

interface MockOpts {
  findings: {
    id: string;
    fingerprint: string;
    title: string;
    service: string | null;
    severity: string;
    sla_due_date: string | null;
    bucket: string;
    tickets: { id: string }[] | null;
  }[];
  githubRepo: string | null;
  upsertFindingId?: string;
}

function makeSupabase(opts: MockOpts) {
  const ticketUpdates: { key: string; url: string }[] = [];
  const upserts: unknown[] = [];

  const supabase = {
    from(table: string) {
      if (table === "findings") {
        return {
          select() {
            return {
              eq: async () => ({ data: opts.findings, error: null }),
            };
          },
          upsert(row: unknown) {
            upserts.push(row);
            return {
              select() {
                return {
                  single: async () => ({
                    data: {
                      id: opts.upsertFindingId ?? "imported-finding",
                      title: "XSS in auth",
                      service: null,
                      severity: "High",
                      sla_due_date: null,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "projects") {
        return {
          select() {
            return {
              eq() {
                return {
                  single: async () => ({ data: { github_repo: opts.githubRepo }, error: null }),
                };
              },
            };
          },
        };
      }
      if (table === "tickets") {
        return {
          update(payload: { jira_issue_key: string; jira_issue_url: string }) {
            return {
              eq: async () => {
                ticketUpdates.push({ key: payload.jira_issue_key, url: payload.jira_issue_url });
                return { error: null };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    async rpc() {
      return {
        data: {
          id: "ticket-1",
          key: "T-1",
          title: "XSS in auth",
          service: null,
          severity: "High",
          status: "Open",
          due_date: null,
          finding_id: "finding-1",
          created_at: new Date().toISOString(),
          jira_issue_key: null,
          jira_issue_url: null,
          jira_sync_error: null,
        },
        error: null,
      };
    },
  };

  return { supabase: supabase as unknown as SupabaseClient, ticketUpdates, upserts };
}

describe("reconcileJiraTickets repo filtering", () => {
  beforeEach(() => {
    searchIssuesInProject.mockReset();
    recordActivity.mockReset();
    loggerWarn.mockReset();
  });

  it("links a same-repo Jira issue to a local finding by fingerprint", async () => {
    const { supabase, ticketUpdates } = makeSupabase({
      githubRepo: REPO_A,
      findings: [
        {
          id: "finding-1",
          fingerprint: FP,
          title: "XSS in auth",
          service: null,
          severity: "High",
          sla_due_date: null,
          bucket: "New Delta",
          tickets: [],
        },
      ],
    });
    searchIssuesInProject.mockResolvedValue([issue({ key: "TT2-7", fingerprint: FP, repo: REPO_A })]);

    const result = await reconcileJiraTickets(supabase, {
      projectId: PROJECT_ID,
      jira: JIRA,
      actor: ACTOR,
      rpcName: "create_project_ticket",
      slaPolicyDays: SLA,
    });

    expect(result).toEqual({ reconciled: 1, imported: 0 });
    expect(ticketUpdates).toEqual([{ key: "TT2-7", url: "https://bankaisecurity.atlassian.net/browse/TT2-7" }]);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("skips a different-repo Jira issue even when fingerprints collide", async () => {
    const { supabase, ticketUpdates, upserts } = makeSupabase({
      githubRepo: REPO_A,
      findings: [
        {
          id: "finding-1",
          fingerprint: FP,
          title: "XSS in auth",
          service: null,
          severity: "High",
          sla_due_date: null,
          bucket: "New Delta",
          tickets: [],
        },
      ],
    });
    searchIssuesInProject.mockResolvedValue([
      issue({ key: "TT2-7", fingerprint: FP, repo: REPO_B }),
      issue({ key: "TT2-27", fingerprint: "sig:other|CWE-89|1", repo: REPO_B }),
    ]);

    const result = await reconcileJiraTickets(supabase, {
      projectId: PROJECT_ID,
      jira: JIRA,
      actor: ACTOR,
      rpcName: "create_project_ticket",
      slaPolicyDays: SLA,
    });

    expect(result).toEqual({ reconciled: 0, imported: 0 });
    expect(ticketUpdates).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it("falls back to fingerprint-only matching for legacy issues with no Repo marker", async () => {
    const { supabase, ticketUpdates } = makeSupabase({
      githubRepo: REPO_A,
      findings: [
        {
          id: "finding-1",
          fingerprint: FP,
          title: "XSS in auth",
          service: null,
          severity: "High",
          sla_due_date: null,
          bucket: "New Delta",
          tickets: [],
        },
      ],
    });
    searchIssuesInProject.mockResolvedValue([issue({ key: "TT2-7", fingerprint: FP, repo: null })]);

    const result = await reconcileJiraTickets(supabase, {
      projectId: PROJECT_ID,
      jira: JIRA,
      actor: ACTOR,
      rpcName: "create_project_ticket",
      slaPolicyDays: SLA,
    });

    expect(result).toEqual({ reconciled: 1, imported: 0 });
    expect(ticketUpdates).toHaveLength(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ issueKey: "TT2-7", projectId: PROJECT_ID, fingerprint: FP }),
      expect.stringContaining("no Repo marker"),
    );
  });

  it("imports an unmatched same-repo issue as a jira_import finding", async () => {
    const { supabase, upserts, ticketUpdates } = makeSupabase({
      githubRepo: REPO_A,
      findings: [],
      upsertFindingId: "imported-1",
    });
    searchIssuesInProject.mockResolvedValue([
      issue({ key: "TT2-99", fingerprint: "sig:new|CWE-22|5", repo: REPO_A, title: "Path traversal" }),
    ]);

    const result = await reconcileJiraTickets(supabase, {
      projectId: PROJECT_ID,
      jira: JIRA,
      actor: ACTOR,
      rpcName: "create_project_ticket",
      slaPolicyDays: SLA,
    });

    expect(result).toEqual({ reconciled: 0, imported: 1 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual(expect.objectContaining({ fingerprint: "sig:new|CWE-22|5", source: "jira_import" }));
    expect(ticketUpdates).toHaveLength(1);
  });
});

function makeReopenSupabase(opts: {
  ticket: {
    id: string;
    key: string;
    title: string;
    status: string;
    jira_issue_key: string | null;
    findings: { bucket: string } | null;
  } | null;
}) {
  let updatedStatus: string | null = null;
  const publicTicket = {
    id: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
    key: "JST-115",
    title: "Weak Cryptographic Hash (MD5) for Passwords",
    service: null,
    severity: "High",
    status: "In Progress",
    due_date: null,
    finding_id: "3e9ebc76-c2ac-481f-b150-48c88f971eff",
    created_at: new Date().toISOString(),
    jira_issue_key: null,
    jira_issue_url: null,
    jira_sync_error: null,
    github_branch_name: null,
    github_branch_url: null,
    github_branch_error: null,
    github_pr_number: null,
    github_pr_url: null,
    github_pr_state: null,
    github_pr_error: null,
    github_pr_low_confidence: false,
    ci_status: null,
    ci_run_url: null,
    ci_error: null,
    findings: { external_id: null },
  };

  const supabase = {
    from(table: string) {
      if (table !== "tickets") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: opts.ticket, error: null }),
                  };
                },
              };
            },
          };
        },
        update(payload: { status: string }) {
          updatedStatus = payload.status;
          return {
            eq() {
              return {
                eq() {
                  return {
                    select() {
                      return {
                        maybeSingle: async () => ({
                          data: { ...publicTicket, status: payload.status },
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return { supabase: supabase as unknown as SupabaseClient, getUpdatedStatus: () => updatedStatus };
}

describe("reopenTicket", () => {
  beforeEach(() => {
    recordActivity.mockReset();
    transitionIssue.mockReset();
  });

  it("reopens a Done ticket when the finding is still open", async () => {
    const { supabase, getUpdatedStatus } = makeReopenSupabase({
      ticket: {
        id: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
        key: "JST-115",
        title: "Weak Cryptographic Hash (MD5) for Passwords",
        status: "Done",
        jira_issue_key: null,
        findings: { bucket: "In Progress" },
      },
    });

    const row = await reopenTicket(supabase, {
      projectId: PROJECT_ID,
      ticketId: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
      actor: ACTOR,
    });

    expect(getUpdatedStatus()).toBe("In Progress");
    expect(row.status).toBe("In Progress");
    expect(recordActivity).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ summary: "reopened", linkLabel: "JST-115" }),
    );
  });

  it("rejects reopening when the finding is Resolved", async () => {
    const { supabase, getUpdatedStatus } = makeReopenSupabase({
      ticket: {
        id: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
        key: "JST-115",
        title: "Weak Cryptographic Hash (MD5) for Passwords",
        status: "Done",
        jira_issue_key: null,
        findings: { bucket: "Resolved" },
      },
    });

    await expect(
      reopenTicket(supabase, {
        projectId: PROJECT_ID,
        ticketId: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("Resolved") });
    expect(getUpdatedStatus()).toBeNull();
  });

  it("rejects reopening when the ticket is not Done", async () => {
    const { supabase, getUpdatedStatus } = makeReopenSupabase({
      ticket: {
        id: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
        key: "JST-115",
        title: "Weak Cryptographic Hash (MD5) for Passwords",
        status: "In Progress",
        jira_issue_key: null,
        findings: { bucket: "In Progress" },
      },
    });

    await expect(
      reopenTicket(supabase, {
        projectId: PROJECT_ID,
        ticketId: "53c0fad8-fc90-4a53-9732-d43b7bcb8187",
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("Done") });
    expect(getUpdatedStatus()).toBeNull();
  });
});

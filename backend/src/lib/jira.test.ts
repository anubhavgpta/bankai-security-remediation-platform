import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addIssueToSprint,
  buildFindingDescription,
  getTargetSprintId,
  searchIssuesInProject,
  type FindingSummary,
  type JiraCredentials,
} from "./jira.js";

const CREDS: JiraCredentials = { site: "acme.atlassian.net", email: "dev@example.com", apiToken: "token" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockJiraFetch(handler: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    return handler(`${url.pathname}${url.search}`, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getTargetSprintId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers an active sprint when one exists", async () => {
    const fetchMock = mockJiraFetch((path) => {
      if (path === "/rest/agile/1.0/board?projectKeyOrId=BNK") return jsonResponse({ values: [{ id: 10 }] });
      if (path === "/rest/agile/1.0/board/10/sprint?state=active") return jsonResponse({ values: [{ id: 20, name: "Sprint 2" }] });
      throw new Error(`Unexpected Jira path: ${path}`);
    });

    await expect(getTargetSprintId(CREDS, "BNK")).resolves.toBe(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses future Sprint 1 when the project has no active sprint yet", async () => {
    const fetchMock = mockJiraFetch((path) => {
      if (path === "/rest/agile/1.0/board?projectKeyOrId=BNK") return jsonResponse({ values: [{ id: 10 }] });
      if (path === "/rest/agile/1.0/board/10/sprint?state=active") return jsonResponse({ values: [] });
      if (path === "/rest/agile/1.0/board/10/sprint?state=future") return jsonResponse({ values: [{ id: 30, name: "Sprint 1" }] });
      throw new Error(`Unexpected Jira path: ${path}`);
    });

    await expect(getTargetSprintId(CREDS, "BNK")).resolves.toBe(30);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("creates Sprint 1 when the scrum board has no active or future sprints", async () => {
    const fetchMock = mockJiraFetch((path, init) => {
      if (path === "/rest/agile/1.0/board?projectKeyOrId=BNK") return jsonResponse({ values: [{ id: 10 }] });
      if (path === "/rest/agile/1.0/board/10/sprint?state=active") return jsonResponse({ values: [] });
      if (path === "/rest/agile/1.0/board/10/sprint?state=future") return jsonResponse({ values: [] });
      if (path === "/rest/agile/1.0/sprint") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ name: "Sprint 1", originBoardId: 10 });
        return jsonResponse({ id: 40, name: "Sprint 1" }, 201);
      }
      throw new Error(`Unexpected Jira path: ${path}`);
    });

    await expect(getTargetSprintId(CREDS, "BNK")).resolves.toBe(40);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns null for a project with no board", async () => {
    mockJiraFetch((path) => {
      if (path === "/rest/agile/1.0/board?projectKeyOrId=BNK") return jsonResponse({ values: [] });
      throw new Error(`Unexpected Jira path: ${path}`);
    });

    await expect(getTargetSprintId(CREDS, "BNK")).resolves.toBeNull();
  });
});

describe("addIssueToSprint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns Jira's error details when sprint placement is rejected", async () => {
    mockJiraFetch((path, init) => {
      expect(path).toBe("/rest/agile/1.0/sprint/40/issue");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ issues: ["BNK-1"] });
      return jsonResponse({ errorMessages: ["Sprint is closed."] }, 400);
    });

    await expect(addIssueToSprint(CREDS, 40, "BNK-1")).resolves.toEqual({
      ok: false,
      status: 400,
      message: "Sprint is closed.",
    });
  });
});

function minimalFinding(overrides: Partial<FindingSummary> = {}): FindingSummary {
  return {
    id: "finding-1",
    fingerprint: "sig:src/auth.ts|CWE-79|10",
    externalId: null,
    title: "XSS in auth",
    severity: "High",
    cvssScore: null,
    cwe: "CWE-79",
    component: null,
    filePath: "src/auth.ts",
    findingType: null,
    sourceStatus: null,
    dateFound: null,
    description: null,
    fixAvailable: null,
    sourceUrl: null,
    commitSha: null,
    lineStart: null,
    lineEnd: null,
    teamName: null,
    service: null,
    environment: null,
    findingCount: 1,
    ttrStatus: "On Track",
    cves: null,
    repository: "anubhavgpta/js-test-repo-2",
    affectedPackages: null,
    currentVersions: null,
    fixedVersions: null,
    recommendations: null,
    ...overrides,
  };
}

describe("buildFindingDescription Repo marker", () => {
  it("writes a Repo line next to Fingerprint when the project has a github_repo", () => {
    const text = buildFindingDescription(minimalFinding());
    expect(text).toContain("Fingerprint: sig:src/auth.ts|CWE-79|10");
    expect(text).toContain("Repo: anubhavgpta/js-test-repo-2");
  });

  it("omits the Repo line when the project has no connected github_repo", () => {
    const text = buildFindingDescription(minimalFinding({ repository: null }));
    expect(text).toContain("Fingerprint: sig:src/auth.ts|CWE-79|10");
    expect(text).not.toMatch(/^Repo:/m);
  });
});

describe("searchIssuesInProject Repo parsing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function adfParagraphs(...lines: string[]) {
    return {
      type: "doc",
      content: lines.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    };
  }

  it("parses Repo onto JiraIssueSummary and does not confuse it with Repository", async () => {
    mockJiraFetch((path) => {
      expect(path).toBe("/rest/api/3/search/jql");
      return jsonResponse({
        isLast: true,
        issues: [
          {
            key: "TT2-7",
            fields: {
              summary: "[svc] XSS",
              description: adfParagraphs(
                "Repository: anubhavgpta/js-test-repo-2",
                "Fingerprint: sig:src/auth.ts|CWE-79|10",
                "Repo: anubhavgpta/js-test-repo-2",
              ),
            },
          },
          {
            key: "TT2-8",
            fields: {
              summary: "Legacy issue",
              description: adfParagraphs("Fingerprint: sig:legacy|CWE-89|1", "Repository: anubhavgpta/js-test-repo"),
            },
          },
        ],
      });
    });

    const issues = await searchIssuesInProject(CREDS, "TT2");
    expect(issues).toEqual([
      expect.objectContaining({ key: "TT2-7", fingerprint: "sig:src/auth.ts|CWE-79|10", repo: "anubhavgpta/js-test-repo-2" }),
      expect.objectContaining({ key: "TT2-8", fingerprint: "sig:legacy|CWE-89|1", repo: null }),
    ]);
  });
});

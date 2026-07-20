import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { enqueueRepoScan } from "../lib/queue.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { markTicketPrClosedWithoutMerge, markTicketPrMerged } from "../lib/ticketing.js";

interface WebhookProjectRow {
  github_default_branch: string | null;
  github_webhook_secret_enc: string | null;
  github_connected_at: string | null;
}

interface GithubPushPayload {
  ref?: string;
  before?: string;
  after?: string;
  deleted?: boolean;
}

interface GithubPullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: { merged?: boolean };
}

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  // timingSafeEqual throws on length mismatch rather than returning false —
  // guard explicitly so a wrong-length header can't crash the request.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// No requireAuth/originCheck/session in this path — GitHub calls this
// directly, server-to-server, with no cookie and (usually) no Origin
// header. The HMAC signature against this project's own webhook secret is
// the entire trust boundary here; every branch below fails closed.
export async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    // Would mean express.raw() wasn't applied to this route — a wiring bug,
    // not something a real request from GitHub could trigger.
    res.status(400).end();
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("github_default_branch, github_webhook_secret_enc, github_connected_at")
    .eq("id", projectId)
    .maybeSingle();

  const project = data as WebhookProjectRow | null;
  if (error || !project || !project.github_connected_at || !project.github_webhook_secret_enc) {
    res.status(404).end();
    return;
  }

  const secret = decrypt(project.github_webhook_secret_enc);
  if (!verifySignature(secret, rawBody, req.get("x-hub-signature-256"))) {
    logger.warn({ projectId }, "GitHub webhook signature verification failed");
    res.status(401).end();
    return;
  }

  const event = req.get("x-github-event");
  if (event === "ping") {
    res.status(200).json({ ok: true });
    return;
  }
  if (event === "pull_request") {
    await handlePullRequestEvent(projectId, rawBody, res);
    return;
  }
  if (event !== "push") {
    res.status(200).json({ ignored: true });
    return;
  }

  let payload: GithubPushPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubPushPayload;
  } catch {
    res.status(400).end();
    return;
  }

  const branch = (payload.ref ?? "").replace(/^refs\/heads\//, "");

  // Never scan pushes to the bot's own remediation branches — creating
  // tickets from a scan can itself lead to pushes on remediation/*
  // branches, and re-scanning those would be pointless busywork at best
  // and a feedback loop at worst.
  if (branch.startsWith("remediation/")) {
    res.status(200).json({ ignored: true });
    return;
  }
  if (!project.github_default_branch || branch !== project.github_default_branch) {
    res.status(200).json({ ignored: true });
    return;
  }
  if (payload.deleted || !payload.before || !payload.after) {
    res.status(200).json({ ignored: true });
    return;
  }

  const { data: scan, error: scanError } = await supabaseAdmin
    .from("scans")
    .insert({
      project_id: projectId,
      source: "github_ai",
      status: "Queued",
      trigger_type: "webhook",
      branch,
      base_commit_sha: payload.before,
      commit_sha: payload.after,
    })
    .select("id")
    .single();

  if (scanError || !scan) {
    logger.error({ err: scanError, projectId }, "Could not record a scan row for a GitHub webhook push");
    res.status(500).end();
    return;
  }

  await enqueueRepoScan(
    { scanId: scan.id, projectId, triggerType: "webhook", baseSha: payload.before, headSha: payload.after },
    `webhook-${projectId}-${payload.after}`,
  );

  // GitHub enforces a short response timeout on webhook deliveries and
  // marks them failed/retries otherwise — the scan itself runs in the
  // worker, never in this request.
  res.status(202).json({ queued: true });
}

// Signature verification already happened in handleGithubWebhook before this
// is called — same trust boundary as the push handling above. Only
// "closed" is interesting here: "opened"/"synchronize"/etc. carry nothing
// Bankai needs to act on (the ticket already moved to "In Review" when the
// fix-pr job itself opened the PR).
async function handlePullRequestEvent(projectId: string, rawBody: Buffer, res: Response): Promise<void> {
  let payload: GithubPullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubPullRequestPayload;
  } catch {
    res.status(400).end();
    return;
  }

  if (payload.action !== "closed" || typeof payload.number !== "number") {
    res.status(200).json({ ignored: true });
    return;
  }

  if (payload.pull_request?.merged) {
    await markTicketPrMerged(supabaseAdmin, { projectId, prNumber: payload.number });
  } else {
    await markTicketPrClosedWithoutMerge(supabaseAdmin, { projectId, prNumber: payload.number });
  }

  res.status(200).json({ ok: true });
}

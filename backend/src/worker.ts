import { Worker } from "bullmq";
import { processFixPrJob } from "./jobs/fix-pr.job.js";
import { processFixRetryJob } from "./jobs/fix-retry.job.js";
import { processPipelineJob } from "./jobs/pipeline.job.js";
import { processRepoScanJob } from "./jobs/repo-scan.job.js";
import { logger } from "./lib/logger.js";
import { FIX_PR_QUEUE_NAME, FIX_RETRY_QUEUE_NAME, PIPELINE_QUEUE_NAME, redisConnection, REPO_SCAN_QUEUE_NAME } from "./lib/queue.js";

// Separate process from the API server (backend/src/server.ts) —
// Gemini calls + repo fetching are slow, and a scan job crashing or OOMing
// must not take the request-handling process down with it. Run alongside
// the API server: `npm run worker` in dev, a second process/dyno in prod.
const worker = new Worker(REPO_SCAN_QUEUE_NAME, processRepoScanJob, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, data: job.data }, "Repo scan job completed");
});

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "Repo scan job failed");
});

logger.info(`Repo scan worker listening on queue "${REPO_SCAN_QUEUE_NAME}"`);

// Same process for v1 — AI fix-generation + GitHub commit/PR calls are just
// as slow/unreliable as scan calls, so they get the same crash-isolation
// rationale as above, without needing a third process yet.
const fixPrWorker = new Worker(FIX_PR_QUEUE_NAME, processFixPrJob, {
  connection: redisConnection,
  concurrency: 2,
});

fixPrWorker.on("completed", (job) => {
  logger.info({ jobId: job.id, data: job.data }, "Fix-PR job completed");
});

fixPrWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "Fix-PR job failed");
});

logger.info(`Fix-PR worker listening on queue "${FIX_PR_QUEUE_NAME}"`);

// Same process for v1, same crash-isolation rationale as the two workers
// above — dispatching/bootstrapping GitHub Actions runs is just as slow and
// external-API-dependent.
const pipelineWorker = new Worker(PIPELINE_QUEUE_NAME, processPipelineJob, {
  connection: redisConnection,
  concurrency: 2,
});

pipelineWorker.on("completed", (job) => {
  logger.info({ jobId: job.id, data: job.data }, "CI pipeline job completed");
});

pipelineWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "CI pipeline job failed");
});

logger.info(`CI pipeline worker listening on queue "${PIPELINE_QUEUE_NAME}"`);

// Same process for v1, same crash-isolation rationale as the three workers
// above — regenerating a fix (another Gemini call) plus another GitHub
// commit/comment round-trip is just as slow/external-API-dependent.
const fixRetryWorker = new Worker(FIX_RETRY_QUEUE_NAME, processFixRetryJob, {
  connection: redisConnection,
  concurrency: 2,
});

fixRetryWorker.on("completed", (job) => {
  logger.info({ jobId: job.id, data: job.data }, "Fix-retry job completed");
});

fixRetryWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "Fix-retry job failed");
});

logger.info(`Fix-retry worker listening on queue "${FIX_RETRY_QUEUE_NAME}"`);

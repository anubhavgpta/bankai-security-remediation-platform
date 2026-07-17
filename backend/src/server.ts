import { createApp } from "./app.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`Bankai backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});

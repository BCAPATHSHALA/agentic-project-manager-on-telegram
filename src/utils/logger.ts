// src/utils/logger.ts
import pino from "pino";
import { config } from "./config";

const logger = pino({
  level: config.LOG_LEVEL,

  // Pretty logs in dev, raw JSON in production
  // Raw JSON is better for Railway/Render log viewers
  transport: config.isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss",
          messageFormat: "{msg}",
        },
      }
    : undefined,
});

export default logger;

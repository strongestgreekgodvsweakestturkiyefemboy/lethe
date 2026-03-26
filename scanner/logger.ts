import path from 'path';
import fs from 'fs';
import winston from 'winston';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'debug';
const LOG_DIR = process.env.LOG_DIR ?? path.resolve(process.cwd(), '../logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} [scanner] ${level}: ${message}${metaStr}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'scanner.log'),
      maxsize: 10 * 1024 * 1024, // 10 MiB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

export default logger;

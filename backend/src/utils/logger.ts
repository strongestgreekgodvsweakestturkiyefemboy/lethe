import path from 'path';
import fs from 'fs';
import winston from 'winston';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'debug';
const LOG_DIR = process.env.LOG_DIR ?? path.resolve(process.cwd(), '../logs');

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [backend] ${level}: ${message}${metaStr}`;
    })
  ),
});

const transports: winston.transport[] = [consoleTransport];

// Attempt to set up file logging; if the log directory cannot be created
// (e.g. wrong LOG_DIR value, permission denied) fall back to console-only so
// the server still starts and at least logs to stdout.
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  transports.push(
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'backend.log'),
      maxsize: 10 * 1024 * 1024, // 10 MiB
      maxFiles: 5,
      tailable: true,
    })
  );
} catch (err) {
  // Log to console only — don't let a bad LOG_DIR crash the process
  console.error(`[backend] WARNING: could not initialise file logging (LOG_DIR=${LOG_DIR}):`, err);
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports,
});

export default logger;

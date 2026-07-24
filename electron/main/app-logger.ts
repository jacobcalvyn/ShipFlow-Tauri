import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";

export type AppLogLevel = "INFO" | "WARN" | "ERROR";
export type AppLogFieldValue = boolean | number | string | null | undefined;
export type AppLogFields = Record<string, AppLogFieldValue>;

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES = 32 * 1024;
const MAX_BUFFERED_STREAM_BYTES = 64 * 1024;
const TOKEN_PATTERN = /\bsf_[a-zA-Z0-9_-]{16,}\b/g;
const AUTHORIZATION_PATTERN =
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi;
const SECRET_FIELD_PATTERN =
  /((?:auth[_-]?token|api[_-]?key|cookie|password|secret|token)\s*["']?\s*[:=]\s*["']?)[^"',;\s}\\]+/gi;

function messageText(message: unknown) {
  if (message instanceof Error) {
    return message.stack || `${message.name}: ${message.message}`;
  }
  return String(message);
}

function redactMessage(message: unknown) {
  return messageText(message)
    .replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(
      AUTHORIZATION_PATTERN,
      (_match, prefix: string, bearer: string | undefined) =>
        `${prefix}${bearer ?? ""}[REDACTED]`,
    )
    .replace(SECRET_FIELD_PATTERN, "$1[REDACTED]")
    .replace(/\r?\n/g, "\\n");
}

function boundedMessage(message: unknown) {
  const redacted = redactMessage(message);
  if (Buffer.byteLength(redacted) <= MAX_LOG_ENTRY_BYTES) {
    return redacted;
  }
  let truncated = redacted.slice(0, MAX_LOG_ENTRY_BYTES);
  while (Buffer.byteLength(truncated) > MAX_LOG_ENTRY_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}[TRUNCATED]`;
}

function structuredFields(fields: AppLogFields) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export class FileAppLogger {
  readonly filePath: string;
  readonly backupPath: string;
  readonly sessionId = randomUUID();
  readonly #maxFileBytes: number;
  #currentBytes = 0;
  #initialized = false;
  #lastError: Error | null = null;
  #queue: Promise<void> = Promise.resolve();
  #sequence = 0;

  constructor(filePath: string, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.1`;
    this.#maxFileBytes = maxFileBytes;
  }

  info(scope: string, message: unknown) {
    this.write("INFO", scope, message);
  }

  warn(scope: string, message: unknown) {
    this.write("WARN", scope, message);
  }

  error(scope: string, message: unknown) {
    this.write("ERROR", scope, message);
  }

  event(
    level: AppLogLevel,
    scope: string,
    eventName: string,
    fields: AppLogFields = {},
  ) {
    this.write(
      level,
      scope,
      `event=${eventName} data=${JSON.stringify(structuredFields(fields))}`,
    );
  }

  write(level: AppLogLevel, scope: string, message: unknown) {
    this.#sequence += 1;
    const line = `[${new Date().toISOString()}] [${level}] [${boundedMessage(scope)}] ${boundedMessage(message)} | session=${this.sessionId} sequence=${this.#sequence}\n`;
    process.stderr.write(line);
    this.#enqueue(async () => {
      await this.#initialize();
      const lineBytes = Buffer.byteLength(line);
      if (this.#currentBytes > 0 && this.#currentBytes + lineBytes > this.#maxFileBytes) {
        await this.#rotate();
      }
      await appendFile(this.filePath, line, "utf8");
      this.#currentBytes += lineBytes;
      this.#lastError = null;
    });
  }

  async ensureFile() {
    await this.#queue;
    if (this.#lastError) {
      throw this.#lastError;
    }
    await this.#initialize();
    return this.filePath;
  }

  async flush() {
    await this.#queue;
  }

  #enqueue(operation: () => Promise<void>) {
    this.#queue = this.#queue.then(operation, operation).catch((error) => {
      this.#lastError = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`[ShipFlowLogger] ${String(error)}\n`);
    });
  }

  async #initialize() {
    if (this.#initialized) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const metadata = await stat(this.filePath);
      this.#currentBytes = metadata.size;
      if (this.#currentBytes >= this.#maxFileBytes) {
        await this.#rotate();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await writeFile(this.filePath, "", { flag: "a" });
      this.#currentBytes = 0;
    }
    this.#initialized = true;
  }

  async #rotate() {
    await unlink(this.backupPath).catch(() => undefined);
    await rename(this.filePath, this.backupPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await writeFile(this.filePath, "", "utf8");
    this.#currentBytes = 0;
  }
}

let activeLogger: FileAppLogger | null = null;

export function configureAppLogger(filePath: string) {
  activeLogger = new FileAppLogger(filePath);
  return activeLogger;
}

export const appLogger = {
  get filePath() {
    if (!activeLogger) {
      throw new Error("ShipFlow app logger has not been configured.");
    }
    return activeLogger.filePath;
  },
  info(scope: string, message: unknown) {
    activeLogger?.info(scope, message);
  },
  warn(scope: string, message: unknown) {
    activeLogger?.warn(scope, message);
  },
  error(scope: string, message: unknown) {
    activeLogger?.error(scope, message);
  },
  write(level: AppLogLevel, scope: string, message: unknown) {
    activeLogger?.write(level, scope, message);
  },
  event(
    level: AppLogLevel,
    scope: string,
    eventName: string,
    fields: AppLogFields = {},
  ) {
    activeLogger?.event(level, scope, eventName, fields);
  },
  async ensureFile() {
    if (!activeLogger) {
      throw new Error("ShipFlow app logger has not been configured.");
    }
    return activeLogger.ensureFile();
  },
  async flush() {
    await activeLogger?.flush();
  },
};

export function pipeTextStreamToAppLogger(
  stream: Readable,
  scope: string,
  level: AppLogLevel,
) {
  let buffered = "";
  stream.setEncoding("utf8");

  const flushCompleteLines = () => {
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      buffered = buffered.slice(newlineIndex + 1);
      if (line) {
        appLogger.write(level, scope, line);
      }
      newlineIndex = buffered.indexOf("\n");
    }
    if (Buffer.byteLength(buffered) > MAX_BUFFERED_STREAM_BYTES) {
      appLogger.write(level, scope, `${buffered.slice(0, MAX_LOG_ENTRY_BYTES)}[STREAM_TRUNCATED]`);
      buffered = "";
    }
  };

  const handleData = (chunk: string | Buffer) => {
    buffered += chunk.toString();
    flushCompleteLines();
  };
  const handleEnd = () => {
    if (buffered) {
      appLogger.write(level, scope, buffered);
      buffered = "";
    }
  };
  const handleError = (error: Error) => {
    appLogger.error(scope, `Log stream failed: ${error.stack || error.message}`);
  };

  stream.on("data", handleData);
  stream.once("end", handleEnd);
  stream.once("error", handleError);

  return () => {
    stream.off("data", handleData);
    stream.off("end", handleEnd);
    stream.off("error", handleError);
  };
}

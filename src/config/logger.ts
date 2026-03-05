type Level = "debug" | "info" | "warn" | "error";

const levelOrder: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
const isPrettyDev = (process.env.NODE_ENV ?? "development") !== "production";

const levelColor: Record<Level, string> = {
  debug: "\u001b[36m",
  info: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};

const resetColor = "\u001b[0m";

function formatContext(context?: Record<string, unknown>): string {
  if (!context) return "";
  const entries = Object.entries(context);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      if (value === undefined) return `${key}=undefined`;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `${key}=${value}`;
      }
      return `${key}=${JSON.stringify(value)}`;
    })
    .join(" ");
}

function log(level: Level, message: string, context?: Record<string, unknown>): void {
  if (levelOrder[level] < levelOrder[currentLevel]) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
  };

  if (isPrettyDev) {
    const ts = payload.ts;
    const levelText = `${levelColor[level]}${level.toUpperCase()}${resetColor}`;
    const contextText = formatContext(context);
    const line = contextText.length > 0 ? `${ts} ${levelText} ${message} ${contextText}` : `${ts} ${levelText} ${message}`;

    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
    return;
  }

  const serialized = JSON.stringify(payload);
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  console.log(serialized);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};

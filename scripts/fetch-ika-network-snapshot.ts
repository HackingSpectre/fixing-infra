/// <reference types="node" />

/**
 * Autonomous IKA network snapshot watcher (DB-backed, token-only bot mode).
 *
 * Design goals:
 * - Runs as a standalone infra worker (separate from API + existing Telegram logic).
 * - Persists durable state in Postgres so Render restarts are safe.
 * - Retries forever with operator-friendly cooldown policy.
 * - Uses only Telegram bot token: chats are auto-discovered via bot commands.
 */

import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, desc, eq, sql } from "drizzle-orm";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Curve, IkaClient, getNetworkConfig } from "@ika.xyz/sdk";
import { infraSnapshots, infraTelegramSubscriptions, infraWorkerState } from "../src/db/schema";

type SupportedNetwork = "testnet" | "mainnet";
type DbSslMode = "auto" | "require" | "disable";

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_REFRESH_MS = 6 * 60 * 60_000;
const DEFAULT_JITTER_PCT = 0.2;
const DEFAULT_FAILURE_BATCH_SIZE = 30;
const DEFAULT_BATCH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_WORKER_NAME = "ika_snapshot_watcher";
const DEFAULT_BOT_POLL_TIMEOUT_SECONDS = 25;
const RETRY_FALLBACK_ON_BOT_ERROR_MS = 5_000;

interface RuntimeConfig {
  network: SupportedNetwork;
  rpcCandidates: string[];
  workerName: string;
  databaseUrl: string;
  dbSslMode: DbSslMode;
  outputPath?: string;
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  refreshIntervalMs: number;
  jitterPct: number;
  failureBatchSize: number;
  batchCooldownMs: number;
  watchMode: boolean;
  botToken?: string;
  botPollTimeoutSeconds: number;
  startedAt: Date;
}

let lastErrorMessage: string | null = null;

interface SnapshotPayload {
  meta: {
    exportedAt: string;
    network: SupportedNetwork;
    rpcUrl: string;
    sdkVersion: string;
    generator: string;
    watcherVersion: string;
  };
  encryptionKeys: unknown[];
  protocolParams: {
    secp256k1: unknown;
    ed25519: unknown;
  };
}

interface PersistedState {
  workerName: string;
  telegramLastUpdateId: number;
  lastSuccessAt?: string;
  lastSuccessHash?: string;
  lastNotifiedHash?: string;
  consecutiveFailures: number;
  totalAttempts: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: number;
      type?: string;
    };
    from?: {
      id?: number;
      username?: string;
      first_name?: string;
    };
  };
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const entry of argv) {
    if (!entry.startsWith("--")) continue;
    const trimmed = entry.slice(2);
    const eqIndex = trimmed.indexOf("=");

    if (eqIndex === -1) {
      out[trimmed] = "true";
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key.length > 0) out[key] = value;
  }

  return out;
}

function parseNetwork(value: string | undefined): SupportedNetwork {
  const candidate = (value ?? "testnet").toLowerCase();
  if (candidate !== "testnet" && candidate !== "mainnet") {
    throw new Error(`Invalid network '${value}'. Allowed: testnet | mainnet.`);
  }
  return candidate;
}

function requireNonEmpty(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required value for ${name}.`);
  }
  return value.trim();
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} '${raw}'. Must be a positive integer.`);
  }
  return parsed;
}

function parseDecimalBetweenZeroAndOne(name: string, value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${name} '${raw}'. Must be between 0 and 1.`);
  }
  return parsed;
}

function parseDbSslMode(value: string | undefined): DbSslMode {
  const normalized = (value ?? "auto").trim().toLowerCase();
  if (normalized === "auto" || normalized === "require" || normalized === "disable") {
    return normalized;
  }
  throw new Error(`Invalid dbSslMode '${value}'. Allowed: auto | require | disable.`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function buildRpcCandidates(primary?: string, fallbacksCsv?: string): string[] {
  const list: string[] = [];
  if (primary && primary.trim().length > 0) list.push(primary.trim());

  if (fallbacksCsv && fallbacksCsv.trim().length > 0) {
    for (const entry of fallbacksCsv.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) list.push(trimmed);
    }
  }

  const seen = new Set<string>();
  const deduped = list.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });

  if (deduped.length === 0) {
    throw new Error("No RPC candidates provided. Set --rpc or IKA_SUI_RPC_URL.");
  }

  return deduped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSslMode(connectionString: string, dbSslMode: DbSslMode): "require" | false {
  if (dbSslMode === "require") return "require";
  if (dbSslMode === "disable") return false;

  try {
    const host = new URL(connectionString).hostname.toLowerCase();
    const localHosts = new Set(["localhost", "127.0.0.1"]);
    return localHosts.has(host) ? false : "require";
  } catch {
    return "require";
  }
}

function createDb(config: RuntimeConfig) {
  const queryClient = postgres(config.databaseUrl, {
    max: 3,
    idle_timeout: 30,
    connect_timeout: 30,
    ssl: resolveSslMode(config.databaseUrl, config.dbSslMode),
    prepare: false,
    onnotice: () => {},
  });

  const db = drizzle(queryClient);
  return { db, queryClient };
}

async function ensureWorkerTables(db: ReturnType<typeof drizzle>): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS infra_snapshots (
      id uuid PRIMARY KEY,
      snapshot_type text NOT NULL,
      network text NOT NULL,
      rpc_url text NOT NULL,
      snapshot_hash text NOT NULL,
      key_count integer NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS infra_snapshots_hash_unique
    ON infra_snapshots (snapshot_hash)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS infra_snapshots_type_created_idx
    ON infra_snapshots (snapshot_type, created_at)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS infra_worker_state (
      worker_name text PRIMARY KEY,
      consecutive_failures integer NOT NULL DEFAULT 0,
      total_attempts bigint NOT NULL DEFAULT 0,
      telegram_last_update_id bigint NOT NULL DEFAULT 0,
      last_success_hash text,
      last_success_at timestamptz,
      last_notified_hash text,
      last_notified_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    ALTER TABLE infra_worker_state
    ADD COLUMN IF NOT EXISTS telegram_last_update_id bigint NOT NULL DEFAULT 0
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS infra_telegram_subscriptions (
      worker_name text NOT NULL,
      chat_id text NOT NULL,
      user_id text,
      username text,
      first_name text,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT infra_telegram_subscriptions_pk PRIMARY KEY (worker_name, chat_id)
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS infra_telegram_subscriptions_worker_seen_idx
    ON infra_telegram_subscriptions (worker_name, last_seen_at)
  `);
}

function computeBackoffDelayMs(
  failureCount: number,
  initialDelayMs: number,
  maxDelayMs: number,
  jitterPct: number,
): number {
  const expDelay = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, failureCount - 1));
  const jitterRange = Math.floor(expDelay * jitterPct);
  if (jitterRange <= 0) return expDelay;

  const min = Math.max(1, expDelay - jitterRange);
  const max = expDelay + jitterRange;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function computeRetryDelayMs(config: RuntimeConfig, consecutiveFailures: number): number {
  if (consecutiveFailures > 0 && consecutiveFailures % config.failureBatchSize === 0) {
    return config.batchCooldownMs;
  }

  return computeBackoffDelayMs(
    consecutiveFailures,
    config.initialDelayMs,
    config.maxDelayMs,
    config.jitterPct,
  );
}

async function sendTelegramMessage(token: string, chatId: string, message: string): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no-body>");
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }
}

async function fetchTelegramUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  const endpoint = `https://api.telegram.org/bot${token}/getUpdates`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no-body>");
    throw new Error(`Telegram getUpdates failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[] };
  if (!payload.ok || !Array.isArray(payload.result)) {
    return [];
  }

  return payload.result;
}

async function withTimeout<T>(label: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchSnapshotOnce(
  network: SupportedNetwork,
  rpcUrl: string,
  timeoutMs: number,
): Promise<{ payload: SnapshotPayload; hash: string }> {
  console.log(`[snapshot] Initializing clients using RPC: ${rpcUrl}`);
  const suiClient = new SuiJsonRpcClient({ url: rpcUrl, network });

  const ikaClient = new IkaClient({
    suiClient,
    config: getNetworkConfig(network),
    cache: true,
    encryptionKeyOptions: { autoDetect: true },
  });

  await withTimeout("ikaClient.initialize", timeoutMs, ikaClient.initialize());

  const encryptionKeys = await withTimeout(
    "getAllNetworkEncryptionKeys",
    timeoutMs,
    ikaClient.getAllNetworkEncryptionKeys(),
  );

  if (!Array.isArray(encryptionKeys) || encryptionKeys.length === 0) {
    throw new Error("Encryption-key fetch returned empty result.");
  }

  const [secp256k1Params, ed25519Params] = await Promise.all([
    withTimeout(
      "getProtocolPublicParameters(SECP256K1)",
      timeoutMs,
      ikaClient.getProtocolPublicParameters(undefined, Curve.SECP256K1),
    ),
    withTimeout(
      "getProtocolPublicParameters(ED25519)",
      timeoutMs,
      ikaClient.getProtocolPublicParameters(undefined, Curve.ED25519),
    ),
  ]);

  const exportedAt = new Date().toISOString();

  const payload: SnapshotPayload = {
    meta: {
      exportedAt,
      network,
      rpcUrl,
      sdkVersion: "@ika.xyz/sdk@0.3.1",
      generator: "scripts/fetch-ika-network-snapshot.ts",
      watcherVersion: "1.1.0",
    },
    encryptionKeys,
    protocolParams: {
      secp256k1: secp256k1Params,
      ed25519: ed25519Params,
    },
  };

  // Hash from components to avoid serializing the entire (possibly huge) payload into one string
  const hasher = createHash("sha256");
  hasher.update(network);
  hasher.update(rpcUrl);
  hasher.update(JSON.stringify(encryptionKeys));
  // Protocol params can be very large — hash their stringified forms incrementally
  hasher.update(JSON.stringify(secp256k1Params));
  hasher.update(JSON.stringify(ed25519Params));
  const hash = hasher.digest("hex");

  return { payload, hash };
}

async function persistSnapshotFile(outputPath: string, payload: SnapshotPayload): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });

  try {
    const json = JSON.stringify(payload, null, 2) + "\n";
    await writeFile(outputPath, json, "utf8");

    const safeStamp = payload.meta.exportedAt.replace(/[:.]/g, "-");
    const historyPath = outputPath.replace(/\.json$/i, `.${safeStamp}.json`);
    await writeFile(historyPath, json, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[watcher] File export failed (payload too large?): ${msg}`);
  }
}

async function readWorkerState(
  db: ReturnType<typeof drizzle>,
  workerName: string,
): Promise<PersistedState> {
  const rows = await db
    .select()
    .from(infraWorkerState)
    .where(eq(infraWorkerState.workerName, workerName))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      workerName,
      telegramLastUpdateId: 0,
      consecutiveFailures: 0,
      totalAttempts: 0,
    };
  }

  return {
    workerName,
    telegramLastUpdateId: row.telegramLastUpdateId,
    lastSuccessAt: row.lastSuccessAt?.toISOString(),
    lastSuccessHash: row.lastSuccessHash ?? undefined,
    lastNotifiedHash: row.lastNotifiedHash ?? undefined,
    consecutiveFailures: row.consecutiveFailures,
    totalAttempts: row.totalAttempts,
  };
}

async function writeWorkerState(db: ReturnType<typeof drizzle>, state: PersistedState): Promise<void> {
  await db
    .insert(infraWorkerState)
    .values({
      workerName: state.workerName,
      consecutiveFailures: state.consecutiveFailures,
      totalAttempts: state.totalAttempts,
      telegramLastUpdateId: state.telegramLastUpdateId,
      lastSuccessHash: state.lastSuccessHash,
      lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt) : null,
      lastNotifiedHash: state.lastNotifiedHash,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: infraWorkerState.workerName,
      set: {
        consecutiveFailures: state.consecutiveFailures,
        totalAttempts: state.totalAttempts,
        telegramLastUpdateId: state.telegramLastUpdateId,
        lastSuccessHash: state.lastSuccessHash,
        lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt) : null,
        lastNotifiedHash: state.lastNotifiedHash,
        updatedAt: new Date(),
      },
    });
}

async function insertSnapshotIfNew(
  db: ReturnType<typeof drizzle>,
  payload: SnapshotPayload,
  hash: string,
): Promise<boolean> {
  const result = await db
    .insert(infraSnapshots)
    .values({
      id: randomUUID(),
      snapshotType: "ika_network_snapshot",
      network: payload.meta.network,
      rpcUrl: payload.meta.rpcUrl,
      snapshotHash: hash,
      keyCount: payload.encryptionKeys.length,
      payload,
    })
    .onConflictDoNothing({
      target: infraSnapshots.snapshotHash,
    })
    .returning({ id: infraSnapshots.id });

  return result.length > 0;
}

async function upsertSubscription(
  db: ReturnType<typeof drizzle>,
  workerName: string,
  chatId: string,
  userId?: string,
  username?: string,
  firstName?: string,
): Promise<void> {
  await db
    .insert(infraTelegramSubscriptions)
    .values({
      workerName,
      chatId,
      userId,
      username,
      firstName,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [infraTelegramSubscriptions.workerName, infraTelegramSubscriptions.chatId],
      set: {
        userId,
        username,
        firstName,
        lastSeenAt: new Date(),
      },
    });
}

async function getSubscriptionChatIds(db: ReturnType<typeof drizzle>, workerName: string): Promise<string[]> {
  const rows = await db
    .select({ chatId: infraTelegramSubscriptions.chatId })
    .from(infraTelegramSubscriptions)
    .where(eq(infraTelegramSubscriptions.workerName, workerName));

  return rows.map((row) => row.chatId);
}

async function removeSubscription(
  db: ReturnType<typeof drizzle>,
  workerName: string,
  chatId: string,
): Promise<boolean> {
  const result = await db
    .delete(infraTelegramSubscriptions)
    .where(
      and(
        eq(infraTelegramSubscriptions.workerName, workerName),
        eq(infraTelegramSubscriptions.chatId, chatId),
      ),
    )
    .returning({ chatId: infraTelegramSubscriptions.chatId });
  return result.length > 0;
}

async function getSubscriberCount(db: ReturnType<typeof drizzle>, workerName: string): Promise<number> {
  const rows = await db
    .select({ chatId: infraTelegramSubscriptions.chatId })
    .from(infraTelegramSubscriptions)
    .where(eq(infraTelegramSubscriptions.workerName, workerName));
  return rows.length;
}

async function getSnapshotHistory(
  db: ReturnType<typeof drizzle>,
  limit: number = 5,
): Promise<{ hash: string; createdAt: string; keyCount: number; rpcUrl: string; network: string }[]> {
  const rows = await db
    .select({
      hash: infraSnapshots.snapshotHash,
      createdAt: infraSnapshots.createdAt,
      keyCount: infraSnapshots.keyCount,
      rpcUrl: infraSnapshots.rpcUrl,
      network: infraSnapshots.network,
    })
    .from(infraSnapshots)
    .where(eq(infraSnapshots.snapshotType, "ika_network_snapshot"))
    .orderBy(desc(infraSnapshots.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    hash: row.hash,
    createdAt: row.createdAt.toISOString(),
    keyCount: row.keyCount,
    rpcUrl: row.rpcUrl,
    network: row.network,
  }));
}

function formatUptime(startedAt: Date): string {
  const totalSec = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatConfigMessage(config: RuntimeConfig): string {
  return [
    "Watcher configuration",
    `worker: ${config.workerName}`,
    `network: ${config.network}`,
    `rpcCount: ${config.rpcCandidates.length}`,
    `watchMode: ${config.watchMode}`,
    `refreshInterval: ${config.refreshIntervalMs}ms`,
    `timeout: ${config.timeoutMs}ms`,
    `failureBatchSize: ${config.failureBatchSize}`,
    `batchCooldown: ${config.batchCooldownMs}ms`,
    `fileExport: ${config.outputPath ?? "disabled"}`,
    `bot: ${config.botToken ? "enabled" : "disabled"}`,
  ].join("\n");
}

async function getLatestSnapshotSummary(
  db: ReturnType<typeof drizzle>,
): Promise<{ hash: string; createdAt: string; keyCount: number; rpcUrl: string; network: string } | null> {
  const rows = await db
    .select({
      hash: infraSnapshots.snapshotHash,
      createdAt: infraSnapshots.createdAt,
      keyCount: infraSnapshots.keyCount,
      rpcUrl: infraSnapshots.rpcUrl,
      network: infraSnapshots.network,
    })
    .from(infraSnapshots)
    .where(eq(infraSnapshots.snapshotType, "ika_network_snapshot"))
    .orderBy(desc(infraSnapshots.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    hash: row.hash,
    createdAt: row.createdAt.toISOString(),
    keyCount: row.keyCount,
    rpcUrl: row.rpcUrl,
    network: row.network,
  };
}

function normalizeCommand(text: string | undefined): string {
  if (!text) return "";
  const first = text.trim().split(/\s+/)[0] ?? "";
  const lower = first.toLowerCase();
  const atIndex = lower.indexOf("@");
  return atIndex >= 0 ? lower.slice(0, atIndex) : lower;
}

function buildStatusMessage(state: PersistedState, snapshot: Awaited<ReturnType<typeof getLatestSnapshotSummary>>): string {
  if (!snapshot) {
    return [
      "IKA watcher status",
      `worker: ${state.workerName}`,
      "snapshot: not found yet",
      `attempts: ${state.totalAttempts}`,
      `consecutiveFailures: ${state.consecutiveFailures}`,
      `lastSuccessAt: ${state.lastSuccessAt ?? "none"}`,
    ].join("\n");
  }

  return [
    "IKA watcher status",
    `worker: ${state.workerName}`,
    `snapshotHash: ${snapshot.hash}`,
    `snapshotCreatedAt: ${snapshot.createdAt}`,
    `network: ${snapshot.network}`,
    `rpc: ${snapshot.rpcUrl}`,
    `keyCount: ${snapshot.keyCount}`,
    `attempts: ${state.totalAttempts}`,
    `consecutiveFailures: ${state.consecutiveFailures}`,
    `lastSuccessAt: ${state.lastSuccessAt ?? "none"}`,
  ].join("\n");
}

async function broadcastToSubscribers(
  config: RuntimeConfig,
  db: ReturnType<typeof drizzle>,
  message: string,
): Promise<void> {
  if (!config.botToken) return;

  const chatIds = await getSubscriptionChatIds(db, config.workerName);
  for (const chatId of chatIds) {
    try {
      await sendTelegramMessage(config.botToken, chatId, message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[bot] Failed to send to chat ${chatId}: ${msg}`);
    }
  }
}

async function processTelegramCommands(
  config: RuntimeConfig,
  db: ReturnType<typeof drizzle>,
  state: PersistedState,
  maxWaitSeconds: number,
): Promise<void> {
  if (!config.botToken) return;

  const updates = await fetchTelegramUpdates(
    config.botToken,
    state.telegramLastUpdateId + 1,
    Math.max(1, Math.min(config.botPollTimeoutSeconds, maxWaitSeconds)),
  );

  if (updates.length === 0) return;

  let maxUpdateId = state.telegramLastUpdateId;

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);

    const text = update.message?.text;
    const chatIdRaw = update.message?.chat?.id;
    if (!text || typeof chatIdRaw !== "number") continue;

    const chatId = String(chatIdRaw);
    const userId = typeof update.message?.from?.id === "number" ? String(update.message.from.id) : undefined;
    const username = update.message?.from?.username;
    const firstName = update.message?.from?.first_name;

    await upsertSubscription(db, config.workerName, chatId, userId, username, firstName);

    const cmd = normalizeCommand(text);
    const knownCommands = ["/start", "/help", "/status", "/last", "/ping", "/uptime", "/rpcs", "/subscribers", "/config", "/stop", "/history", "/errors"];
    if (!knownCommands.includes(cmd)) {
      await sendTelegramMessage(
        config.botToken,
        chatId,
        "Unknown command. Send /help to see all available commands.",
      ).catch(() => {});
      continue;
    }

    if (cmd === "/start" || cmd === "/help") {
      await sendTelegramMessage(
        config.botToken,
        chatId,
        [
          "IKA snapshot watcher bot",
          "",
          "Commands:",
          "/status - worker state & latest snapshot",
          "/last - latest stored snapshot details",
          "/history - last 5 stored snapshots",
          "/ping - check if bot is alive",
          "/uptime - how long the watcher has been running",
          "/rpcs - list configured RPC endpoints",
          "/config - show watcher configuration",
          "/subscribers - number of subscribed chats",
          "/errors - recent failure info",
          "/stop - unsubscribe from updates",
          "/help - show this help",
          "",
          "This chat is subscribed for watcher updates.",
        ].join("\n"),
      ).catch(() => {});
      continue;
    }

    if (cmd === "/ping") {
      await sendTelegramMessage(
        config.botToken,
        chatId,
        `pong (uptime: ${formatUptime(config.startedAt)})`,
      ).catch(() => {});
      continue;
    }

    if (cmd === "/uptime") {
      const uptime = formatUptime(config.startedAt);
      await sendTelegramMessage(
        config.botToken,
        chatId,
        [
          "Watcher uptime",
          `started: ${config.startedAt.toISOString()}`,
          `uptime: ${uptime}`,
        ].join("\n"),
      ).catch(() => {});
      continue;
    }

    if (cmd === "/rpcs") {
      const lines = config.rpcCandidates.map((url, i) => `${i + 1}. ${url}`);
      await sendTelegramMessage(
        config.botToken,
        chatId,
        [`RPC endpoints (${config.rpcCandidates.length}):`, ...lines].join("\n"),
      ).catch(() => {});
      continue;
    }

    if (cmd === "/config") {
      await sendTelegramMessage(config.botToken, chatId, formatConfigMessage(config)).catch(() => {});
      continue;
    }

    if (cmd === "/subscribers") {
      const count = await getSubscriberCount(db, config.workerName);
      await sendTelegramMessage(
        config.botToken,
        chatId,
        `Subscribed chats: ${count}`,
      ).catch(() => {});
      continue;
    }

    if (cmd === "/errors") {
      const msg = [
        "Error info",
        `consecutiveFailures: ${state.consecutiveFailures}`,
        `totalAttempts: ${state.totalAttempts}`,
        `lastError: ${lastErrorMessage ?? "none"}`,
        `failureBatchSize: ${config.failureBatchSize}`,
        `batchCooldown: ${config.batchCooldownMs}ms`,
      ].join("\n");
      await sendTelegramMessage(config.botToken, chatId, msg).catch(() => {});
      continue;
    }

    if (cmd === "/stop") {
      const removed = await removeSubscription(db, config.workerName, chatId);
      await sendTelegramMessage(
        config.botToken,
        chatId,
        removed
          ? "You have been unsubscribed from watcher updates. Send /start to re-subscribe."
          : "You were not subscribed.",
      ).catch(() => {});
      continue;
    }

    if (cmd === "/history") {
      const snapshots = await getSnapshotHistory(db, 5);
      if (snapshots.length === 0) {
        await sendTelegramMessage(config.botToken, chatId, "No snapshots stored yet.").catch(() => {});
        continue;
      }
      const lines = snapshots.map(
        (s, i) => `${i + 1}. ${s.createdAt}\n   hash: ${s.hash.slice(0, 12)}...\n   keys: ${s.keyCount} | rpc: ${s.rpcUrl}`,
      );
      await sendTelegramMessage(
        config.botToken,
        chatId,
        [`Last ${snapshots.length} snapshots:`, "", ...lines].join("\n"),
      ).catch(() => {});
      continue;
    }

    if (cmd === "/status") {
      const latest = await getLatestSnapshotSummary(db);
      await sendTelegramMessage(config.botToken, chatId, buildStatusMessage(state, latest)).catch(() => {});
      continue;
    }

    if (cmd === "/last") {
      const latest = await getLatestSnapshotSummary(db);
      const message = latest
        ? [
            "Latest IKA snapshot",
            `hash: ${latest.hash}`,
            `createdAt: ${latest.createdAt}`,
            `network: ${latest.network}`,
            `rpc: ${latest.rpcUrl}`,
            `keyCount: ${latest.keyCount}`,
          ].join("\n")
        : "No snapshot has been stored yet.";
      await sendTelegramMessage(config.botToken, chatId, message).catch(() => {});
    }
  }

  if (maxUpdateId > state.telegramLastUpdateId) {
    state.telegramLastUpdateId = maxUpdateId;
    await writeWorkerState(db, state);
  }
}

async function waitWithBotPolling(
  config: RuntimeConfig,
  db: ReturnType<typeof drizzle>,
  state: PersistedState,
  totalMs: number,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < totalMs) {
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, totalMs - elapsed);
    if (remaining <= 0) break;

    const pollWindowSeconds = Math.max(1, Math.min(config.botPollTimeoutSeconds, Math.floor(remaining / 1000)));

    try {
      await processTelegramCommands(config, db, state, pollWindowSeconds);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[bot] Command polling error: ${msg}`);
      await sleep(Math.min(RETRY_FALLBACK_ON_BOT_ERROR_MS, remaining));
    }
  }
}

function buildRuntimeConfig(): RuntimeConfig {
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  const args = parseCliArgs(process.argv.slice(2));

  const network = parseNetwork(args.network ?? process.env.IKA_NETWORK);
  const rpcCandidates = buildRpcCandidates(args.rpc ?? process.env.IKA_SUI_RPC_URL, args.rpcs ?? process.env.IKA_SUI_RPC_URLS);

  const outputPathRaw = (args.out ?? process.env.SNAPSHOT_OUTPUT_PATH)?.trim();
  const outputPath = outputPathRaw && outputPathRaw.length > 0 ? path.resolve(process.cwd(), outputPathRaw) : undefined;

  const timeoutMs = parsePositiveInt("timeoutMs", args.timeoutMs, DEFAULT_TIMEOUT_MS);
  const initialDelayMs = parsePositiveInt("retryInitialMs", args.retryInitialMs, DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = parsePositiveInt("retryMaxMs", args.retryMaxMs, DEFAULT_MAX_DELAY_MS);
  const refreshIntervalMs = parsePositiveInt("refreshMs", args.refreshMs, DEFAULT_REFRESH_MS);
  const jitterPct = parseDecimalBetweenZeroAndOne("jitterPct", args.jitterPct, DEFAULT_JITTER_PCT);
  const failureBatchSize = parsePositiveInt("failureBatchSize", args.failureBatchSize, DEFAULT_FAILURE_BATCH_SIZE);
  const batchCooldownMs = parsePositiveInt("batchCooldownMs", args.batchCooldownMs, DEFAULT_BATCH_COOLDOWN_MS);
  const botPollTimeoutSeconds = parsePositiveInt(
    "botPollTimeoutSeconds",
    args.botPollTimeoutSeconds ?? process.env.SNAPSHOT_BOT_POLL_TIMEOUT_SECONDS,
    DEFAULT_BOT_POLL_TIMEOUT_SECONDS,
  );
  const watchMode = parseBoolean(args.watch ?? process.env.SNAPSHOT_WATCH_MODE, true);
  const workerName = (args.workerName ?? process.env.SNAPSHOT_WORKER_NAME ?? DEFAULT_WORKER_NAME).trim();
  const databaseUrl = requireNonEmpty("DATABASE_URL", args.databaseUrl ?? process.env.DATABASE_URL);
  const dbSslMode = parseDbSslMode(args.dbSslMode ?? process.env.DB_SSL_MODE);
  const botToken = (args.telegramToken ?? process.env.SNAPSHOT_NOTIFY_TELEGRAM_BOT_TOKEN)?.trim() || undefined;

  return {
    network,
    rpcCandidates,
    workerName,
    databaseUrl,
    dbSslMode,
    outputPath,
    timeoutMs,
    initialDelayMs,
    maxDelayMs,
    refreshIntervalMs,
    jitterPct,
    failureBatchSize,
    batchCooldownMs,
    watchMode,
    botToken,
    botPollTimeoutSeconds,
    startedAt: new Date(),
  };
}

async function runWatcher(config: RuntimeConfig): Promise<void> {
  const { db, queryClient } = createDb(config);

  console.log("[watcher] Starting IKA snapshot watcher");
  console.log(`[watcher] Network: ${config.network}`);
  console.log(`[watcher] RPC candidates: ${config.rpcCandidates.join(", ")}`);
  console.log(`[watcher] Worker name: ${config.workerName}`);
  console.log(`[watcher] DB SSL mode: ${config.dbSslMode}`);
  console.log(`[watcher] Bot mode: ${config.botToken ? "enabled (token-only)" : "disabled"}`);
  if (config.outputPath) {
    console.log(`[watcher] Local file export: ${config.outputPath}`);
  } else {
    console.log("[watcher] Local file export: disabled");
  }
  console.log(`[watcher] Watch mode: ${config.watchMode ? "enabled" : "disabled"}`);
  console.log(
    `[watcher] Failure policy: every ${config.failureBatchSize} consecutive failures => ${config.batchCooldownMs}ms cooldown`,
  );

  await ensureWorkerTables(db);

  let state = await readWorkerState(db, config.workerName);
  await writeWorkerState(db, state);

  let cycle = 0;
  let nextRpcIndex = 0;

  try {
    while (true) {
      cycle += 1;
      state.totalAttempts += 1;

      try {
        await processTelegramCommands(config, db, state, config.botPollTimeoutSeconds);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[bot] Command polling error: ${msg}`);
      }

      let roundError: Error | null = null;
      let snapshotCaptured = false;

      for (let i = 0; i < config.rpcCandidates.length; i += 1) {
        const rpcIndex = (nextRpcIndex + i) % config.rpcCandidates.length;
        const rpcUrl = config.rpcCandidates[rpcIndex];

        console.log(`[watcher] Cycle ${cycle}: trying RPC ${rpcUrl}`);
        try {
          const { payload, hash } = await fetchSnapshotOnce(config.network, rpcUrl, config.timeoutMs);

          const wasInserted = await insertSnapshotIfNew(db, payload, hash);

          state.lastSuccessHash = hash;
          state.lastSuccessAt = new Date().toISOString();
          state.consecutiveFailures = 0;

          if (config.outputPath) {
            await persistSnapshotFile(config.outputPath, payload);
          }

          console.log(
            `[watcher] Snapshot captured. hash=${hash} keys=${payload.encryptionKeys.length} inserted=${wasInserted}`,
          );

          if (state.lastNotifiedHash !== hash) {
            await broadcastToSubscribers(
              config,
              db,
              [
                "IKA snapshot ready",
                `worker: ${config.workerName}`,
                `network: ${payload.meta.network}`,
                `rpc: ${payload.meta.rpcUrl}`,
                `exportedAt: ${payload.meta.exportedAt}`,
                `hash: ${hash}`,
                `newHashStored: ${wasInserted}`,
              ].join("\n"),
            );
            state.lastNotifiedHash = hash;
            console.log("[watcher] Snapshot update broadcast completed.");
          }

          await writeWorkerState(db, state);

          snapshotCaptured = true;
          nextRpcIndex = rpcIndex;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          roundError = error instanceof Error ? error : new Error(message);
          lastErrorMessage = message;
          console.warn(`[watcher] RPC failed (${rpcUrl}): ${message}`);
        }
      }

      if (snapshotCaptured) {
        if (!config.watchMode) {
          console.log("[watcher] Success achieved and watch mode disabled. Exiting.");
          return;
        }

        console.log(`[watcher] Watch mode active. Waiting ${config.refreshIntervalMs}ms before refresh.`);
        await waitWithBotPolling(config, db, state, config.refreshIntervalMs);
        continue;
      }

      state.consecutiveFailures += 1;
      await writeWorkerState(db, state);

      const delayMs = computeRetryDelayMs(config, state.consecutiveFailures);
      const inCooldown = state.consecutiveFailures % config.failureBatchSize === 0;

      const failMsg =
        `[watcher] Cycle ${cycle} failed on all RPC candidates. ` +
        `consecutiveFailures=${state.consecutiveFailures}. ` +
        `Next retry in ${delayMs}ms. Last error: ${roundError?.message ?? "unknown"}`;

      console.warn(failMsg);

      if (inCooldown) {
        await broadcastToSubscribers(
          config,
          db,
          [
            "IKA snapshot watcher retry cooldown",
            `worker: ${config.workerName}`,
            `consecutiveFailures: ${state.consecutiveFailures}`,
            `cooldownMs: ${delayMs}`,
            `lastError: ${roundError?.message ?? "unknown"}`,
          ].join("\n"),
        ).catch(() => {
          // Broadcast failures should not break watcher loop.
        });
      }

      nextRpcIndex = (nextRpcIndex + 1) % config.rpcCandidates.length;
      await waitWithBotPolling(config, db, state, delayMs);
    }
  } finally {
    await queryClient.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const config = buildRuntimeConfig();
  await runWatcher(config);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nExport failed: ${message}`);
  process.exitCode = 1;
});

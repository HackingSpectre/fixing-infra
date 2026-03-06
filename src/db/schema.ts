import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  primaryKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const walletStatusEnum = pgEnum("wallet_status", ["creating", "provisioning", "ready", "degraded", "failed"]);
export const signerCurveEnum = pgEnum("signer_curve", ["ed25519", "secp256k1"]);
export const signerStateEnum = pgEnum("signer_state", ["pending", "active", "failed"]);
export const chainEnum = pgEnum("chain_type", ["sui", "solana", "evm", "bitcoin"]);
export const provisioningStatusEnum = pgEnum("provisioning_status", ["queued", "running", "partial", "completed", "failed"]);

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerSub: text("provider_sub").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerSubUnique: unique("identities_provider_sub_unique").on(table.provider, table.providerSub),
  }),
);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identityId: uuid("identity_id").notNull().references(() => identities.id, { onDelete: "cascade" }),
    status: walletStatusEnum("status").notNull().default("creating"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identityUnique: unique("wallets_identity_unique").on(table.identityId),
    walletStatusIdx: index("wallets_status_idx").on(table.status),
  }),
);

export const walletSigners = pgTable(
  "wallet_signers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "cascade" }),
    curve: signerCurveEnum("curve").notNull(),
    dwalletId: text("dwallet_id").notNull(),
    dwalletCapId: text("dwallet_cap_id").notNull(),
    publicKeyHex: text("public_key_hex").notNull(),
    state: signerStateEnum("state").notNull().default("pending"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    signerPerCurveUnique: unique("wallet_signers_wallet_curve_unique").on(table.walletId, table.curve),
    walletSignerStateIdx: index("wallet_signers_state_idx").on(table.walletId, table.state),
  }),
);

export const walletAddresses = pgTable(
  "wallet_addresses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "cascade" }),
    chain: chainEnum("chain").notNull(),
    address: text("address").notNull(),
    sourceCurve: signerCurveEnum("source_curve").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    walletChainUnique: unique("wallet_addresses_wallet_chain_unique").on(table.walletId, table.chain),
    walletAddressIdx: index("wallet_addresses_wallet_idx").on(table.walletId),
  }),
);

export const provisioningJobs = pgTable(
  "provisioning_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: provisioningStatusEnum("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idemUnique: unique("provisioning_jobs_wallet_idempotency_unique").on(table.walletId, table.idempotencyKey),
    provisioningStatusIdx: index("provisioning_jobs_status_idx").on(table.status),
  }),
);

export const gasTank = pgTable("gas_tank", {
  id: uuid("id").defaultRandom().primaryKey(),
  suiBalance: numeric("sui_balance", { precision: 36, scale: 9 }).notNull().default("0"),
  ikaBalance: numeric("ika_balance", { precision: 36, scale: 9 }).notNull().default("0"),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const operationEvents = pgTable(
  "operation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationType: text("operation_type").notNull(),
    walletId: uuid("wallet_id").references(() => wallets.id, { onDelete: "set null" }),
    correlationId: text("correlation_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    opTypeIdx: index("operation_events_type_idx").on(table.operationType),
  }),
);

export const infraSnapshots = pgTable(
  "infra_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotType: text("snapshot_type").notNull(),
    network: text("network").notNull(),
    rpcUrl: text("rpc_url").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    keyCount: integer("key_count").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    snapshotHashUnique: unique("infra_snapshots_hash_unique").on(table.snapshotHash),
    snapshotTypeCreatedIdx: index("infra_snapshots_type_created_idx").on(table.snapshotType, table.createdAt),
  }),
);

export const infraWorkerState = pgTable("infra_worker_state", {
  workerName: text("worker_name").primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  totalAttempts: bigint("total_attempts", { mode: "number" }).notNull().default(0),
  telegramLastUpdateId: bigint("telegram_last_update_id", { mode: "number" }).notNull().default(0),
  lastSuccessHash: text("last_success_hash"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastNotifiedHash: text("last_notified_hash"),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const infraTelegramSubscriptions = pgTable(
  "infra_telegram_subscriptions",
  {
    workerName: text("worker_name").notNull(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id"),
    username: text("username"),
    firstName: text("first_name"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "infra_telegram_subscriptions_pk",
      columns: [table.workerName, table.chatId],
    }),
    workerSeenIdx: index("infra_telegram_subscriptions_worker_seen_idx").on(table.workerName, table.lastSeenAt),
  }),
);

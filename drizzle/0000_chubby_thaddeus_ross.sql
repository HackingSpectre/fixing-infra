DO $$ BEGIN CREATE TYPE "public"."chain_type" AS ENUM('sui', 'solana', 'evm', 'bitcoin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."provisioning_status" AS ENUM('queued', 'running', 'partial', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."signer_curve" AS ENUM('ed25519', 'secp256k1'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."signer_state" AS ENUM('pending', 'active', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."wallet_status" AS ENUM('creating', 'provisioning', 'ready', 'degraded', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gas_tank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sui_balance" numeric(36, 9) DEFAULT '0' NOT NULL,
	"ika_balance" numeric(36, 9) DEFAULT '0' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_sub" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_provider_sub_unique" UNIQUE("provider","provider_sub")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_type" text NOT NULL,
	"wallet_id" uuid,
	"correlation_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provisioning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "provisioning_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_jobs_wallet_idempotency_unique" UNIQUE("wallet_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"chain" "chain_type" NOT NULL,
	"address" text NOT NULL,
	"source_curve" "signer_curve" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_addresses_wallet_chain_unique" UNIQUE("wallet_id","chain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"curve" "signer_curve" NOT NULL,
	"dwallet_id" text NOT NULL,
	"dwallet_cap_id" text NOT NULL,
	"public_key_hex" text NOT NULL,
	"state" "signer_state" DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_signers_wallet_curve_unique" UNIQUE("wallet_id","curve")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"status" "wallet_status" DEFAULT 'creating' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_identity_unique" UNIQUE("identity_id")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operation_events_wallet_id_wallets_id_fk') THEN
		ALTER TABLE "operation_events" ADD CONSTRAINT "operation_events_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provisioning_jobs_wallet_id_wallets_id_fk') THEN
		ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_addresses_wallet_id_wallets_id_fk') THEN
		ALTER TABLE "wallet_addresses" ADD CONSTRAINT "wallet_addresses_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_signers_wallet_id_wallets_id_fk') THEN
		ALTER TABLE "wallet_signers" ADD CONSTRAINT "wallet_signers_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_identity_id_identities_id_fk') THEN
		ALTER TABLE "wallets" ADD CONSTRAINT "wallets_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operation_events_type_idx" ON "operation_events" USING btree ("operation_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provisioning_jobs_status_idx" ON "provisioning_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_addresses_wallet_idx" ON "wallet_addresses" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_signers_state_idx" ON "wallet_signers" USING btree ("wallet_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallets_status_idx" ON "wallets" USING btree ("status");
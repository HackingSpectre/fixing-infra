# Instant Wallet Onboarding Plan

## Goal (User Experience)
When a user clicks **Continue with Google**:
1. Authentication succeeds.
2. User immediately gets wallet addresses (all required curves/chains).
3. User has full functionality right away.
4. User never sees provisioning, retries, queueing, or blockchain internals.

## Product Rule
All heavy wallet creation work happens **before** user login.
Login path should only do:
1. Authenticate user.
2. Atomically claim one ready wallet bundle.
3. Attach wallet bundle to user.
4. Return ready wallet + addresses.

## Target Architecture
Use a **wallet inventory pool** with background refill.

Components:
1. `Wallet Pool` (unassigned, pre-created wallet bundles).
2. `Claim Service` (atomic assignment at login).
3. `Refill Worker` (keeps pool above threshold).
4. `Health Monitor` (alerts for low inventory or refill failures).

## Wallet Bundle Definition
A bundle represents one user-ready package:
1. Required curves are pre-provisioned (for your current two-curve setup).
2. Required chain addresses are already derived and stored.
3. Status is `available` until claimed.
4. Bundle is complete enough that no user-visible provisioning is needed at login.

## Login Flow (Desired)
1. User clicks Google continue.
2. Backend verifies identity token and creates/loads user record.
3. Backend atomically reserves one `available` wallet bundle.
4. Backend binds bundle to user in the same transaction boundary.
5. Backend returns auth session + full wallet addresses.

Result: user sees instant success, no technical states.

## Inventory Rules
1. Keep `min_pool_size`, `target_pool_size`, and `max_pool_size`.
2. Refill worker runs continuously or on schedule.
3. If pool drops below minimum, trigger urgent refill.
4. Track per-curve readiness to avoid partial bundles.

## Safety and Correctness Rules
1. **Atomic claim** to avoid double assignment (race-safe).
2. **Reservation TTL** so abandoned claims return to pool.
3. **Idempotent login attach** to handle retries safely.
4. **Strict status transitions**: `available -> reserved -> assigned`.
5. Never return a bundle unless it is fully ready.

## Fallback Strategy
If pool is empty:
1. Try emergency provisioning in background path.
2. Keep frontend UX simple (single loading state only).
3. Do not expose internal errors directly to users.

## Observability (Required)
Track at minimum:
1. Pool depth over time.
2. Claim latency.
3. Claim failure rate.
4. Refill success/failure by reason.
5. Time from refill start to bundle available.

## Security Notes
1. Keep signer/secrets only in backend secure context.
2. Rate-limit login and claim endpoints.
3. Prevent wallet farming by abuse controls.
4. Audit all state transitions and claims.

## Rollout Plan
1. Build pool schema + worker first.
2. Backfill initial inventory for both curves.
3. Enable claim-on-login behind feature flag.
4. Monitor metrics and increase pool size gradually.
5. Remove old live-provision-on-login path once stable.

## Definition of Done
The system is done when:
1. Users consistently receive ready addresses immediately after Google login.
2. No user-facing provisioning steps are required.
3. Pool refill and claim operations are stable under peak load.

## This Document Is The Source of Truth
This file defines the intended onboarding behavior and implementation direction for instant wallet assignment.

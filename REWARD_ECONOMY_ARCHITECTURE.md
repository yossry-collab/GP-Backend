# GamePlug Reward Economy Architecture

## 1) Full System Architecture

GamePlug now runs a server-authoritative economy pipeline:

1. Commerce events:

- Checkout and payment finalize on backend only.
- Loyalty purchase rewards are awarded from verified order data, never from client payload.

2. Loyalty ledger:

- All point changes are written to `point_transactions` with idempotency keys.
- `loyalty_accounts` store current balance, lifetime points, spend, engagement score, tier, and pack pity/cooldowns.

3. Reward services:

- Quest engine with cooldown + completion limits + validation rules.
- Reward redemption engine with monthly limits and reward liability guardrails.
- Pack engine with secure RNG roll hashing, pity logic, cooldown, open caps, and EV safety gate.

4. Economy controls:

- Global monthly reward budget.
- Dynamic throttling after budget usage threshold.
- Abuse flagging and admin monitoring endpoints.

## 2) Economy Design Explanation

Core design principle: points are soft currency with liability.

- Sources are controlled:
  - Signup (one-time, verification-gated)
  - Purchase (margin-aware, discounted items excluded)
  - Quests (cooldown + limits)
  - Daily engagement (single daily claim)
- Sinks are controlled:
  - Reward redemption with tier checks and monthly limits
  - Pack opening point spend
  - Tier upgrades

Inflation and burn balance:

- Earn flows are throttled when monthly budget utilization grows.
- Reward and pack engines include liability checks against burned point value.

## 3) Pack Drop Algorithms

### 3.1 Eligibility and locks

- Tier gate check.
- Point balance check.
- Cooldown gate check.
- Daily and monthly open caps.

### 3.2 Pity logic

- Silver: epic pity after configured threshold.
- Gold: legendary pity after configured threshold.
- Platinum: tighter legendary pity.
- Minimum rarity is upgraded when pity triggers.

### 3.3 Secure RNG and audit

- Server creates a cryptographic nonce and hash per opening.
- Weighted drop selection uses luck-adjusted probabilities.
- Audit fields are persisted (`rngNonce`, `rngHash`) in each opening log.

### 3.4 EV safety model

- Expected liability of all drops is computed in EUR.
- Opening is blocked if expected liability exceeds configured max ratio vs points burned.

## 4) Database Schema

Collections:

- `users`
  - `emailVerified` added for secure bonus/quest gating.

- `loyalty_accounts` (modeled by `LoyaltyBalance`)
  - `points`, `lifetimePoints`, `lifetimeSpend`, `engagementScore`, `tier`, `tierExpiresAt`
  - `packProgress` for pity counters
  - `packCooldowns` for per-pack cooldown lock

- `point_transactions` (modeled by `PointsTransaction`)
  - `type`, `source`, `amount`, `balance`, `metadata`
  - `idempotencyKey` unique sparse index
  - `economyCostEstimate`

- `packs` and `pack_openings`
  - pack controls: cooldown and limits
  - opening audit: `rngNonce`, `rngHash`

- `reward_items` and `redemptions`
  - reward-level monthly limits and coupon constraints

- `coupons` (new)
  - generated for reward/pack drops
  - expiration, min-cart, one-coupon-per-order metadata

- `memberships`
  - points multiplier, luck multiplier, cooldown reduction

- `loyalty_levels`
  - represented by tier signal thresholds in config + `tier` in account

- `abuse_flags` (new)
  - risk events for farming/spam/inflation anomalies

## 5) Backend API Design

User-facing APIs:

- `GET /api/loyalty/balance`
- `GET /api/loyalty/history`
- `POST /api/loyalty/daily-login`
- `POST /api/loyalty/signup-bonus`
- `GET /api/loyalty/rewards`
- `POST /api/loyalty/rewards/:id/redeem`
- `GET /api/loyalty/quests`
- `POST /api/loyalty/quests/:id/complete`
- `GET /api/loyalty/packs`
- `POST /api/loyalty/packs/:id/open`

Admin APIs:

- `GET /api/loyalty/admin/stats`
- `GET /api/loyalty/admin/abuse-flags`
- `GET /api/loyalty/admin/packs/:id/preview`
- `GET|POST /api/loyalty/admin/config`
- reward/quest/pack CRUD endpoints

Internal service APIs:

- `awardPurchasePointsForOrder({ userId, orderId })`
- `revokePurchasePointsForOrder({ userId, orderId })`

## 6) Anti-Abuse System

Implemented controls:

- Idempotency for critical point writes.
- Signup bonus:
  - one-time
  - verified email gate
  - account age cooldown
  - duplicate phone-risk flagging
- Purchase rewards:
  - order ownership and paid/completed status validation
  - discounted line-item exclusion
  - daily/monthly purchase point caps
- Packs:
  - cooldown + open caps
  - spam flagging when cap exceeded
  - RNG audit logs
- Rewards:
  - monthly per-user and optional global redemption limits
  - liability guardrails

## 7) Startup-Safe Production Config (Suggested Defaults)

- `point_value_eur = 0.01`
- `signup_bonus_points = 75`
- `signup_bonus_requires_verified_email = true`
- `signup_bonus_min_account_age_minutes = 10`
- `margin_rate_low = 0.005`
- `margin_rate_medium = 0.01`
- `margin_rate_high = 0.02`
- `purchase_points_daily_cap = 800`
- `purchase_points_monthly_cap = 12000`
- `pack_open_cooldown_seconds = 120`
- `daily_pack_open_cap = 15`
- `monthly_pack_open_cap = 250`
- `coupon_default_expiry_days = 14`
- `coupon_default_min_cart_value = 25`
- `coupon_monthly_redemption_limit = 6`
- `global_monthly_reward_budget_points = 300000`
- `reward_throttle_start_ratio = 0.85`
- `reward_throttle_floor = 0.45`
- `max_pack_liability_ratio = 2.25`
- `reward_cost_safety_ratio = 1.1`

## 8) Mathematical Expected Value Model

Definitions:

- Point liability value: `V_point` (EUR/point)
- Pack point cost: `C_pack_points`
- Burn value in EUR: `B = C_pack_points * V_point`
- Drop set: `i in drops`
- Drop probability: `p_i = weight_i / sum(weight)`
- Drop liability in EUR: `L_i`

Pack expected liability:

`EV_pack = sum(p_i * L_i)`

Safety condition:

`EV_pack <= B * R_max`

where `R_max = max_pack_liability_ratio`.

Reward redemption safety:

`L_reward <= (pointsCost * V_point) * reward_cost_safety_ratio`

Budget throttle:

- Monthly used points `U`
- Monthly budget `M`
- Usage ratio `u = U / M`

For `u > throttle_start_ratio`, payout multiplier decays toward `throttle_floor`.

This ensures hard budget protection while preserving reward continuity.

const mongoose = require("mongoose");

const loyaltyBalanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    points: { type: Number, default: 0, min: 0 },
    lifetimePoints: { type: Number, default: 0, min: 0 }, // Total ever earned
    lifetimeSpend: { type: Number, default: 0, min: 0 },
    engagementScore: { type: Number, default: 0, min: 0 },
    tier: { type: String, enum: ["free", "silver", "gold", "platinum"], default: "free" },
    tierExpiresAt: { type: Date, default: null },
    dailyLoginDate: { type: String, default: null }, // "YYYY-MM-DD" to track daily login
    streakDays: { type: Number, default: 0 },
    packCooldowns: {
      silver: { type: Date, default: null },
      gold: { type: Date, default: null },
      platinum: { type: Date, default: null },
    },
    packProgress: {
      silver: {
        opens: { type: Number, default: 0 },
        withoutEpic: { type: Number, default: 0 },
        withoutLegendary: { type: Number, default: 0 },
      },
      gold: {
        opens: { type: Number, default: 0 },
        withoutEpic: { type: Number, default: 0 },
        withoutLegendary: { type: Number, default: 0 },
      },
      platinum: {
        opens: { type: Number, default: 0 },
        withoutEpic: { type: Number, default: 0 },
        withoutLegendary: { type: Number, default: 0 },
      },
    },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════
// ─── POINTS TRANSACTION LOG ──────────────────────────
// ═══════════════════════════════════════════════════════
const pointsTransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["earn", "spend", "expire", "refund", "bonus"], required: true },
    amount: { type: Number, required: true }, // positive for earn, negative for spend
    balance: { type: Number, required: true }, // balance after transaction
    source: {
      type: String,
      enum: [
        "purchase",        // earn from buying
        "signup",          // account creation bonus
        "daily_login",     // daily login reward
        "quest",           // side quest completion
        "pack_open",       // from opening a pack
        "redeem_reward",   // spending on rewards
        "admin_grant",     // admin manually grants
        "tier_bonus",      // membership tier bonus
        "referral",        // referral bonus (future)
        "expiration",      // points expired
        "refund",          // order refund
      ],
      required: true,
    },
    description: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // orderId, rewardId, etc.
    idempotencyKey: { type: String, default: null },
    economyCostEstimate: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null }, // optional expiration for earned points
  },
  { timestamps: true }
);
pointsTransactionSchema.index({ userId: 1, createdAt: -1 });
pointsTransactionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

// ═══════════════════════════════════════════════════════
// ─── REWARDS (redeemable items) ──────────────────────
// ═══════════════════════════════════════════════════════
const rewardSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    type: { type: String, enum: ["coupon", "gift_card", "product", "points_boost"], required: true },
    pointsCost: { type: Number, required: true, min: 0 },
    // Coupon-specific
    discountPercent: { type: Number, default: 0 },   // e.g. 10 = 10% off
    discountAmount: { type: Number, default: 0 },     // flat discount
    // Product-specific
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    // General
    image: { type: String, default: "" },
    stock: { type: Number, default: -1 }, // -1 = unlimited
    enabled: { type: Boolean, default: true },
    tierRequired: { type: String, enum: ["free", "silver", "gold", "platinum", "none"], default: "none" },
    couponExpiresDays: { type: Number, default: 14, min: 1, max: 365 },
    minimumCartValue: { type: Number, default: 0, min: 0 },
    monthlyRedemptionLimitPerUser: { type: Number, default: 5, min: 1, max: 1000 },
    maxGlobalRedemptionsPerMonth: { type: Number, default: -1 },
    economyCostEstimate: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════
// ─── REWARD REDEMPTION LOG ───────────────────────────
// ═══════════════════════════════════════════════════════
const redemptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    rewardId: { type: mongoose.Schema.Types.ObjectId, ref: "Reward", required: true },
    pointsSpent: { type: Number, required: true },
    status: { type: String, enum: ["completed", "pending", "cancelled"], default: "completed" },
    couponCode: { type: String, default: null }, // generated coupon code
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════
// ─── SIDE QUESTS (Gamification) ──────────────────────
// ═══════════════════════════════════════════════════════
const questSchema = new mongoose.Schema(
  {
    questKey: { type: String, default: null },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    type: {
      type: String,
      enum: [
        "social_follow",
        "share_product",
        "write_review",
        "complete_profile",
        "first_purchase",
        "streak_login",
        "signup_welcome",
        "weekly_orders",
        "monthly_spend",
        "points_earned",
        "referral_invite",
        "order_milestone",
        "pack_open_total",
        "redeem_total",
        "custom",
      ],
      required: true,
    },
    rewardPoints: { type: Number, required: true, min: 0 },
    icon: { type: String, default: "🎯" },
    enabled: { type: Boolean, default: true },
    featureFlag: { type: Boolean, default: true }, // master toggle for "Coming Soon"
    category: {
      type: String,
      enum: ["onboarding", "daily", "weekly", "career", "seasonal"],
      default: "career",
    },
    sortOrder: { type: Number, default: 0 },
    cooldownHours: { type: Number, default: 24, min: 0 },
    completionLimit: { type: Number, default: 1, min: 1 },
    validationRules: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { url: "https://twitter.com/..." }
  },
  { timestamps: true }
);
questSchema.index({ questKey: 1 }, { unique: true, sparse: true });

// ─── User quest progress ─────────────────────────────
const userQuestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    questId: { type: mongoose.Schema.Types.ObjectId, ref: "Quest", required: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    completionCount: { type: Number, default: 0, min: 0 },
    lastCompletedAt: { type: Date, default: null },
    progress: { type: Number, default: 0, min: 0, max: 100 }, // percentage
  },
  { timestamps: true }
);
userQuestSchema.index({ userId: 1, questId: 1 }, { unique: true });

// ═══════════════════════════════════════════════════════
// ─── PACKS (FIFA-Inspired Loot System) ───────────────
// ═══════════════════════════════════════════════════════
const packSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    pointsCost: { type: Number, required: true, min: 0 },
    enabled: { type: Boolean, default: true },
    tierRequired: { type: String, enum: ["free", "silver", "gold", "platinum", "none"], default: "none" },
    packClass: { type: String, enum: ["silver", "gold", "platinum"], default: "silver", index: true },
    guaranteedRarity: { type: String, enum: ["common", "rare", "epic", "legendary"], default: "rare" },
    animationTheme: { type: String, enum: ["silver", "gold", "platinum", "prismatic"], default: "silver" },
    pityEpicThreshold: { type: Number, default: 0, min: 0 },
    pityLegendaryThreshold: { type: Number, default: 0, min: 0 },
    bonusMultiplier: { type: Number, default: 1, min: 1 },
    featured: { type: Boolean, default: false },
    headline: { type: String, default: "" },
    cooldownSeconds: { type: Number, default: 120, min: 0 },
    dailyOpenLimit: { type: Number, default: 20, min: 1 },
    monthlyOpenLimit: { type: Number, default: 300, min: 1 },
    expectedValueSoftCap: { type: Number, default: 2.25, min: 0.1, max: 10 },
    // Drop table: array of possible drops with weights
    drops: [
      {
        type: { type: String, enum: ["points", "coupon", "gift_card", "product", "nothing"], required: true },
        rarity: { type: String, enum: ["common", "rare", "epic", "legendary"], default: "common" },
        weight: { type: Number, required: true, min: 0 }, // relative probability
        // Reward details per type
        pointsAmount: { type: Number, default: 0 },
        discountPercent: { type: Number, default: 0 },
        discountAmount: { type: Number, default: 0 },
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
        label: { type: String, default: "" }, // display name for the drop
        revealText: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

// ─── Pack opening log ────────────────────────────────
const packOpeningSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    packId: { type: mongoose.Schema.Types.ObjectId, ref: "Pack", required: true },
    pointsSpent: { type: Number, required: true },
    rngNonce: { type: String, default: "" },
    rngHash: { type: String, default: "" },
    result: {
      type: { type: String, enum: ["points", "coupon", "gift_card", "product", "nothing"] },
      rarity: { type: String },
      label: { type: String },
      value: { type: mongoose.Schema.Types.Mixed }, // points amount, coupon code, product info
    },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════
// ─── MEMBERSHIP TIERS (GamePlus) ─────────────────────
// ═══════════════════════════════════════════════════════
const membershipSchema = new mongoose.Schema(
  {
    tier: { type: String, enum: ["silver", "gold", "platinum"], required: true, unique: true },
    name: { type: String, required: true }, // "GamePlus Silver", "GamePlus Gold", "GamePlus Platinum"
    price: { type: Number, required: true }, // monthly price
    yearlyPrice: { type: Number, default: 0 }, // yearly price
    pointsMultiplier: { type: Number, default: 1.0 }, // e.g. 1.5x, 2x
    packLuckMultiplier: { type: Number, default: 1.0 },
    packCooldownReductionPercent: { type: Number, default: 0, min: 0, max: 90 },
    monthlyBonusPoints: { type: Number, default: 0 },
    perks: [{ type: String }], // description of perks
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════
// ─── LOYALTY CONFIG (admin-editable settings) ────────
// ═══════════════════════════════════════════════════════
const loyaltyConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

// ═══════════════════════════════════════════════════════
// ─── COUPONS (redeemed/pack generated codes) ─────────
// ═══════════════════════════════════════════════════════
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    rewardId: { type: mongoose.Schema.Types.ObjectId, ref: "Reward", default: null },
    source: { type: String, enum: ["reward", "pack", "membership", "admin"], default: "reward" },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    minimumCartValue: { type: Number, default: 0, min: 0 },
    maxDiscountAmount: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    usedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    status: { type: String, enum: ["unused", "used", "expired", "cancelled"], default: "unused" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
couponSchema.index({ userId: 1, status: 1, expiresAt: 1 });

// ═══════════════════════════════════════════════════════
// ─── ABUSE FLAGS (fraud / farming alerts) ────────────
// ═══════════════════════════════════════════════════════
const abuseFlagSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: [
        "signup_bonus_risk",
        "pack_open_spam",
        "quest_spam",
        "coupon_abuse",
        "points_inflation_risk",
        "manual_review",
      ],
      required: true,
    },
    severity: { type: String, enum: ["low", "medium", "high", "critical"], default: "low" },
    status: { type: String, enum: ["open", "investigating", "resolved", "dismissed"], default: "open" },
    signal: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    resolvedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
abuseFlagSchema.index({ status: 1, severity: -1, createdAt: -1 });

module.exports = {
  LoyaltyBalance: mongoose.model("LoyaltyBalance", loyaltyBalanceSchema),
  PointsTransaction: mongoose.model("PointsTransaction", pointsTransactionSchema),
  Reward: mongoose.model("Reward", rewardSchema),
  Redemption: mongoose.model("Redemption", redemptionSchema),
  Quest: mongoose.model("Quest", questSchema),
  UserQuest: mongoose.model("UserQuest", userQuestSchema),
  Pack: mongoose.model("Pack", packSchema),
  PackOpening: mongoose.model("PackOpening", packOpeningSchema),
  Membership: mongoose.model("Membership", membershipSchema),
  LoyaltyConfig: mongoose.model("LoyaltyConfig", loyaltyConfigSchema),
  Coupon: mongoose.model("Coupon", couponSchema),
  AbuseFlag: mongoose.model("AbuseFlag", abuseFlagSchema),
};

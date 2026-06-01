const {
  LoyaltyBalance,
  PointsTransaction,
  Reward,
  Redemption,
  Quest,
  UserQuest,
  Pack,
  PackOpening,
  Membership,
  LoyaltyConfig,
  Coupon,
  AbuseFlag,
} = require("../Models/loyaltyModel");
const crypto = require("crypto");
const Order = require("../Models/orderModel");
const Product = require("../Models/productModel");
const User = require("../Models/userModel");

const {
  TIER_ORDER,
  RARITY_ORDER,
  DEFAULT_PACK_PROFILES,
  DEFAULT_QUEST_CATALOG,
  normalizePackClass,
} = require("../Config/loyaltyCatalogs");

// Get or create loyalty balance for a user
async function getOrCreateBalance(userId, session = null) {
  let query = LoyaltyBalance.findOne({ userId });
  if (session) {
    query = query.session(session);
  }

  let bal = await query;
  if (!bal) {
    if (session) {
      const created = await LoyaltyBalance.create([{ userId, points: 0, lifetimePoints: 0 }], { session });
      bal = created[0];
    } else {
      bal = await LoyaltyBalance.create({ userId, points: 0, lifetimePoints: 0 });
    }
  }
  return bal;
}

// Get a config value with fallback
async function getConfig(key, fallback) {
  const cfg = await LoyaltyConfig.findOne({ key });
  return cfg ? cfg.value : fallback;
}

// Get tier multiplier
function getTierMultiplier(tier) {
  const multipliers = { free: 1, silver: 1.25, gold: 1.5, platinum: 2 };
  return multipliers[tier] || 1;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function getMembershipByTier(tier) {
  if (!tier || tier === "free") {
    return null;
  }
  return Membership.findOne({ tier, enabled: true });
}

async function getDynamicTierMultiplier(tier) {
  const membership = await getMembershipByTier(tier);
  if (membership?.pointsMultiplier) {
    return membership.pointsMultiplier;
  }
  return getTierMultiplier(tier);
}

async function getPackCooldownReductionPercent(tier) {
  const membership = await getMembershipByTier(tier);
  return membership?.packCooldownReductionPercent || 0;
}

async function getBudgetUsageSnapshot() {
  const monthlyBudget = toNumber(
    await getConfig("global_monthly_reward_budget_points", 300000),
    300000
  );
  const monthStart = startOfUtcMonth();

  const [{ total = 0 } = {}] = await PointsTransaction.aggregate([
    {
      $match: {
        type: "earn",
        createdAt: { $gte: monthStart },
        source: { $nin: ["admin_grant"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return {
    monthlyBudget,
    used: total,
    usageRatio: monthlyBudget > 0 ? total / monthlyBudget : 0,
  };
}

async function applyInflationThrottle(amount) {
  const snapshot = await getBudgetUsageSnapshot();
  const startRatio = clamp(
    toNumber(await getConfig("reward_throttle_start_ratio", 0.85), 0.85),
    0,
    1
  );
  const floorRatio = clamp(
    toNumber(await getConfig("reward_throttle_floor", 0.45), 0.45),
    0,
    1
  );

  if (snapshot.monthlyBudget <= 0 || amount <= 0) {
    return { amount, throttleRatio: 1, usageRatio: snapshot.usageRatio };
  }

  const projectedRatio = (snapshot.used + amount) / snapshot.monthlyBudget;
  if (projectedRatio <= startRatio) {
    return { amount, throttleRatio: 1, usageRatio: projectedRatio };
  }

  const over = projectedRatio - startRatio;
  const range = Math.max(0.0001, 1 - startRatio);
  const decay = clamp(over / range, 0, 1);
  const ratio = clamp(1 - decay * (1 - floorRatio), floorRatio, 1);
  return {
    amount: Math.max(0, Math.floor(amount * ratio)),
    throttleRatio: ratio,
    usageRatio: projectedRatio,
  };
}

async function createAbuseFlag(userId, type, severity, signal, metadata = {}) {
  try {
    await AbuseFlag.create({ userId, type, severity, signal, metadata });
  } catch (_err) {
    // Best-effort only. Never block loyalty flows due to abuse logging failure.
  }
}

async function updateTierFromSignals(balance, session = null) {
  const totalPackOpens = Object.values(ensurePackProgress(balance)).reduce(
    (sum, state) => sum + (state.opens || 0),
    0
  );

  const weightedScore =
    (balance.lifetimeSpend || 0) +
    (balance.engagementScore || 0) * 5 +
    totalPackOpens * 3;

  const silverThreshold = toNumber(await getConfig("tier_silver_threshold", 250), 250);
  const goldThreshold = toNumber(await getConfig("tier_gold_threshold", 900), 900);
  const platinumThreshold = toNumber(await getConfig("tier_platinum_threshold", 2200), 2200);

  let projectedTier = "free";
  if (weightedScore >= platinumThreshold) {
    projectedTier = "platinum";
  } else if (weightedScore >= goldThreshold) {
    projectedTier = "gold";
  } else if (weightedScore >= silverThreshold) {
    projectedTier = "silver";
  }

  if ((TIER_ORDER[projectedTier] || 0) > (TIER_ORDER[balance.tier] || 0)) {
    balance.tier = projectedTier;
    if (session) {
      await balance.save({ session });
    } else {
      await balance.save();
    }
  }

  return balance.tier;
}

function ensurePackProgress(balance) {
  if (!balance.packProgress) {
    balance.packProgress = {};
  }

  for (const packClass of Object.keys(DEFAULT_PACK_PROFILES)) {
    if (!balance.packProgress[packClass]) {
      balance.packProgress[packClass] = { opens: 0, withoutEpic: 0, withoutLegendary: 0 };
      continue;
    }

    balance.packProgress[packClass].opens = balance.packProgress[packClass].opens || 0;
    balance.packProgress[packClass].withoutEpic = balance.packProgress[packClass].withoutEpic || 0;
    balance.packProgress[packClass].withoutLegendary = balance.packProgress[packClass].withoutLegendary || 0;
  }

  return balance.packProgress;
}

function ensurePackCooldowns(balance) {
  if (!balance.packCooldowns) {
    balance.packCooldowns = {};
  }

  for (const packClass of Object.keys(DEFAULT_PACK_PROFILES)) {
    if (!Object.prototype.hasOwnProperty.call(balance.packCooldowns, packClass)) {
      balance.packCooldowns[packClass] = null;
    }
  }

  return balance.packCooldowns;
}

function tierAllows(currentTier, requiredTier) {
  if (!requiredTier || requiredTier === "none") return true;
  return (TIER_ORDER[currentTier] || 0) >= (TIER_ORDER[requiredTier] || 0);
}

function rarityAtLeast(candidate, minimum) {
  return (RARITY_ORDER[candidate] || 0) >= (RARITY_ORDER[minimum] || 0);
}

function getStrongerRarity(first, second) {
  return (RARITY_ORDER[first] || 0) >= (RARITY_ORDER[second] || 0) ? first : second;
}

async function getPackLuckMultiplier(tier) {
  if (!tier || tier === "free") {
    return 1;
  }

  const membership = await Membership.findOne({ tier, enabled: true }).select("packLuckMultiplier");
  return membership?.packLuckMultiplier || 1;
}

function buildLuckAdjustedWeight(drop, luckMultiplier) {
  const rarityBias = {
    common: Math.max(0.45, 1 - (luckMultiplier - 1) * 1.8),
    rare: 1 + (luckMultiplier - 1) * 0.75,
    epic: 1 + (luckMultiplier - 1) * 1.7,
    legendary: 1 + (luckMultiplier - 1) * 2.6,
  };

  return Math.max(0.0001, drop.weight * (rarityBias[drop.rarity] || 1));
}

function chooseWeightedDrop(drops, luckMultiplier, roll = null) {
  const withAdjustedWeights = drops.map((drop) => ({
    drop,
    adjustedWeight: buildLuckAdjustedWeight(drop, luckMultiplier),
  }));

  const totalWeight = withAdjustedWeights.reduce((sum, entry) => sum + entry.adjustedWeight, 0);
  const randomRatio =
    typeof roll === "number"
      ? clamp(roll, 0, 0.999999999)
      : crypto.randomInt(0, 1000000) / 1000000;
  const randomPoint = randomRatio * totalWeight;

  let cumulative = 0;
  for (const entry of withAdjustedWeights) {
    cumulative += entry.adjustedWeight;
    if (randomPoint <= cumulative) {
      return entry.drop;
    }
  }

  return withAdjustedWeights[withAdjustedWeights.length - 1]?.drop || drops[drops.length - 1];
}

function buildPackReveal(pack, selectedDrop, pityState) {
  const packClass = normalizePackClass(pack);
  const themeMap = {
    silver: {
      accent: "#cbd5e1",
      halo: "rgba(226, 232, 240, 0.55)",
      beam: "linear-gradient(180deg, rgba(255,255,255,0.85), rgba(148,163,184,0.25))",
      title: "Silver Tunnel",
      subtitle: "Precision lights. Clean reveal."
    },
    gold: {
      accent: "#f59e0b",
      halo: "rgba(251, 191, 36, 0.55)",
      beam: "linear-gradient(180deg, rgba(255,245,157,0.92), rgba(245,158,11,0.28))",
      title: "Gold Walkout",
      subtitle: "Spotlights on. Big drop incoming."
    },
    platinum: {
      accent: "#60a5fa",
      halo: "rgba(96, 165, 250, 0.55)",
      beam: "linear-gradient(180deg, rgba(255,255,255,0.92), rgba(96,165,250,0.28))",
      title: "Platinum Storm",
      subtitle: "Maximum drama. Endgame pull energy."
    },
  };

  const selectedTheme = themeMap[packClass] || themeMap.silver;

  return {
    packClass,
    animationTheme: pack.animationTheme || packClass,
    guaranteedRarity: pack.guaranteedRarity || "rare",
    pityTriggeredEpic: pityState.pityTriggeredEpic,
    pityTriggeredLegendary: pityState.pityTriggeredLegendary,
    accent: selectedTheme.accent,
    halo: selectedTheme.halo,
    beam: selectedTheme.beam,
    title: selectedTheme.title,
    subtitle: selectedDrop.revealText || selectedTheme.subtitle,
    headline: pack.headline || "High-value pack",
  };
}

function buildPackUserState(pack, balance) {
  const packClass = normalizePackClass(pack);
  const progress = ensurePackProgress(balance)[packClass];
  const cooldowns = ensurePackCooldowns(balance);
  const canOpen = balance.points >= pack.pointsCost;

  let lockReason = null;
  if (balance.points < pack.pointsCost) {
    lockReason = `${pack.pointsCost - balance.points} more points needed`;
  }

  const now = Date.now();
  const cooldownUntil = cooldowns[packClass] ? new Date(cooldowns[packClass]).getTime() : 0;
  const cooldownSecondsRemaining = cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0;

  if (cooldownSecondsRemaining > 0) {
    lockReason = `Cooldown active: ${cooldownSecondsRemaining}s remaining`;
  }

  return {
    canOpen: canOpen && cooldownSecondsRemaining === 0,
    lockReason,
    pity: {
      opens: progress.opens,
      withoutEpic: progress.withoutEpic,
      withoutLegendary: progress.withoutLegendary,
      remainingToEpic: Math.max(0, (pack.pityEpicThreshold || 0) - progress.withoutEpic),
      remainingToLegendary: Math.max(0, (pack.pityLegendaryThreshold || 0) - progress.withoutLegendary),
    },
    cooldownSecondsRemaining,
  };
}

async function ensureQuestCatalogDefaults() {
  const defaultKeys = DEFAULT_QUEST_CATALOG.map((quest) => quest.questKey);
  const existingCount = await Quest.countDocuments({ questKey: { $in: defaultKeys } });
  if (existingCount >= DEFAULT_QUEST_CATALOG.length) {
    return;
  }

  for (const quest of DEFAULT_QUEST_CATALOG) {
    await Quest.updateOne(
      { questKey: quest.questKey },
      { $setOnInsert: { ...quest, enabled: true } },
      { upsert: true }
    );
  }
}

async function evaluateQuestProgress(quest, userId, balance, userQuest) {
  const metadata = quest.metadata || {};
  const validationRules = quest.validationRules || {};
  const completionLimit = Math.max(1, toNumber(quest.completionLimit, 1));
  const completionCount = Math.max(0, toNumber(userQuest?.completionCount, 0));
  const cooldownHours = Math.max(0, toNumber(quest.cooldownHours, 24));

  let current = 0;
  let target = 1;
  let blockedReason = null;
  let sourceAlreadyClaimed = false;
  let userDoc = null;

  switch (quest.type) {
    case "signup_welcome": {
      target = 1;
      const existingSignup = await PointsTransaction.findOne({ userId, source: "signup" }).select("_id");
      sourceAlreadyClaimed = !!existingSignup;
      current = sourceAlreadyClaimed ? 1 : 0;
      break;
    }
    case "first_purchase": {
      target = Math.max(1, toNumber(metadata.requiredOrders || metadata.target, 1));
      current = await Order.countDocuments({ userId, status: "completed", paymentStatus: "paid" });
      break;
    }
    case "complete_profile": {
      target = 1;
      userDoc = await User.findById(userId).select("username email phonenumber");
      current = userDoc?.username && userDoc?.email && userDoc?.phonenumber ? 1 : 0;
      break;
    }
    case "streak_login": {
      target = Math.max(1, toNumber(metadata.requiredDays, 7));
      current = Math.max(0, toNumber(balance.streakDays, 0));
      break;
    }
    case "weekly_orders": {
      target = Math.max(1, toNumber(metadata.requiredOrders || metadata.target, 2));
      const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      current = await Order.countDocuments({
        userId,
        status: "completed",
        paymentStatus: "paid",
        createdAt: { $gte: weekStart },
      });
      break;
    }
    case "monthly_spend": {
      target = Math.max(1, toNumber(metadata.targetSpend || metadata.target, 80));
      const monthStart = startOfUtcMonth();
      const monthlyOrders = await Order.find({
        userId,
        status: "completed",
        paymentStatus: "paid",
        createdAt: { $gte: monthStart },
      }).select("totalPrice");
      current = monthlyOrders.reduce((sum, order) => sum + Math.max(0, toNumber(order.totalPrice, 0)), 0);
      break;
    }
    case "points_earned": {
      target = Math.max(1, toNumber(metadata.targetPoints || metadata.target, 1000));
      current = Math.max(0, toNumber(balance.lifetimePoints, 0));
      break;
    }
    case "referral_invite": {
      target = Math.max(1, toNumber(metadata.targetReferrals || metadata.target, 1));
      current = await PointsTransaction.countDocuments({
        userId,
        source: "referral",
        type: "earn",
      });
      break;
    }
    case "order_milestone": {
      target = Math.max(1, toNumber(metadata.targetOrders || metadata.target, 5));
      current = await Order.countDocuments({
        userId,
        status: "completed",
        paymentStatus: "paid",
      });
      break;
    }
    case "pack_open_total": {
      target = Math.max(1, toNumber(metadata.targetPacks || metadata.target, 3));
      current = await PackOpening.countDocuments({ userId });
      break;
    }
    case "redeem_total": {
      target = Math.max(1, toNumber(metadata.targetRedemptions || metadata.target, 2));
      current = await Redemption.countDocuments({ userId, status: "completed" });
      break;
    }
    case "social_follow":
    case "share_product":
    case "write_review": {
      target = 1;
      current = validationRules.allowManualClaim === true ? 1 : 0;
      if (!current) {
        blockedReason = "Objective verification pending";
      }
      break;
    }
    case "custom":
    default: {
      target = Math.max(1, toNumber(metadata.target, 1));
      current = userQuest?.progress >= 100 ? target : 0;
      break;
    }
  }

  if (quest.featureFlag === false) {
    blockedReason = blockedReason || "Coming soon";
  }

  if (validationRules.requireVerifiedEmail) {
    userDoc = userDoc || (await User.findById(userId).select("emailVerified"));
    if (!userDoc?.emailVerified) {
      blockedReason = blockedReason || "Verified email required";
    }
  }

  if (validationRules.minimumTier && !tierAllows(balance.tier, validationRules.minimumTier)) {
    blockedReason = blockedReason || `Requires ${validationRules.minimumTier} tier`;
  }

  if (
    validationRules.minimumLifetimeSpend &&
    (balance.lifetimeSpend || 0) < toNumber(validationRules.minimumLifetimeSpend, 0)
  ) {
    blockedReason = blockedReason || "Minimum lifetime spend requirement not met";
  }

  let nextEligibleAt = null;
  let cooldownActive = false;
  if (completionCount > 0 && userQuest?.lastCompletedAt && cooldownHours > 0) {
    const candidate = new Date(
      new Date(userQuest.lastCompletedAt).getTime() + cooldownHours * 60 * 60 * 1000
    );
    if (candidate > new Date()) {
      cooldownActive = true;
      nextEligibleAt = candidate;
    }
  }

  const normalizedTarget = Math.max(1, toNumber(target, 1));
  const normalizedCurrent = Math.max(0, toNumber(current, 0));
  const progress = clamp(
    Math.round((Math.min(normalizedCurrent, normalizedTarget) / normalizedTarget) * 100),
    0,
    100
  );

  const requirementMet = normalizedCurrent >= normalizedTarget;
  const effectiveCompletionCount = sourceAlreadyClaimed
    ? Math.max(1, completionCount)
    : completionCount;
  const limitReached = effectiveCompletionCount >= completionLimit;
  const completed = limitReached || sourceAlreadyClaimed;
  const claimable =
    requirementMet &&
    !limitReached &&
    !sourceAlreadyClaimed &&
    !cooldownActive &&
    !blockedReason;

  let status = "in_progress";
  if (completed) {
    status = "completed";
  } else if (claimable) {
    status = "claimable";
  } else if (cooldownActive) {
    status = "cooldown";
  } else if (blockedReason) {
    status = "locked";
  }

  if (sourceAlreadyClaimed) {
    blockedReason = blockedReason || "Welcome reward already claimed";
  }

  return {
    current: normalizedCurrent,
    target: normalizedTarget,
    progress,
    claimable,
    completed,
    completionCount: effectiveCompletionCount,
    completionLimit,
    cooldownActive,
    nextEligibleAt,
    blockedReason,
    status,
    remaining: Math.max(0, normalizedTarget - normalizedCurrent),
  };
}

async function ensureAdvancedLoyaltyDefaults() {
  const configDefaults = [
    { key: "points_per_euro", value: 10, description: "Legacy points ratio fallback" },
    { key: "point_value_eur", value: 0.01, description: "Soft-currency value of 1 point in EUR for ROI controls" },
    { key: "signup_bonus_points", value: 75, description: "Points awarded on verified registration" },
    { key: "referral_invite_points", value: 50, description: "Points awarded to inviter when a referred user registers" },
    { key: "signup_bonus_requires_verified_email", value: true, description: "Require verified email to claim welcome bonus" },
    { key: "signup_bonus_min_account_age_minutes", value: 10, description: "Cooldown before signup bonus can be claimed" },
    { key: "daily_login_points", value: 10, description: "Base points for daily login" },
    { key: "margin_rate_low", value: 0.005, description: "Cashback rate for low margin catalog items" },
    { key: "margin_rate_medium", value: 0.01, description: "Cashback rate for medium margin catalog items" },
    { key: "margin_rate_high", value: 0.02, description: "Cashback rate for high margin catalog items" },
    { key: "purchase_points_daily_cap", value: 800, description: "Max purchase-earned points per user per day" },
    { key: "purchase_points_monthly_cap", value: 12000, description: "Max purchase-earned points per user per month" },
    { key: "coupon_default_expiry_days", value: 14, description: "Default coupon expiration window" },
    { key: "coupon_default_min_cart_value", value: 25, description: "Default minimum cart value for loyalty coupons" },
    { key: "coupon_monthly_redemption_limit", value: 6, description: "Monthly coupon redemptions allowed per user" },
    { key: "reward_cost_safety_ratio", value: 1.1, description: "Max reward liability allowed versus burned point value" },
    { key: "pack_open_cooldown_seconds", value: 120, description: "Base cooldown between pack openings" },
    { key: "daily_pack_open_cap", value: 15, description: "Max number of pack openings per day" },
    { key: "monthly_pack_open_cap", value: 250, description: "Max number of pack openings per month" },
    { key: "pack_coupon_utilization_rate", value: 0.6, description: "Expected redemption usage rate of coupon drops" },
    { key: "max_pack_liability_ratio", value: 2.25, description: "Maximum expected pack liability relative to points burned" },
    { key: "global_monthly_reward_budget_points", value: 300000, description: "Global reward budget to protect startup cash flow" },
    { key: "reward_throttle_start_ratio", value: 0.85, description: "Usage ratio where reward throttling begins" },
    { key: "reward_throttle_floor", value: 0.45, description: "Minimum payout multiplier when throttling is active" },
    { key: "tier_silver_threshold", value: 250, description: "Weighted score threshold for Silver tier" },
    { key: "tier_gold_threshold", value: 900, description: "Weighted score threshold for Gold tier" },
    { key: "tier_platinum_threshold", value: 2200, description: "Weighted score threshold for Platinum tier" },
  ];

  for (const config of configDefaults) {
    await LoyaltyConfig.updateOne(
      { key: config.key },
      { $setOnInsert: config },
      { upsert: true }
    );
  }

  const membershipDefaults = [
    {
      tier: "silver",
      name: "GamePlus Silver",
      price: 500,
      yearlyPrice: 5000,
      pointsMultiplier: 1.25,
      packLuckMultiplier: 1.05,
      packCooldownReductionPercent: 10,
      monthlyBonusPoints: 120,
      perks: ["1.25x points on purchases", "Access to Silver Packs", "Slightly improved pack luck", "Monthly 120-point bonus"],
    },
    {
      tier: "gold",
      name: "GamePlus Gold",
      price: 1200,
      yearlyPrice: 12000,
      pointsMultiplier: 1.5,
      packLuckMultiplier: 1.15,
      packCooldownReductionPercent: 25,
      monthlyBonusPoints: 300,
      perks: ["1.5x points on purchases", "Access to Gold Packs", "Higher epic and legendary pull rate", "Monthly 300-point bonus"],
    },
    {
      tier: "platinum",
      name: "GamePlus Platinum",
      price: 2400,
      yearlyPrice: 24000,
      pointsMultiplier: 2,
      packLuckMultiplier: 1.3,
      packCooldownReductionPercent: 45,
      monthlyBonusPoints: 700,
      perks: ["2x points on purchases", "Access to Platinum Packs", "Best pity protection in the game", "Monthly 700-point bonus", "Premium pull flair and top-tier rewards"],
    },
  ];

  for (const membership of membershipDefaults) {
    await Membership.updateOne(
      { tier: membership.tier },
      { $setOnInsert: { ...membership, enabled: true } },
      { upsert: true }
    );
  }

  for (const [packClass, profile] of Object.entries(DEFAULT_PACK_PROFILES)) {
    await Pack.updateOne(
      { packClass },
      { $setOnInsert: { ...profile, packClass, enabled: true } },
      { upsert: true }
    );
  }
}

// Add points transaction and update balance
async function addPoints(userId, amount, type, source, description, metadata = {}, options = {}) {
  const {
    skipTierMultiplier = false,
    bypassInflationControls = false,
    idempotencyKey = null,
    economyCostEstimate = 0,
    session = null,
  } = options;

  if (idempotencyKey) {
    let existingQuery = PointsTransaction.findOne({ idempotencyKey });
    if (session) {
      existingQuery = existingQuery.session(session);
    }
    const existing = await existingQuery;
    if (existing) {
      const bal = await getOrCreateBalance(userId, session);
      return { balance: bal, transaction: existing, alreadyProcessed: true, throttleRatio: 1 };
    }
  }

  const bal = await getOrCreateBalance(userId, session);
  let finalAmount = toNumber(amount, 0);

  if (type === "earn" && !skipTierMultiplier) {
    const multiplier = await getDynamicTierMultiplier(bal.tier);
    finalAmount = Math.round(finalAmount * multiplier);
  }

  let throttleRatio = 1;
  if (type === "earn" && !bypassInflationControls) {
    const throttle = await applyInflationThrottle(finalAmount);
    finalAmount = throttle.amount;
    throttleRatio = throttle.throttleRatio;
  }

  if (!Number.isFinite(finalAmount)) {
    throw new Error("Invalid points amount");
  }

  bal.points += finalAmount;
  if (finalAmount > 0) {
    bal.lifetimePoints += finalAmount;
  }
  if (bal.points < 0) {
    bal.points = 0;
  }

  if (session) {
    await bal.save({ session });
  } else {
    await bal.save();
  }

  const txPayload = {
    userId,
    type,
    amount: finalAmount,
    balance: bal.points,
    source,
    description,
    metadata: {
      ...metadata,
      throttleRatio,
    },
    idempotencyKey,
    economyCostEstimate,
  };

  let tx;
  if (session) {
    const created = await PointsTransaction.create([txPayload], { session });
    tx = created[0];
  } else {
    tx = await PointsTransaction.create(txPayload);
  }

  return { balance: bal, transaction: tx, throttleRatio };
}

// Generate a unique coupon code
function generateCouponCode() {
  return "GP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function buildSecureRoll(context = "") {
  const nonce = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(`${nonce}:${context}:${Date.now()}`)
    .digest("hex");

  const numerator = Number.parseInt(hash.slice(0, 13), 16);
  const denominator = 0x1fffffffffffff;
  const roll = denominator > 0 ? clamp(numerator / denominator, 0, 0.999999999) : 0.5;
  return { nonce, hash, roll };
}

function inferMarginClass(productDoc, item) {
  const raw = String(productDoc?.marginClass || item?.marginClass || "").toLowerCase();
  if (["low", "medium", "high"].includes(raw)) {
    return raw;
  }

  const category = String(item?.category || productDoc?.category || "").toLowerCase();
  if (category === "gift-card") return "low";
  if (category === "software") return "high";
  return "medium";
}

async function getMarginRateByClass(marginClass) {
  if (marginClass === "low") {
    return toNumber(await getConfig("margin_rate_low", 0.005), 0.005);
  }
  if (marginClass === "high") {
    return toNumber(await getConfig("margin_rate_high", 0.02), 0.02);
  }
  return toNumber(await getConfig("margin_rate_medium", 0.01), 0.01);
}

async function estimateRewardCostEuro(reward) {
  const defaultMinCart = toNumber(await getConfig("coupon_default_min_cart_value", 25), 25);
  const utilizationRate = clamp(
    toNumber(await getConfig("pack_coupon_utilization_rate", 0.6), 0.6),
    0.05,
    1
  );

  if (reward.type === "gift_card") {
    return Math.max(0, toNumber(reward.discountAmount, 0));
  }

  if (reward.type === "coupon") {
    const baseCart = Math.max(toNumber(reward.minimumCartValue, 0), defaultMinCart);
    const byPercent = (baseCart * Math.max(0, toNumber(reward.discountPercent, 0))) / 100;
    const byAmount = Math.max(0, toNumber(reward.discountAmount, 0));
    return Math.max(byPercent, byAmount) * utilizationRate;
  }

  return 0;
}

async function estimateDropLiabilityEuro(drop) {
  const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
  const utilizationRate = clamp(
    toNumber(await getConfig("pack_coupon_utilization_rate", 0.6), 0.6),
    0.05,
    1
  );

  if (drop.type === "points") {
    return Math.max(0, toNumber(drop.pointsAmount, 0)) * pointValueEur;
  }

  if (drop.type === "gift_card") {
    return Math.max(0, toNumber(drop.discountAmount, 0));
  }

  if (drop.type === "coupon") {
    const safeBaseCart = 30;
    const byPercent = (safeBaseCart * Math.max(0, toNumber(drop.discountPercent, 0))) / 100;
    const byAmount = Math.max(0, toNumber(drop.discountAmount, 0));
    return Math.max(byPercent, byAmount) * utilizationRate;
  }

  return 0;
}

async function estimatePackExpectedLiabilityEuro(pack) {
  const totalWeight = (pack.drops || []).reduce((sum, drop) => sum + Math.max(0, toNumber(drop.weight, 0)), 0);
  if (totalWeight <= 0) {
    return 0;
  }

  let expected = 0;
  for (const drop of pack.drops || []) {
    const weight = Math.max(0, toNumber(drop.weight, 0));
    if (weight <= 0) continue;
    const dropLiability = await estimateDropLiabilityEuro(drop);
    expected += (weight / totalWeight) * dropLiability;
  }

  return expected;
}

module.exports = {
  getOrCreateBalance,
  getConfig,
  getTierMultiplier,
  toNumber,
  startOfUtcDay,
  startOfUtcMonth,
  addDays,
  clamp,
  getMembershipByTier,
  getDynamicTierMultiplier,
  getPackCooldownReductionPercent,
  getBudgetUsageSnapshot,
  applyInflationThrottle,
  createAbuseFlag,
  updateTierFromSignals,
  ensurePackProgress,
  ensurePackCooldowns,
  tierAllows,
  rarityAtLeast,
  getStrongerRarity,
  getPackLuckMultiplier,
  buildLuckAdjustedWeight,
  chooseWeightedDrop,
  buildPackReveal,
  buildPackUserState,
  ensureQuestCatalogDefaults,
  evaluateQuestProgress,
  ensureAdvancedLoyaltyDefaults,
  addPoints,
  generateCouponCode,
  buildSecureRoll,
  inferMarginClass,
  getMarginRateByClass,
  estimateRewardCostEuro,
  estimateDropLiabilityEuro,
  estimatePackExpectedLiabilityEuro,
};

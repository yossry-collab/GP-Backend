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

// ═══════════════════════════════════════════════════════
// ─── HELPERS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════

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

const TIER_ORDER = { free: 0, silver: 1, gold: 2, platinum: 3, none: 0 };
const RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3 };

const DEFAULT_PACK_PROFILES = {
  silver: {
    name: "Silver Pack",
    description: "A polished starter pack with guaranteed rare-tier loot and a rising chance of epic hits.",
    image: "🥈",
    headline: "Guaranteed Rare • Epic pity after 4 opens",
    pointsCost: 180,
    tierRequired: "free",
    guaranteedRarity: "rare",
    animationTheme: "silver",
    pityEpicThreshold: 4,
    pityLegendaryThreshold: 16,
    bonusMultiplier: 1.02,
    featured: true,
    drops: [
      { type: "points", rarity: "rare", weight: 42, pointsAmount: 90, label: "90 Points", revealText: "Clean pull. Stack the points." },
      { type: "points", rarity: "rare", weight: 28, pointsAmount: 150, label: "150 Points", revealText: "Strong silver payout." },
      { type: "coupon", rarity: "rare", weight: 18, discountPercent: 8, label: "8% Store Coupon", revealText: "A useful discount enters the club." },
      { type: "coupon", rarity: "epic", weight: 7, discountPercent: 18, label: "18% Store Coupon", revealText: "Epic flare. Big savings unlocked." },
      { type: "gift_card", rarity: "epic", weight: 4, discountAmount: 5, label: "€5 Gift Card", revealText: "Silver just turned premium." },
      { type: "points", rarity: "legendary", weight: 1, pointsAmount: 1200, label: "Legendary 1200 Points", revealText: "Jackpot. The tunnel explodes in silver light." },
    ],
  },
  gold: {
    name: "Gold Pack",
    description: "Elite drop rates, heavier jackpots, and a much faster path toward legendary reveals.",
    image: "🥇",
    headline: "Guaranteed Epic • Legendary pity after 7 opens",
    pointsCost: 420,
    tierRequired: "silver",
    guaranteedRarity: "epic",
    animationTheme: "gold",
    pityEpicThreshold: 1,
    pityLegendaryThreshold: 7,
    bonusMultiplier: 1.08,
    featured: true,
    drops: [
      { type: "points", rarity: "epic", weight: 32, pointsAmount: 320, label: "320 Points", revealText: "Gold pack, gold return." },
      { type: "points", rarity: "epic", weight: 25, pointsAmount: 480, label: "480 Points", revealText: "A big epic surge." },
      { type: "coupon", rarity: "epic", weight: 18, discountPercent: 22, label: "22% Store Coupon", revealText: "This is a serious coupon." },
      { type: "gift_card", rarity: "epic", weight: 12, discountAmount: 10, label: "€10 Gift Card", revealText: "Gold-tier value secured." },
      { type: "coupon", rarity: "legendary", weight: 8, discountPercent: 40, label: "40% Store Coupon", revealText: "Legendary discount. Massive value." },
      { type: "points", rarity: "legendary", weight: 5, pointsAmount: 3000, label: "Legendary 3000 Points", revealText: "The stadium erupts. Monster point haul." },
    ],
  },
  platinum: {
    name: "Platinum Pack",
    description: "Endgame pack energy. Premium odds, cinematic reveals, and the best jackpot ceiling in the system.",
    image: "💎",
    headline: "Guaranteed Epic • Legendary pity after 4 opens",
    pointsCost: 900,
    tierRequired: "platinum",
    guaranteedRarity: "epic",
    animationTheme: "platinum",
    pityEpicThreshold: 1,
    pityLegendaryThreshold: 4,
    bonusMultiplier: 1.15,
    featured: true,
    drops: [
      { type: "points", rarity: "epic", weight: 30, pointsAmount: 650, label: "650 Points", revealText: "Platinum points flood in." },
      { type: "coupon", rarity: "epic", weight: 22, discountPercent: 30, label: "30% Store Coupon", revealText: "High-end coupon, instant impact." },
      { type: "gift_card", rarity: "legendary", weight: 18, discountAmount: 20, label: "€20 Gift Card", revealText: "Legendary card. Premium pull." },
      { type: "coupon", rarity: "legendary", weight: 14, discountPercent: 50, label: "50% Store Coupon", revealText: "Half-price destruction." },
      { type: "points", rarity: "legendary", weight: 11, pointsAmount: 5000, label: "Legendary 5000 Points", revealText: "Platinum jackpot. Unreal hit." },
      { type: "gift_card", rarity: "legendary", weight: 5, discountAmount: 50, label: "€50 Gift Card", revealText: "Top-board reward. Absolute scenes." },
    ],
  },
};

function normalizePackClass(pack) {
  if (pack.packClass && DEFAULT_PACK_PROFILES[pack.packClass]) {
    return pack.packClass;
  }

  const normalizedName = (pack.name || "").toLowerCase();
  if (normalizedName.includes("platinum")) return "platinum";
  if (normalizedName.includes("gold")) return "gold";
  return "silver";
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
  const canOpen = tierAllows(balance.tier, pack.tierRequired) && balance.points >= pack.pointsCost;

  let lockReason = null;
  if (!tierAllows(balance.tier, pack.tierRequired)) {
    lockReason = `${pack.tierRequired} tier required`;
  } else if (balance.points < pack.pointsCost) {
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

const DEFAULT_QUEST_CATALOG = [
  {
    questKey: "starter_contract_verified",
    title: "Starter Contract",
    description: "Verify your account and receive your starter points.",
    type: "signup_welcome",
    rewardPoints: 75,
    icon: "🚀",
    category: "onboarding",
    sortOrder: 1,
    cooldownHours: 0,
    completionLimit: 1,
    validationRules: { requireVerifiedEmail: true },
    metadata: { target: 1 },
  },
  {
    questKey: "invite_friend_link",
    title: "Invite a Friend",
    description: "Invite 1 friend with your referral link.",
    type: "referral_invite",
    rewardPoints: 180,
    icon: "🔗",
    category: "career",
    sortOrder: 2,
    cooldownHours: 0,
    completionLimit: 1,
    metadata: { targetReferrals: 1, referralPath: "/register" },
  },
  {
    questKey: "profile_setup",
    title: "Squad Setup",
    description: "Complete your profile (username, email, and phone).",
    type: "complete_profile",
    rewardPoints: 80,
    icon: "👤",
    category: "onboarding",
    sortOrder: 3,
    cooldownHours: 0,
    completionLimit: 1,
  },
  {
    questKey: "first_purchase_contract",
    title: "First Whistle Purchase",
    description: "Complete your first paid order.",
    type: "first_purchase",
    rewardPoints: 120,
    icon: "🛍️",
    category: "career",
    sortOrder: 4,
    cooldownHours: 0,
    completionLimit: 1,
  },
  {
    questKey: "seven_day_form",
    title: "Form Streak",
    description: "Reach a 7-day login streak.",
    type: "streak_login",
    rewardPoints: 140,
    icon: "🔥",
    category: "weekly",
    sortOrder: 5,
    cooldownHours: 168,
    completionLimit: 52,
    metadata: { requiredDays: 7 },
  },
  {
    questKey: "weekly_two_orders",
    title: "Weekend Warrior",
    description: "Place 2 paid orders within 7 days.",
    type: "weekly_orders",
    rewardPoints: 160,
    icon: "🧾",
    category: "weekly",
    sortOrder: 6,
    cooldownHours: 168,
    completionLimit: 52,
    metadata: { requiredOrders: 2 },
  },
  {
    questKey: "order_milestone_five",
    title: "League Matches (Total)",
    description: "Complete 5 paid orders in total.",
    type: "order_milestone",
    rewardPoints: 210,
    icon: "🎯",
    category: "career",
    sortOrder: 7,
    cooldownHours: 0,
    completionLimit: 1,
    metadata: { targetOrders: 5 },
  },
  {
    questKey: "pack_open_master",
    title: "Pack Opener",
    description: "Open 3 reward packs.",
    type: "pack_open_total",
    rewardPoints: 130,
    icon: "📦",
    category: "career",
    sortOrder: 8,
    cooldownHours: 0,
    completionLimit: 1,
    metadata: { targetPacks: 3 },
  },
  {
    questKey: "season_budget_80",
    title: "Season Budget Boss",
    description: "Spend 80 EUR in paid orders this month.",
    type: "monthly_spend",
    rewardPoints: 250,
    icon: "💰",
    category: "seasonal",
    sortOrder: 9,
    cooldownHours: 720,
    completionLimit: 12,
    metadata: { targetSpend: 80, currency: "EUR" },
  },
  {
    questKey: "reward_redeemer",
    title: "Reward Collector",
    description: "Redeem 2 rewards from the shop.",
    type: "redeem_total",
    rewardPoints: 140,
    icon: "🎁",
    category: "career",
    sortOrder: 10,
    cooldownHours: 0,
    completionLimit: 1,
    metadata: { targetRedemptions: 2 },
  },
  {
    questKey: "career_points_1500",
    title: "Grinding Legend",
    description: "Earn 1500 lifetime points.",
    type: "points_earned",
    rewardPoints: 220,
    icon: "🏅",
    category: "career",
    sortOrder: 11,
    cooldownHours: 0,
    completionLimit: 1,
    metadata: { targetPoints: 1500 },
  },
  {
    questKey: "community_follow_soon",
    title: "Community Scout",
    description: "Follow our social channels to unlock this objective soon.",
    type: "social_follow",
    rewardPoints: 40,
    icon: "📣",
    category: "seasonal",
    featureFlag: false,
    sortOrder: 12,
    cooldownHours: 0,
    completionLimit: 1,
  },
];

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

// ═══════════════════════════════════════════════════════
// ─── 1. POINTS & BALANCE ────────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/balance — Get user's points balance
exports.getBalance = async (req, res) => {
  try {
    const bal = await getOrCreateBalance(req.user.userId);
    res.json({
      points: bal.points,
      lifetimePoints: bal.lifetimePoints,
      lifetimeSpend: bal.lifetimeSpend || 0,
      engagementScore: bal.engagementScore || 0,
      tier: bal.tier,
      streakDays: bal.streakDays,
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching balance", error: err.message });
  }
};

// GET /api/loyalty/history — Points transaction history
exports.getHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      PointsTransaction.find({ userId: req.user.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      PointsTransaction.countDocuments({ userId: req.user.userId }),
    ]);

    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: "Error fetching history", error: err.message });
  }
};

// POST /api/loyalty/daily-login — Claim daily login points
exports.dailyLogin = async (req, res) => {
  try {
    const bal = await getOrCreateBalance(req.user.userId);
    const today = new Date().toISOString().split("T")[0];

    if (bal.dailyLoginDate === today) {
      return res.status(400).json({ message: "Already claimed today", alreadyClaimed: true });
    }

    // Check streak
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    if (bal.dailyLoginDate === yesterdayStr) {
      bal.streakDays += 1;
    } else {
      bal.streakDays = 1;
    }
    bal.dailyLoginDate = today;
    await bal.save();

    // Bonus points for streaks: base 10, +5 per streak day (max 50)
    const basePoints = await getConfig("daily_login_points", 10);
    const streakBonus = Math.min(bal.streakDays * 5, 50);
    const totalPoints = basePoints + streakBonus;

    const result = await addPoints(
      req.user.userId,
      totalPoints,
      "earn",
      "daily_login",
      `Daily login (Day ${bal.streakDays} streak)`,
      { streakDays: bal.streakDays }
    );
    const awardedPoints = result.transaction.amount;

    // Notify user about daily login points
    const { createNotification } = require("./notificationController");
    await createNotification(
      req.user.userId,
      "loyalty_points",
      "Daily Login Reward",
      `+${awardedPoints} points! Day ${bal.streakDays} streak bonus.`,
      { points: awardedPoints, streakDays: bal.streakDays }
    );

    res.json({
      points: awardedPoints,
      streakDays: bal.streakDays,
      newBalance: result.balance.points,
      message: `+${awardedPoints} points! (${bal.streakDays} day streak)`,
    });
  } catch (err) {
    res.status(500).json({ message: "Error claiming daily login", error: err.message });
  }
};

async function getUserEarnedPointsInWindow(userId, source, fromDate) {
  const [{ total = 0 } = {}] = await PointsTransaction.aggregate([
    {
      $match: {
        userId,
        type: "earn",
        source,
        createdAt: { $gte: fromDate },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return total;
}

// Internal helper used by payment finalization to award purchase points.
const awardPurchasePointsForOrder = async ({ userId, orderId, amount }) => {
  if (!userId || !orderId) {
    throw new Error("userId and orderId required");
  }

  const normalizedOrderId = String(orderId);
  const existing = await PointsTransaction.findOne({
    userId,
    source: "purchase",
    "metadata.orderId": normalizedOrderId,
  });

  if (existing) {
    return {
      alreadyAwarded: true,
      earned: 0,
      newBalance: existing.balance,
      reason: "already-awarded",
    };
  }

  const order = await Order.findById(orderId).lean();
  if (!order) {
    throw new Error("Order not found");
  }
  if (String(order.userId) !== String(userId)) {
    throw new Error("Order does not belong to user");
  }
  if (order.paymentStatus !== "paid" && order.status !== "completed") {
    throw new Error("Order must be paid/completed before awarding points");
  }

  const fallbackAmount = toNumber(amount, 0);
  const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
  const marginRates = {
    low: await getMarginRateByClass("low"),
    medium: await getMarginRateByClass("medium"),
    high: await getMarginRateByClass("high"),
  };

  const productIds = (order.items || []).map((item) => item.productId).filter(Boolean);
  const products = await Product.find({ _id: { $in: productIds } })
    .select("_id discountPercentage category marginClass")
    .lean();
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  let eligibleSpend = 0;
  let discountedSpend = 0;
  let rawPoints = 0;
  const breakdown = [];

  for (const item of order.items || []) {
    const quantity = Math.max(1, toNumber(item.quantity, 1));
    const lineSpend = Math.max(0, toNumber(item.price, 0) * quantity);
    const productDoc = productMap.get(String(item.productId));

    const hasDiscount =
      toNumber(productDoc?.discountPercentage, 0) > 0 ||
      (toNumber(item.listPrice, 0) > 0 && toNumber(item.price, 0) < toNumber(item.listPrice, 0));

    if (hasDiscount) {
      discountedSpend += lineSpend;
      continue;
    }

    const marginClass = inferMarginClass(productDoc, item);
    const cashbackRate = marginRates[marginClass] || marginRates.medium;
    const linePoints = (lineSpend * cashbackRate) / pointValueEur;

    eligibleSpend += lineSpend;
    rawPoints += linePoints;
    breakdown.push({
      productId: item.productId,
      category: item.category,
      marginClass,
      cashbackRate,
      lineSpend,
      linePoints: Math.floor(linePoints),
    });
  }

  if (eligibleSpend <= 0 && fallbackAmount > 0) {
    const fallbackPoints = (fallbackAmount * marginRates.medium) / pointValueEur;
    eligibleSpend = fallbackAmount;
    rawPoints = fallbackPoints;
    breakdown.push({
      category: "fallback",
      marginClass: "medium",
      cashbackRate: marginRates.medium,
      lineSpend: fallbackAmount,
      linePoints: Math.floor(fallbackPoints),
    });
  }

  const calculatedPoints = Math.max(0, Math.floor(rawPoints));
  if (calculatedPoints <= 0) {
    return {
      alreadyAwarded: false,
      earned: 0,
      newBalance: (await getOrCreateBalance(userId)).points,
      reason: "no-eligible-spend",
    };
  }

  const tierMultiplier = await getDynamicTierMultiplier((await getOrCreateBalance(userId)).tier);
  const boostedPoints = Math.max(0, Math.floor(calculatedPoints * tierMultiplier));

  const [dailyCap, monthlyCap, dailyEarned, monthlyEarned] = await Promise.all([
    toNumber(await getConfig("purchase_points_daily_cap", 800), 800),
    toNumber(await getConfig("purchase_points_monthly_cap", 12000), 12000),
    getUserEarnedPointsInWindow(userId, "purchase", startOfUtcDay()),
    getUserEarnedPointsInWindow(userId, "purchase", startOfUtcMonth()),
  ]);

  const dailyRemaining = Math.max(0, dailyCap - dailyEarned);
  const monthlyRemaining = Math.max(0, monthlyCap - monthlyEarned);
  const finalAward = Math.max(0, Math.min(boostedPoints, dailyRemaining, monthlyRemaining));

  if (boostedPoints > dailyCap * 1.5) {
    await createAbuseFlag(
      userId,
      "points_inflation_risk",
      "medium",
      "Unusually large raw purchase points attempt",
      { orderId: normalizedOrderId, calculatedPoints: boostedPoints, dailyCap }
    );
  }

  if (finalAward <= 0) {
    return {
      alreadyAwarded: false,
      earned: 0,
      newBalance: (await getOrCreateBalance(userId)).points,
      reason: "cap-reached",
      caps: {
        dailyCap,
        monthlyCap,
        dailyEarned,
        monthlyEarned,
      },
    };
  }

  const result = await addPoints(
    userId,
    finalAward,
    "earn",
    "purchase",
    `Purchase reward (€${eligibleSpend.toFixed(2)} eligible spend)`,
    {
      orderId: normalizedOrderId,
      eligibleSpend,
      discountedSpend,
      breakdown,
      capReduction: boostedPoints - finalAward,
      basePoints: calculatedPoints,
      tierMultiplier,
    },
    {
      idempotencyKey: `purchase:${normalizedOrderId}`,
      economyCostEstimate: finalAward * pointValueEur,
      skipTierMultiplier: true,
    }
  );

  result.balance.lifetimeSpend = (result.balance.lifetimeSpend || 0) + eligibleSpend;
  result.balance.engagementScore = (result.balance.engagementScore || 0) + Math.min(30, Math.round(eligibleSpend / 8));
  await updateTierFromSignals(result.balance);
  await result.balance.save();

  const { createNotification: notify } = require("./notificationController");
  await notify(
    userId,
    "loyalty_points",
    "Points Earned!",
    `You earned ${result.transaction.amount} points from your purchase.`,
    {
      points: result.transaction.amount,
      orderId: normalizedOrderId,
      eligibleSpend,
    }
  );

  return {
    alreadyAwarded: false,
    earned: result.transaction.amount,
    newBalance: result.balance.points,
    eligibleSpend,
    discountedSpend,
  };
};

const revokePurchasePointsForOrder = async ({ userId, orderId, reason = "Order refund adjustment" }) => {
  if (!userId || !orderId) {
    throw new Error("userId and orderId required");
  }

  const normalizedOrderId = String(orderId);
  const awardedTx = await PointsTransaction.findOne({
    userId,
    source: "purchase",
    "metadata.orderId": normalizedOrderId,
  }).sort({ createdAt: -1 });

  if (!awardedTx || awardedTx.amount <= 0) {
    return { reversed: false, amount: 0, reason: "no-awarded-points" };
  }

  const existingRefund = await PointsTransaction.findOne({
    source: "refund",
    "metadata.refundOfTransactionId": String(awardedTx._id),
  });

  if (existingRefund) {
    return { reversed: false, amount: 0, reason: "already-reversed", newBalance: existingRefund.balance };
  }

  const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
  const result = await addPoints(
    userId,
    -Math.abs(awardedTx.amount),
    "refund",
    "refund",
    reason,
    {
      orderId: normalizedOrderId,
      refundOfTransactionId: String(awardedTx._id),
    },
    {
      idempotencyKey: `refund:${normalizedOrderId}:${awardedTx._id}`,
      skipTierMultiplier: true,
      bypassInflationControls: true,
      economyCostEstimate: Math.abs(awardedTx.amount) * pointValueEur,
    }
  );

  return {
    reversed: true,
    amount: Math.abs(result.transaction.amount),
    newBalance: result.balance.points,
  };
};

exports.awardPurchasePointsForOrder = awardPurchasePointsForOrder;
exports.revokePurchasePointsForOrder = revokePurchasePointsForOrder;

function createHttpError(status, message, meta = {}) {
  const err = new Error(message);
  err.status = status;
  err.meta = meta;
  return err;
}

async function grantSignupBonus(userId) {
  const existing = await PointsTransaction.findOne({
    userId,
    source: "signup",
  });
  if (existing) {
    throw createHttpError(400, "Signup bonus already claimed");
  }

  const user = await User.findById(userId);
  if (!user) {
    throw createHttpError(404, "User not found");
  }

  const requireVerifiedEmail = !!(await getConfig(
    "signup_bonus_requires_verified_email",
    true
  ));
  if (requireVerifiedEmail && user.emailVerified !== true) {
    await createAbuseFlag(
      userId,
      "signup_bonus_risk",
      "low",
      "Signup bonus requested without verified email",
      { email: user.email }
    );
    throw createHttpError(403, "Email verification is required before claiming welcome points");
  }

  const minAgeMinutes = toNumber(
    await getConfig("signup_bonus_min_account_age_minutes", 10),
    10
  );
  const accountAgeMinutes = (Date.now() - new Date(user.createdAt).getTime()) / 60000;
  if (accountAgeMinutes < minAgeMinutes) {
    throw createHttpError(
      429,
      `Please wait ${Math.ceil(minAgeMinutes - accountAgeMinutes)} minute(s) before claiming your welcome bonus`
    );
  }

  if (user.phonenumber) {
    const samePhoneCount = await User.countDocuments({
      phonenumber: user.phonenumber,
      _id: { $ne: userId },
    });
    if (samePhoneCount > 0) {
      await createAbuseFlag(
        userId,
        "signup_bonus_risk",
        "high",
        "Duplicate phone detected during signup bonus claim",
        { phonenumber: user.phonenumber, samePhoneCount }
      );
      throw createHttpError(403, "Signup bonus blocked due to account verification risk");
    }
  }

  const bonus = toNumber(await getConfig("signup_bonus_points", 75), 75);
  const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
  const result = await addPoints(
    userId,
    bonus,
    "earn",
    "signup",
    "Welcome bonus for joining Game Plug!",
    {
      emailVerified: user.emailVerified === true,
    },
    {
      idempotencyKey: `signup:${userId}`,
      economyCostEstimate: bonus * pointValueEur,
    }
  );

  return {
    user,
    result,
  };
}

async function awardReferralInviteBonus(referrerUserId, invitedUser, options = {}) {
  if (!referrerUserId || !invitedUser?._id) {
    return { awarded: false, reason: "invalid_payload" };
  }

  const normalizedReferrerId = String(referrerUserId);
  const invitedUserId = String(invitedUser._id);
  if (normalizedReferrerId === invitedUserId) {
    return { awarded: false, reason: "self_referral" };
  }

  const referrer = await User.findById(referrerUserId).select("_id");
  if (!referrer) {
    return { awarded: false, reason: "referrer_not_found" };
  }

  const bonus = toNumber(await getConfig("referral_invite_points", 50), 50);
  const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
  const idempotencyKey =
    options.idempotencyKey || `referral:${normalizedReferrerId}:${invitedUserId}`;

  const result = await addPoints(
    referrerUserId,
    bonus,
    "earn",
    "referral",
    "Referral bonus for inviting a new member",
    {
      invitedUserId,
      invitedUsername: invitedUser.username || "",
      invitedEmail: invitedUser.email || "",
    },
    {
      idempotencyKey,
      economyCostEstimate: bonus * pointValueEur,
    }
  );

  return {
    awarded: !result.alreadyProcessed,
    alreadyProcessed: !!result.alreadyProcessed,
    result,
  };
}

// POST /api/loyalty/signup-bonus — One-time signup bonus
exports.signupBonus = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { result } = await grantSignupBonus(userId);

    res.json({
      earned: result.transaction.amount,
      newBalance: result.balance.points,
      message: `Welcome! You earned ${result.transaction.amount} bonus points!`,
    });

    // Notify user about signup bonus (fire-and-forget after response)
    const { createNotification: notifyUser } = require("./notificationController");
    notifyUser(
      userId,
      "welcome",
      "Welcome to Game Plug!",
      `You received ${result.transaction.amount} bonus points for signing up. Start exploring!`,
      { points: result.transaction.amount }
    );
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message, ...(err.meta || {}) });
    }
    res.status(500).json({ message: "Error granting signup bonus", error: err.message });
  }
};

exports.awardReferralInviteBonus = awardReferralInviteBonus;

// ═══════════════════════════════════════════════════════
// ─── 2. REWARDS & REDEMPTION ────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/rewards — List available rewards
exports.getRewards = async (req, res) => {
  try {
    const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
    const safetyRatio = toNumber(await getConfig("reward_cost_safety_ratio", 1.1), 1.1);
    const rewards = await Reward.find({ enabled: true }).sort({ pointsCost: 1 });

    const enriched = await Promise.all(
      rewards.map(async (reward) => {
        const estimatedCostEuro = await estimateRewardCostEuro(reward);
        const burnedPointValueEuro = reward.pointsCost * pointValueEur;
        return {
          ...reward.toObject(),
          economyPreview: {
            estimatedCostEuro,
            burnedPointValueEuro,
            safetyRatio,
            isSafe: estimatedCostEuro <= burnedPointValueEuro * safetyRatio,
          },
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: "Error fetching rewards", error: err.message });
  }
};

// POST /api/loyalty/rewards/:id/redeem — Redeem a reward
exports.redeemReward = async (req, res) => {
  const session = await Reward.startSession();
  try {
    let payload = null;

    await session.withTransaction(async () => {
      const reward = await Reward.findById(req.params.id).session(session);
      if (!reward || !reward.enabled) {
        throw new Error("Reward not found or disabled");
      }

      const bal = await getOrCreateBalance(req.user.userId, session);

      if (!tierAllows(bal.tier, reward.tierRequired)) {
        throw new Error(`Requires ${reward.tierRequired} tier or higher`);
      }

      if (bal.points < reward.pointsCost) {
        throw new Error("Not enough points");
      }

      if (reward.stock !== -1 && reward.stock <= 0) {
        throw new Error("Reward out of stock");
      }

      const monthStart = startOfUtcMonth();
      const userMonthlyLimit = Math.max(
        1,
        toNumber(
          reward.monthlyRedemptionLimitPerUser,
          await getConfig("coupon_monthly_redemption_limit", 6)
        )
      );

      const userMonthlyRedemptions = await Redemption.countDocuments({
        userId: req.user.userId,
        rewardId: reward._id,
        status: "completed",
        createdAt: { $gte: monthStart },
      }).session(session);

      if (userMonthlyRedemptions >= userMonthlyLimit) {
        throw new Error("Monthly redemption limit reached for this reward");
      }

      if (toNumber(reward.maxGlobalRedemptionsPerMonth, -1) > 0) {
        const globalMonthlyRedemptions = await Redemption.countDocuments({
          rewardId: reward._id,
          status: "completed",
          createdAt: { $gte: monthStart },
        }).session(session);

        if (globalMonthlyRedemptions >= reward.maxGlobalRedemptionsPerMonth) {
          throw new Error("This reward reached its global monthly limit");
        }
      }

      const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
      const safetyRatio = toNumber(await getConfig("reward_cost_safety_ratio", 1.1), 1.1);
      const burnedPointValueEuro = reward.pointsCost * pointValueEur;
      const estimatedRewardCostEuro = await estimateRewardCostEuro(reward);

      if (estimatedRewardCostEuro > burnedPointValueEuro * safetyRatio) {
        throw new Error("Reward temporarily unavailable due to economy protection");
      }

      const result = await addPoints(
        req.user.userId,
        -reward.pointsCost,
        "spend",
        "redeem_reward",
        `Redeemed: ${reward.name}`,
        { rewardId: reward._id },
        {
          idempotencyKey: `redeem:${req.user.userId}:${reward._id}:${Date.now()}`,
          session,
          economyCostEstimate: estimatedRewardCostEuro,
        }
      );

      if (reward.stock !== -1) {
        reward.stock -= 1;
        await reward.save({ session });
      }

      let coupon = null;
      let couponCode = null;

      if (reward.type === "coupon" || reward.type === "gift_card") {
        const couponExpiresDays = Math.max(
          1,
          toNumber(reward.couponExpiresDays, await getConfig("coupon_default_expiry_days", 14))
        );
        const minCartValue = Math.max(
          toNumber(reward.minimumCartValue, 0),
          toNumber(await getConfig("coupon_default_min_cart_value", 25), 25)
        );
        couponCode = generateCouponCode();

        const createdCoupons = await Coupon.create(
          [
            {
              code: couponCode,
              userId: req.user.userId,
              rewardId: reward._id,
              source: "reward",
              discountPercent: toNumber(reward.discountPercent, 0),
              discountAmount: toNumber(reward.discountAmount, 0),
              minimumCartValue: minCartValue,
              expiresAt: addDays(new Date(), couponExpiresDays),
              metadata: {
                oneCouponPerOrder: true,
              },
            },
          ],
          { session }
        );
        coupon = createdCoupons[0];
      }

      const createdRedemptions = await Redemption.create(
        [
          {
            userId: req.user.userId,
            rewardId: reward._id,
            pointsSpent: reward.pointsCost,
            couponCode,
            metadata: {
              rewardName: reward.name,
              rewardType: reward.type,
              couponId: coupon?._id || null,
            },
          },
        ],
        { session }
      );

      payload = {
        message: `Successfully redeemed: ${reward.name}`,
        redemption: createdRedemptions[0],
        coupon,
        couponCode,
        newBalance: result.balance.points,
      };
    });

    res.json(payload);
  } catch (err) {
    if (
      err.message.includes("not found") ||
      err.message.includes("disabled")
    ) {
      return res.status(404).json({ message: err.message });
    }

    if (
      err.message.includes("Not enough points") ||
      err.message.includes("limit") ||
      err.message.includes("economy protection") ||
      err.message.includes("out of stock")
    ) {
      return res.status(400).json({ message: err.message });
    }

    if (err.message.includes("Requires")) {
      return res.status(403).json({ message: err.message });
    }

    res.status(500).json({ message: "Error redeeming reward", error: err.message });
  } finally {
    await session.endSession();
  }
};

// GET /api/loyalty/redemptions — User's redemption history
exports.getRedemptions = async (req, res) => {
  try {
    const redemptions = await Redemption.find({ userId: req.user.userId })
      .populate("rewardId", "name type image pointsCost")
      .sort({ createdAt: -1 });
    res.json(redemptions);
  } catch (err) {
    res.status(500).json({ message: "Error fetching redemptions", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── 3. SIDE QUESTS ─────────────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/quests — Get all quests with user progress
exports.getQuests = async (req, res) => {
  try {
    await ensureQuestCatalogDefaults();

    const userId = req.user.userId;
    const balance = await getOrCreateBalance(userId);
    const quests = await Quest.find({ enabled: true }).sort({ sortOrder: 1 });
    const userQuests = await UserQuest.find({ userId });
    const progressMap = {};
    userQuests.forEach((uq) => {
      progressMap[uq.questId.toString()] = uq;
    });

    const result = await Promise.all(
      quests.map(async (q) => {
        const userQuest = progressMap[q._id.toString()] || null;
        const runtime = await evaluateQuestProgress(q, userId, balance, userQuest);

        return {
          ...q.toObject(),
          userProgress: {
            completed: runtime.completed,
            completionCount: runtime.completionCount,
            completionLimit: runtime.completionLimit,
            completedAt: userQuest?.completedAt || null,
            lastCompletedAt: userQuest?.lastCompletedAt || userQuest?.completedAt || null,
            progress: runtime.progress,
            current: runtime.current,
            target: runtime.target,
            remaining: runtime.remaining,
            claimable: runtime.claimable,
            cooldownActive: runtime.cooldownActive,
            nextEligibleAt: runtime.nextEligibleAt,
            blockedReason: runtime.blockedReason,
            status: runtime.status,
          },
        };
      })
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Error fetching quests", error: err.message });
  }
};

// POST /api/loyalty/quests/:id/complete — Complete a quest
exports.completeQuest = async (req, res) => {
  try {
    const userId = req.user.userId;
    const quest = await Quest.findById(req.params.id);
    if (!quest || !quest.enabled) {
      return res.status(404).json({ message: "Quest not found" });
    }

    if (quest.featureFlag === false) {
      return res.status(400).json({ message: "Quest is coming soon" });
    }

    let userQuest = await UserQuest.findOne({
      userId,
      questId: quest._id,
    });
    const bal = await getOrCreateBalance(userId);
    const runtime = await evaluateQuestProgress(quest, userId, bal, userQuest);

    if (runtime.completed) {
      return res.status(400).json({ message: "Quest already completed" });
    }

    if (runtime.cooldownActive) {
      return res.status(429).json({
        message: "Quest cooldown active",
        nextEligibleAt: runtime.nextEligibleAt,
        retryAfterSeconds: Math.ceil((new Date(runtime.nextEligibleAt).getTime() - Date.now()) / 1000),
      });
    }

    if (runtime.blockedReason) {
      return res.status(403).json({ message: runtime.blockedReason });
    }

    if (!runtime.claimable) {
      return res.status(400).json({
        message: "Objective requirements not met yet",
        progress: runtime.progress,
        current: runtime.current,
        target: runtime.target,
      });
    }

    const nextCompletionCount = runtime.completionCount + 1;
    let earnedResult;

    if (quest.type === "signup_welcome") {
      const signupGrant = await grantSignupBonus(userId);
      earnedResult = signupGrant.result;
    } else {
      const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
      earnedResult = await addPoints(
        userId,
        quest.rewardPoints,
        "earn",
        "quest",
        `Quest completed: ${quest.title}`,
        { questId: quest._id, completionCount: nextCompletionCount, questType: quest.type },
        {
          idempotencyKey: `quest:${userId}:${quest._id}:${nextCompletionCount}`,
          economyCostEstimate: toNumber(quest.rewardPoints, 0) * pointValueEur,
        }
      );
    }

    const now = new Date();
    const completionLimit = runtime.completionLimit;
    if (!userQuest) {
      userQuest = await UserQuest.create({
        userId,
        questId: quest._id,
        completed: nextCompletionCount >= completionLimit,
        completedAt: now,
        completionCount: nextCompletionCount,
        lastCompletedAt: now,
        progress: 100,
      });
    } else {
      userQuest.completionCount = nextCompletionCount;
      userQuest.completed = nextCompletionCount >= completionLimit;
      userQuest.completedAt = now;
      userQuest.lastCompletedAt = now;
      userQuest.progress = 100;
      await userQuest.save();
    }

    earnedResult.balance.engagementScore =
      (earnedResult.balance.engagementScore || 0) +
      Math.min(12, Math.max(3, Math.floor(toNumber(earnedResult.transaction.amount, 0) / 20)));
    await updateTierFromSignals(earnedResult.balance);
    await earnedResult.balance.save();

    res.json({
      message: `Quest completed! +${earnedResult.transaction.amount} points`,
      earned: earnedResult.transaction.amount,
      newBalance: earnedResult.balance.points,
      completionCount: nextCompletionCount,
      completionLimit,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message, ...(err.meta || {}) });
    }
    res.status(500).json({ message: "Error completing quest", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── 4. PACKS (Loot System) ─────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/packs — List available packs
exports.getPacks = async (req, res) => {
  try {
    const bal = await getOrCreateBalance(req.user.userId);
    ensurePackProgress(bal);
    ensurePackCooldowns(bal);

    let packs = await Pack.find({ enabled: true, packClass: { $in: ["silver", "gold", "platinum"] } })
      .select("-drops.weight")
      .sort({ featured: -1, pointsCost: 1 });

    if (packs.length === 0) {
      packs = await Pack.find({ enabled: true }).select("-drops.weight").sort({ pointsCost: 1 });
    }

    res.json(
      packs.map((pack) => {
        const packData = pack.toObject();
        return {
          ...packData,
          packClass: normalizePackClass(packData),
          userState: buildPackUserState(packData, bal),
        };
      })
    );
  } catch (err) {
    res.status(500).json({ message: "Error fetching packs", error: err.message });
  }
};

// POST /api/loyalty/packs/:id/open — Open a pack (secure server-side RNG)
exports.openPack = async (req, res) => {
  const session = await Pack.startSession();
  try {
    const userId = req.user.userId;
    let payload = null;

    await session.withTransaction(async () => {
      const pack = await Pack.findById(req.params.id).session(session);
      if (!pack || !pack.enabled) {
        throw new Error("Pack not found or disabled");
      }

      const bal = await getOrCreateBalance(userId, session);
      const packClass = normalizePackClass(pack);
      const progress = ensurePackProgress(bal)[packClass];
      const cooldowns = ensurePackCooldowns(bal);
      const membershipLuck = await getPackLuckMultiplier(bal.tier);

      if (!tierAllows(bal.tier, pack.tierRequired)) {
        throw new Error(`Requires ${pack.tierRequired} tier`);
      }

      if (bal.points < pack.pointsCost) {
        throw new Error("Not enough points");
      }

      const cooldownUntil = cooldowns[packClass] ? new Date(cooldowns[packClass]) : null;
      if (cooldownUntil && cooldownUntil > new Date()) {
        throw new Error(`Cooldown active: ${Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000)} seconds remaining`);
      }

      const globalDailyCap = Math.max(1, toNumber(await getConfig("daily_pack_open_cap", 15), 15));
      const globalMonthlyCap = Math.max(1, toNumber(await getConfig("monthly_pack_open_cap", 250), 250));
      const dailyCap = Math.min(globalDailyCap, Math.max(1, toNumber(pack.dailyOpenLimit, globalDailyCap)));
      const monthlyCap = Math.min(globalMonthlyCap, Math.max(1, toNumber(pack.monthlyOpenLimit, globalMonthlyCap)));

      const [opensToday, opensThisMonth] = await Promise.all([
        PackOpening.countDocuments({ userId, createdAt: { $gte: startOfUtcDay() } }).session(session),
        PackOpening.countDocuments({ userId, createdAt: { $gte: startOfUtcMonth() } }).session(session),
      ]);

      if (opensToday >= dailyCap) {
        await createAbuseFlag(userId, "pack_open_spam", "medium", "Daily pack open cap exceeded", {
          opensToday,
          dailyCap,
          packId: pack._id,
        });
        throw new Error("Daily pack opening limit reached");
      }

      if (opensThisMonth >= monthlyCap) {
        throw new Error("Monthly pack opening limit reached");
      }

      const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
      const maxLiabilityRatio = toNumber(await getConfig("max_pack_liability_ratio", 2.25), 2.25);
      const expectedLiabilityEuro = await estimatePackExpectedLiabilityEuro(pack);
      const burnValueEuro = pack.pointsCost * pointValueEur;
      if (expectedLiabilityEuro > burnValueEuro * maxLiabilityRatio) {
        throw new Error("Pack temporarily disabled by economy guardrails");
      }

      const openNonce = crypto.randomBytes(10).toString("hex");
      await addPoints(
        userId,
        -pack.pointsCost,
        "spend",
        "pack_open",
        `Opened pack: ${pack.name}`,
        { packId: pack._id, openNonce },
        {
          idempotencyKey: `pack-open:${userId}:${pack._id}:${openNonce}`,
          session,
          bypassInflationControls: true,
        }
      );

      const pityTriggeredLegendary =
        !!pack.pityLegendaryThreshold && progress.withoutLegendary + 1 >= pack.pityLegendaryThreshold;
      const pityTriggeredEpic =
        !pityTriggeredLegendary &&
        !!pack.pityEpicThreshold &&
        progress.withoutEpic + 1 >= pack.pityEpicThreshold;

      let minimumRarity = pack.guaranteedRarity || "common";
      if (pityTriggeredLegendary) {
        minimumRarity = "legendary";
      } else if (pityTriggeredEpic) {
        minimumRarity = getStrongerRarity(minimumRarity, "epic");
      }

      const eligibleDrops = (pack.drops || []).filter((drop) => rarityAtLeast(drop.rarity, minimumRarity));
      const dropsPool = eligibleDrops.length > 0 ? eligibleDrops : pack.drops;
      const secureRoll = buildSecureRoll(`${userId}:${pack._id}:${openNonce}`);
      const selectedDrop = chooseWeightedDrop(
        dropsPool,
        membershipLuck * (pack.bonusMultiplier || 1),
        secureRoll.roll
      );

      let resultValue = null;
      let description = "";

      if (selectedDrop.type === "points") {
        const earned = Math.max(0, toNumber(selectedDrop.pointsAmount, 50));
        await addPoints(
          userId,
          earned,
          "earn",
          "pack_open",
          `Pack drop: ${earned} points`,
          { packId: pack._id, openNonce },
          {
            idempotencyKey: `pack-drop:${userId}:${pack._id}:${openNonce}`,
            session,
            economyCostEstimate: earned * pointValueEur,
          }
        );
        resultValue = earned;
        description = `${earned} bonus points`;
      } else if (selectedDrop.type === "coupon" || selectedDrop.type === "gift_card") {
        const code = generateCouponCode();
        const couponExpiresDays = Math.max(
          1,
          toNumber(await getConfig("coupon_default_expiry_days", 14), 14)
        );
        const minCartValue = Math.max(
          0,
          toNumber(await getConfig("coupon_default_min_cart_value", 25), 25)
        );

        const createdCoupons = await Coupon.create(
          [
            {
              code,
              userId,
              source: "pack",
              discountPercent: toNumber(selectedDrop.discountPercent, 0),
              discountAmount: toNumber(selectedDrop.discountAmount, 0),
              minimumCartValue: minCartValue,
              expiresAt: addDays(new Date(), couponExpiresDays),
              metadata: {
                rarity: selectedDrop.rarity,
                packId: pack._id,
                openNonce,
                oneCouponPerOrder: true,
              },
            },
          ],
          { session }
        );

        const coupon = createdCoupons[0];
        resultValue = {
          code,
          discountPercent: coupon.discountPercent,
          discountAmount: coupon.discountAmount,
          expiresAt: coupon.expiresAt,
          minimumCartValue: coupon.minimumCartValue,
        };

        description =
          selectedDrop.type === "coupon"
            ? selectedDrop.label || "Discount coupon"
            : selectedDrop.label || `€${selectedDrop.discountAmount} gift card`;
      } else if (selectedDrop.type === "product") {
        resultValue = { productId: selectedDrop.productId };
        description = selectedDrop.label || "Free product";
      } else {
        resultValue = null;
        description = "Better luck next time!";
      }

      const createdOpenings = await PackOpening.create(
        [
          {
            userId,
            packId: pack._id,
            pointsSpent: pack.pointsCost,
            rngNonce: secureRoll.nonce,
            rngHash: secureRoll.hash,
            result: {
              type: selectedDrop.type,
              rarity: selectedDrop.rarity,
              label: selectedDrop.label || description,
              value: resultValue,
            },
          },
        ],
        { session }
      );
      const opening = createdOpenings[0];

      progress.opens += 1;
      progress.withoutEpic = rarityAtLeast(selectedDrop.rarity, "epic") ? 0 : progress.withoutEpic + 1;
      progress.withoutLegendary = selectedDrop.rarity === "legendary" ? 0 : progress.withoutLegendary + 1;

      const baseCooldown = Math.max(
        0,
        toNumber(
          pack.cooldownSeconds,
          toNumber(await getConfig("pack_open_cooldown_seconds", 120), 120)
        )
      );
      const cooldownReductionPercent = clamp(
        toNumber(await getPackCooldownReductionPercent(bal.tier), 0),
        0,
        90
      );
      const effectiveCooldown = Math.max(
        0,
        Math.round(baseCooldown * (1 - cooldownReductionPercent / 100))
      );
      cooldowns[packClass] = effectiveCooldown > 0 ? new Date(Date.now() + effectiveCooldown * 1000) : null;

      bal.engagementScore = (bal.engagementScore || 0) + 2;
      await updateTierFromSignals(bal, session);
      await bal.save({ session });

      payload = {
        message: "Pack opened!",
        result: opening.result,
        newBalance: bal.points,
        reveal: buildPackReveal(pack, selectedDrop, {
          pityTriggeredEpic,
          pityTriggeredLegendary,
        }),
        userState: buildPackUserState(pack, bal),
      };
    });

    if (payload && RARITY_ORDER[payload.result.rarity] >= RARITY_ORDER.epic) {
      const { createNotification } = require("./notificationController");
      await createNotification(
        req.user.userId,
        "loyalty_reward",
        `${payload.result.rarity.toUpperCase()} Pack Pull!`,
        `${payload.result.label} dropped from your pack opening.`,
        {
          rarity: payload.result.rarity,
        }
      );
    }

    res.json(payload);
  } catch (err) {
    if (err.message.includes("not found") || err.message.includes("disabled")) {
      return res.status(404).json({ message: err.message });
    }
    if (err.message.includes("Requires")) {
      return res.status(403).json({ message: err.message });
    }
    if (err.message.includes("Cooldown active")) {
      return res.status(429).json({ message: err.message });
    }
    if (
      err.message.includes("Not enough points") ||
      err.message.includes("limit") ||
      err.message.includes("guardrails")
    ) {
      return res.status(400).json({ message: err.message });
    }

    res.status(500).json({ message: "Error opening pack", error: err.message });
  } finally {
    await session.endSession();
  }
};

// GET /api/loyalty/packs/history — User's pack opening history
exports.getPackHistory = async (req, res) => {
  try {
    const history = await PackOpening.find({ userId: req.user.userId })
      .populate("packId", "name image")
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(history);
  } catch (err) {
    res.status(500).json({ message: "Error fetching pack history", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── 5. MEMBERSHIP / TIERS ─────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/membership — Get available tiers + user's current tier
exports.getMembership = async (req, res) => {
  try {
    const [tiers, bal] = await Promise.all([
      Membership.find({ enabled: true }),
      getOrCreateBalance(req.user.userId),
    ]);
    res.json({
      currentTier: bal.tier,
      tierExpiresAt: bal.tierExpiresAt,
      tiers,
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching membership", error: err.message });
  }
};

// POST /api/loyalty/membership/upgrade — Upgrade tier (points-based for now)
exports.upgradeTier = async (req, res) => {
  try {
    const { tier } = req.body;
    if (!["silver", "gold", "platinum"].includes(tier)) {
      return res.status(400).json({ message: "Invalid tier" });
    }

    const membership = await Membership.findOne({ tier, enabled: true });
    if (!membership) {
      return res.status(404).json({ message: "Membership tier not found" });
    }

    const bal = await getOrCreateBalance(req.user.userId);
    if ((TIER_ORDER[tier] || 0) <= (TIER_ORDER[bal.tier] || 0) && bal.tierExpiresAt && bal.tierExpiresAt > new Date()) {
      return res.status(400).json({ message: "Choose a higher tier after your current pass ends" });
    }

    const cost = membership.price; // using price as points cost for now

    if (bal.points < cost) {
      return res.status(400).json({ message: "Not enough points", required: cost, current: bal.points });
    }

    // Deduct and upgrade
    await addPoints(req.user.userId, -cost, "spend", "tier_bonus", `Upgraded to ${membership.name}`, { tier });

    bal.tier = tier;
    bal.tierExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await bal.save();

    res.json({
      message: `Upgraded to ${membership.name}!`,
      tier: bal.tier,
      expiresAt: bal.tierExpiresAt,
      newBalance: bal.points,
    });
  } catch (err) {
    res.status(500).json({ message: "Error upgrading tier", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── 6. ADMIN ENDPOINTS ─────────────────────────────
// ═══════════════════════════════════════════════════════

function adminCheck(req, res) {
  if (req.user.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return false;
  }
  return true;
}

// ── Rewards CRUD ──
exports.adminGetRewards = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const rewards = await Reward.find().sort({ createdAt: -1 });
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminCreateReward = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const reward = await Reward.create(req.body);
    res.status(201).json(reward);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdateReward = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const reward = await Reward.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!reward) return res.status(404).json({ message: "Not found" });
    res.json(reward);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminDeleteReward = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    await Reward.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Quests CRUD ──
exports.adminGetQuests = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const quests = await Quest.find().sort({ sortOrder: 1 });
    res.json(quests);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminCreateQuest = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const quest = await Quest.create(req.body);
    res.status(201).json(quest);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdateQuest = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const quest = await Quest.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!quest) return res.status(404).json({ message: "Not found" });
    res.json(quest);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Packs CRUD ──
exports.adminGetPacks = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const packs = await Pack.find().sort({ createdAt: -1 });
    res.json(packs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminCreatePack = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const pack = await Pack.create(req.body);
    res.status(201).json(pack);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdatePack = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const pack = await Pack.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pack) return res.status(404).json({ message: "Not found" });
    res.json(pack);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Config CRUD ──
exports.adminGetConfig = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const configs = await LoyaltyConfig.find();
    res.json(configs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminSetConfig = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const { key, value, description } = req.body;
    const config = await LoyaltyConfig.findOneAndUpdate(
      { key },
      { value, description },
      { upsert: true, new: true }
    );
    res.json(config);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin: Grant points to a user ──
exports.adminGrantPoints = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const { userId, amount, reason } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ message: "userId and amount required" });
    }
    const result = await addPoints(
      userId,
      amount,
      amount > 0 ? "earn" : "spend",
      "admin_grant",
      reason || "Admin adjustment",
      { adminId: req.user.userId },
      {
        bypassInflationControls: true,
        skipTierMultiplier: true,
      }
    );
    res.json({ newBalance: result.balance.points, transaction: result.transaction });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin: Loyalty overview stats ──
exports.adminLoyaltyStats = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const [
      totalBalances,
      totalTransactions,
      totalRedemptions,
      totalPackOpenings,
      topUsers,
      openAbuseFlags,
      budgetSnapshot,
    ] = await Promise.all([
      LoyaltyBalance.aggregate([
        { $group: { _id: null, totalPoints: { $sum: "$points" }, totalLifetime: { $sum: "$lifetimePoints" }, count: { $sum: 1 } } },
      ]),
      PointsTransaction.countDocuments(),
      Redemption.countDocuments(),
      PackOpening.countDocuments(),
      LoyaltyBalance.find().sort({ lifetimePoints: -1 }).limit(5).populate("userId", "username email"),
      AbuseFlag.countDocuments({ status: { $in: ["open", "investigating"] } }),
      getBudgetUsageSnapshot(),
    ]);

    res.json({
      totalPointsInCirculation: totalBalances[0]?.totalPoints || 0,
      totalLifetimePointsEarned: totalBalances[0]?.totalLifetime || 0,
      usersWithPoints: totalBalances[0]?.count || 0,
      totalTransactions,
      totalRedemptions,
      totalPackOpenings,
      rewardBudget: budgetSnapshot,
      openAbuseFlags,
      topUsers: topUsers.map((u) => ({
        username: u.userId?.username,
        email: u.userId?.email,
        points: u.points,
        lifetimePoints: u.lifetimePoints,
        tier: u.tier,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin: Abuse flags list ──
exports.adminGetAbuseFlags = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const status = req.query.status;
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));

    const filter = {};
    if (status) {
      filter.status = status;
    }

    const flags = await AbuseFlag.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("userId", "username email");

    res.json({ flags, count: flags.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin: Pack expected value / ROI preview ──
exports.adminPreviewPackEconomy = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const packId = req.params.id || req.body.packId;
    if (!packId) {
      return res.status(400).json({ message: "packId is required" });
    }

    const pack = await Pack.findById(packId);
    if (!pack) {
      return res.status(404).json({ message: "Pack not found" });
    }

    const pointValueEur = toNumber(await getConfig("point_value_eur", 0.01), 0.01);
    const maxLiabilityRatio = toNumber(await getConfig("max_pack_liability_ratio", 2.25), 2.25);
    const expectedLiabilityEuro = await estimatePackExpectedLiabilityEuro(pack);
    const burnedValueEuro = pack.pointsCost * pointValueEur;
    const evRatio = burnedValueEuro > 0 ? expectedLiabilityEuro / burnedValueEuro : 0;

    res.json({
      packId: pack._id,
      packName: pack.name,
      pointsCost: pack.pointsCost,
      pointValueEur,
      expectedLiabilityEuro,
      burnedValueEuro,
      evRatio,
      maxLiabilityRatio,
      isSafe: evRatio <= maxLiabilityRatio,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin: Manage memberships ──
exports.adminGetMemberships = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const memberships = await Membership.find();
    res.json(memberships);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpsertMembership = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    const membership = await Membership.findOneAndUpdate(
      { tier: req.body.tier },
      req.body,
      { upsert: true, new: true }
    );
    res.json(membership);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Seed default config & quests if empty ──
exports.seedDefaults = async (req, res) => {
  if (!adminCheck(req, res)) return;
  try {
    await ensureAdvancedLoyaltyDefaults();
    await ensureQuestCatalogDefaults();

    // Default rewards
    const rewardCount = await Reward.countDocuments();
    if (rewardCount === 0) {
      await Reward.insertMany([
        {
          name: "5% Discount Coupon",
          description: "5% off your next purchase",
          type: "coupon",
          pointsCost: 200,
          discountPercent: 5,
          image: "🏷️",
          couponExpiresDays: 14,
          minimumCartValue: 20,
          monthlyRedemptionLimitPerUser: 4,
        },
        {
          name: "10% Discount Coupon",
          description: "10% off your next purchase",
          type: "coupon",
          pointsCost: 400,
          discountPercent: 10,
          image: "🎫",
          couponExpiresDays: 14,
          minimumCartValue: 35,
          monthlyRedemptionLimitPerUser: 3,
        },
        {
          name: "€5 Gift Card",
          description: "€5 credit for the store",
          type: "gift_card",
          pointsCost: 500,
          discountAmount: 5,
          image: "💳",
          couponExpiresDays: 30,
          minimumCartValue: 25,
          monthlyRedemptionLimitPerUser: 2,
        },
        {
          name: "€10 Gift Card",
          description: "€10 credit for the store",
          type: "gift_card",
          pointsCost: 900,
          discountAmount: 10,
          image: "💎",
          couponExpiresDays: 30,
          minimumCartValue: 40,
          monthlyRedemptionLimitPerUser: 1,
        },
        {
          name: "Mystery Game Key",
          description: "A random game key from our collection",
          type: "product",
          pointsCost: 1500,
          image: "🎮",
          stock: 50,
          monthlyRedemptionLimitPerUser: 1,
        },
      ]);
    }

    res.json({ message: "Defaults seeded successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

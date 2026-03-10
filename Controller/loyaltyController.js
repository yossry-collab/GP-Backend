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
} = require("../Models/loyaltyModel");
const crypto = require("crypto");

// ═══════════════════════════════════════════════════════
// ─── HELPERS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════

// Get or create loyalty balance for a user
async function getOrCreateBalance(userId) {
  let bal = await LoyaltyBalance.findOne({ userId });
  if (!bal) {
    bal = await LoyaltyBalance.create({ userId, points: 0, lifetimePoints: 0 });
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
  const multipliers = { free: 1, silver: 1.5, gold: 2 };
  return multipliers[tier] || 1;
}

// Add points transaction and update balance
async function addPoints(userId, amount, type, source, description, metadata = {}) {
  const bal = await getOrCreateBalance(userId);
  const multiplier = type === "earn" ? getTierMultiplier(bal.tier) : 1;
  const finalAmount = type === "earn" ? Math.round(amount * multiplier) : amount;

  bal.points += finalAmount;
  if (finalAmount > 0) bal.lifetimePoints += finalAmount;
  if (bal.points < 0) bal.points = 0;
  await bal.save();

  const tx = await PointsTransaction.create({
    userId,
    type,
    amount: finalAmount,
    balance: bal.points,
    source,
    description,
    metadata,
  });

  return { balance: bal, transaction: tx };
}

// Generate a unique coupon code
function generateCouponCode() {
  return "GP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
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

    // Notify user about daily login points
    const { createNotification } = require("./notificationController");
    await createNotification(
      req.user.userId,
      "loyalty_points",
      "Daily Login Reward",
      `+${totalPoints} points! Day ${bal.streakDays} streak bonus.`,
      { points: totalPoints, streakDays: bal.streakDays }
    );

    res.json({
      points: totalPoints,
      streakDays: bal.streakDays,
      newBalance: result.balance.points,
      message: `+${totalPoints} points! (${bal.streakDays} day streak)`,
    });
  } catch (err) {
    res.status(500).json({ message: "Error claiming daily login", error: err.message });
  }
};

// POST /api/loyalty/earn-purchase — Award points for a purchase (called internally or by order controller)
exports.earnFromPurchase = async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    if (!orderId || !amount) {
      return res.status(400).json({ message: "orderId and amount required" });
    }

    // Check if already awarded for this order
    const existing = await PointsTransaction.findOne({
      userId: req.user.userId,
      source: "purchase",
      "metadata.orderId": orderId,
    });
    if (existing) {
      return res.status(400).json({ message: "Points already awarded for this order" });
    }

    const ratio = await getConfig("points_per_euro", 10);
    const points = Math.round(amount * ratio);

    const result = await addPoints(
      req.user.userId,
      points,
      "earn",
      "purchase",
      `Purchase reward (€${amount.toFixed(2)})`,
      { orderId }
    );

    // Notify user about purchase points
    const { createNotification: notify } = require("./notificationController");
    await notify(
      req.user.userId,
      "loyalty_points",
      "Points Earned!",
      `You earned ${points} points from your purchase of $${amount.toFixed(2)}.`,
      { points, orderId }
    );

    res.json({
      earned: result.transaction.amount,
      newBalance: result.balance.points,
    });
  } catch (err) {
    res.status(500).json({ message: "Error earning points", error: err.message });
  }
};

// POST /api/loyalty/signup-bonus — One-time signup bonus
exports.signupBonus = async (req, res) => {
  try {
    const existing = await PointsTransaction.findOne({
      userId: req.user.userId,
      source: "signup",
    });
    if (existing) {
      return res.status(400).json({ message: "Signup bonus already claimed" });
    }

    const bonus = await getConfig("signup_bonus_points", 100);
    const result = await addPoints(
      req.user.userId,
      bonus,
      "earn",
      "signup",
      "Welcome bonus for joining Game Plug!"
    );

    res.json({
      earned: bonus,
      newBalance: result.balance.points,
      message: `Welcome! You earned ${bonus} bonus points!`,
    });

    // Notify user about signup bonus (fire-and-forget after response)
    const { createNotification: notifyUser } = require("./notificationController");
    notifyUser(
      req.user.userId,
      "welcome",
      "Welcome to Game Plug!",
      `You received ${bonus} bonus points for signing up. Start exploring!`,
      { points: bonus }
    );
  } catch (err) {
    res.status(500).json({ message: "Error granting signup bonus", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── 2. REWARDS & REDEMPTION ────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/rewards — List available rewards
exports.getRewards = async (req, res) => {
  try {
    const rewards = await Reward.find({ enabled: true }).sort({ pointsCost: 1 });
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ message: "Error fetching rewards", error: err.message });
  }
};

// POST /api/loyalty/rewards/:id/redeem — Redeem a reward
exports.redeemReward = async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward || !reward.enabled) {
      return res.status(404).json({ message: "Reward not found or disabled" });
    }

    const bal = await getOrCreateBalance(req.user.userId);

    // Check tier requirement
    const tierOrder = { free: 0, silver: 1, gold: 2, none: 0 };
    if (reward.tierRequired !== "none" && tierOrder[bal.tier] < tierOrder[reward.tierRequired]) {
      return res.status(403).json({ message: `Requires ${reward.tierRequired} tier or higher` });
    }

    // Check points
    if (bal.points < reward.pointsCost) {
      return res.status(400).json({
        message: "Not enough points",
        required: reward.pointsCost,
        current: bal.points,
      });
    }

    // Check stock
    if (reward.stock !== -1 && reward.stock <= 0) {
      return res.status(400).json({ message: "Reward out of stock" });
    }

    // Deduct points
    const result = await addPoints(
      req.user.userId,
      -reward.pointsCost,
      "spend",
      "redeem_reward",
      `Redeemed: ${reward.name}`,
      { rewardId: reward._id }
    );

    // Reduce stock
    if (reward.stock !== -1) {
      reward.stock -= 1;
      await reward.save();
    }

    // Generate coupon code if applicable
    let couponCode = null;
    if (reward.type === "coupon" || reward.type === "gift_card") {
      couponCode = generateCouponCode();
    }

    // Log redemption
    const redemption = await Redemption.create({
      userId: req.user.userId,
      rewardId: reward._id,
      pointsSpent: reward.pointsCost,
      couponCode,
      metadata: { rewardName: reward.name, rewardType: reward.type },
    });

    res.json({
      message: `Successfully redeemed: ${reward.name}`,
      redemption,
      couponCode,
      newBalance: result.balance.points,
    });
  } catch (err) {
    res.status(500).json({ message: "Error redeeming reward", error: err.message });
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
    const quests = await Quest.find({ enabled: true }).sort({ sortOrder: 1 });
    const userQuests = await UserQuest.find({ userId: req.user.userId });
    const progressMap = {};
    userQuests.forEach((uq) => {
      progressMap[uq.questId.toString()] = {
        completed: uq.completed,
        completedAt: uq.completedAt,
        progress: uq.progress,
      };
    });

    const result = quests.map((q) => ({
      ...q.toObject(),
      userProgress: progressMap[q._id.toString()] || { completed: false, progress: 0 },
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Error fetching quests", error: err.message });
  }
};

// POST /api/loyalty/quests/:id/complete — Complete a quest
exports.completeQuest = async (req, res) => {
  try {
    const quest = await Quest.findById(req.params.id);
    if (!quest || !quest.enabled) {
      return res.status(404).json({ message: "Quest not found" });
    }

    // Check if already completed
    let userQuest = await UserQuest.findOne({
      userId: req.user.userId,
      questId: quest._id,
    });

    if (userQuest && userQuest.completed) {
      return res.status(400).json({ message: "Quest already completed" });
    }

    // Create or update user quest
    if (!userQuest) {
      userQuest = await UserQuest.create({
        userId: req.user.userId,
        questId: quest._id,
        completed: true,
        completedAt: new Date(),
        progress: 100,
      });
    } else {
      userQuest.completed = true;
      userQuest.completedAt = new Date();
      userQuest.progress = 100;
      await userQuest.save();
    }

    // Award points
    const result = await addPoints(
      req.user.userId,
      quest.rewardPoints,
      "earn",
      "quest",
      `Quest completed: ${quest.title}`,
      { questId: quest._id }
    );

    res.json({
      message: `Quest completed! +${result.transaction.amount} points`,
      earned: result.transaction.amount,
      newBalance: result.balance.points,
    });
  } catch (err) {
    res.status(500).json({ message: "Error completing quest", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── 4. PACKS (Loot System) ─────────────────────────
// ═══════════════════════════════════════════════════════

// GET /api/loyalty/packs — List available packs
exports.getPacks = async (req, res) => {
  try {
    const packs = await Pack.find({ enabled: true }).select("-drops.weight"); // hide weights from client
    res.json(packs);
  } catch (err) {
    res.status(500).json({ message: "Error fetching packs", error: err.message });
  }
};

// POST /api/loyalty/packs/:id/open — Open a pack (secure server-side RNG)
exports.openPack = async (req, res) => {
  try {
    const pack = await Pack.findById(req.params.id);
    if (!pack || !pack.enabled) {
      return res.status(404).json({ message: "Pack not found or disabled" });
    }

    const bal = await getOrCreateBalance(req.user.userId);

    // Check tier
    const tierOrder = { free: 0, silver: 1, gold: 2, none: 0 };
    if (pack.tierRequired !== "none" && tierOrder[bal.tier] < tierOrder[pack.tierRequired]) {
      return res.status(403).json({ message: `Requires ${pack.tierRequired} tier` });
    }

    // Check points
    if (bal.points < pack.pointsCost) {
      return res.status(400).json({ message: "Not enough points", required: pack.pointsCost, current: bal.points });
    }

    // Deduct points for opening
    await addPoints(req.user.userId, -pack.pointsCost, "spend", "pack_open", `Opened pack: ${pack.name}`, { packId: pack._id });

    // ── Weighted random selection (secure) ──
    const drops = pack.drops;
    const totalWeight = drops.reduce((sum, d) => sum + d.weight, 0);
    const rand = crypto.randomInt(0, totalWeight);
    let cumulative = 0;
    let selectedDrop = drops[drops.length - 1]; // fallback
    for (const drop of drops) {
      cumulative += drop.weight;
      if (rand < cumulative) {
        selectedDrop = drop;
        break;
      }
    }

    // Process the drop reward
    let resultValue = null;
    let description = "";

    switch (selectedDrop.type) {
      case "points": {
        const earned = selectedDrop.pointsAmount || 50;
        await addPoints(req.user.userId, earned, "earn", "pack_open", `Pack drop: ${earned} points`, { packId: pack._id });
        resultValue = earned;
        description = `${earned} bonus points`;
        break;
      }
      case "coupon": {
        const code = generateCouponCode();
        resultValue = {
          code,
          discountPercent: selectedDrop.discountPercent,
          discountAmount: selectedDrop.discountAmount,
        };
        description = selectedDrop.label || "Discount coupon";
        break;
      }
      case "product": {
        resultValue = { productId: selectedDrop.productId };
        description = selectedDrop.label || "Free product";
        break;
      }
      default: {
        resultValue = null;
        description = "Better luck next time!";
        break;
      }
    }

    // Log the opening
    const opening = await PackOpening.create({
      userId: req.user.userId,
      packId: pack._id,
      pointsSpent: pack.pointsCost,
      result: {
        type: selectedDrop.type,
        rarity: selectedDrop.rarity,
        label: selectedDrop.label || description,
        value: resultValue,
      },
    });

    // Refresh balance
    const updatedBal = await getOrCreateBalance(req.user.userId);

    res.json({
      message: `Pack opened!`,
      result: opening.result,
      newBalance: updatedBal.points,
    });
  } catch (err) {
    res.status(500).json({ message: "Error opening pack", error: err.message });
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
    if (!["silver", "gold"].includes(tier)) {
      return res.status(400).json({ message: "Invalid tier" });
    }

    const membership = await Membership.findOne({ tier, enabled: true });
    if (!membership) {
      return res.status(404).json({ message: "Membership tier not found" });
    }

    const bal = await getOrCreateBalance(req.user.userId);
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
      { adminId: req.user.userId }
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
    ] = await Promise.all([
      LoyaltyBalance.aggregate([
        { $group: { _id: null, totalPoints: { $sum: "$points" }, totalLifetime: { $sum: "$lifetimePoints" }, count: { $sum: 1 } } },
      ]),
      PointsTransaction.countDocuments(),
      Redemption.countDocuments(),
      PackOpening.countDocuments(),
      LoyaltyBalance.find().sort({ lifetimePoints: -1 }).limit(5).populate("userId", "username email"),
    ]);

    res.json({
      totalPointsInCirculation: totalBalances[0]?.totalPoints || 0,
      totalLifetimePointsEarned: totalBalances[0]?.totalLifetime || 0,
      usersWithPoints: totalBalances[0]?.count || 0,
      totalTransactions,
      totalRedemptions,
      totalPackOpenings,
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
    // Default configs
    const defaults = [
      { key: "points_per_euro", value: 10, description: "Points earned per €1 spent" },
      { key: "signup_bonus_points", value: 100, description: "Points awarded on registration" },
      { key: "daily_login_points", value: 10, description: "Base points for daily login" },
    ];
    for (const d of defaults) {
      await LoyaltyConfig.findOneAndUpdate({ key: d.key }, d, { upsert: true });
    }

    // Default quests
    const questCount = await Quest.countDocuments();
    if (questCount === 0) {
      await Quest.insertMany([
        { title: "Complete Your Profile", description: "Fill in all profile fields", type: "complete_profile", rewardPoints: 50, icon: "👤", sortOrder: 1 },
        { title: "Make Your First Purchase", description: "Buy any product from the store", type: "first_purchase", rewardPoints: 100, icon: "🛒", sortOrder: 2 },
        { title: "7-Day Login Streak", description: "Log in for 7 consecutive days", type: "streak_login", rewardPoints: 200, icon: "🔥", sortOrder: 3, metadata: { requiredDays: 7 } },
        { title: "Write a Review", description: "Leave a review on any product", type: "write_review", rewardPoints: 75, icon: "⭐", sortOrder: 4 },
        { title: "Share a Product", description: "Share any product link on social media", type: "share_product", rewardPoints: 50, icon: "📤", sortOrder: 5 },
        { title: "Follow Us on Twitter", description: "Follow @GamePlug on Twitter", type: "social_follow", rewardPoints: 30, icon: "🐦", sortOrder: 6, metadata: { url: "https://twitter.com/gameplug" } },
      ]);
    }

    // Default rewards
    const rewardCount = await Reward.countDocuments();
    if (rewardCount === 0) {
      await Reward.insertMany([
        { name: "5% Discount Coupon", description: "5% off your next purchase", type: "coupon", pointsCost: 200, discountPercent: 5, image: "🏷️" },
        { name: "10% Discount Coupon", description: "10% off your next purchase", type: "coupon", pointsCost: 400, discountPercent: 10, image: "🎫" },
        { name: "€5 Gift Card", description: "€5 credit for the store", type: "gift_card", pointsCost: 500, discountAmount: 5, image: "💳" },
        { name: "€10 Gift Card", description: "€10 credit for the store", type: "gift_card", pointsCost: 900, discountAmount: 10, image: "💎" },
        { name: "Mystery Game Key", description: "A random game key from our collection", type: "product", pointsCost: 1500, image: "🎮", stock: 50 },
      ]);
    }

    // Default packs
    const packCount = await Pack.countDocuments();
    if (packCount === 0) {
      await Pack.insertMany([
        {
          name: "Starter Pack",
          description: "A basic pack with common rewards",
          image: "📦",
          pointsCost: 100,
          drops: [
            { type: "points", rarity: "common", weight: 50, pointsAmount: 20, label: "20 Points" },
            { type: "points", rarity: "common", weight: 30, pointsAmount: 50, label: "50 Points" },
            { type: "coupon", rarity: "rare", weight: 15, discountPercent: 5, label: "5% Coupon" },
            { type: "coupon", rarity: "epic", weight: 4, discountPercent: 15, label: "15% Coupon" },
            { type: "nothing", rarity: "common", weight: 1, label: "Empty..." },
          ],
        },
        {
          name: "Premium Pack",
          description: "Higher chances for rare rewards",
          image: "🎁",
          pointsCost: 300,
          drops: [
            { type: "points", rarity: "common", weight: 30, pointsAmount: 50, label: "50 Points" },
            { type: "points", rarity: "rare", weight: 25, pointsAmount: 150, label: "150 Points" },
            { type: "coupon", rarity: "rare", weight: 20, discountPercent: 10, label: "10% Coupon" },
            { type: "coupon", rarity: "epic", weight: 15, discountPercent: 25, label: "25% Coupon" },
            { type: "gift_card", rarity: "epic", weight: 8, discountAmount: 5, label: "€5 Gift Card" },
            { type: "gift_card", rarity: "legendary", weight: 2, discountAmount: 20, label: "€20 Gift Card" },
          ],
        },
        {
          name: "Legendary Pack",
          description: "The ultimate pack — legendary drops await!",
          image: "👑",
          pointsCost: 750,
          tierRequired: "silver",
          drops: [
            { type: "points", rarity: "rare", weight: 25, pointsAmount: 200, label: "200 Points" },
            { type: "points", rarity: "epic", weight: 20, pointsAmount: 500, label: "500 Points" },
            { type: "coupon", rarity: "epic", weight: 20, discountPercent: 30, label: "30% Coupon" },
            { type: "gift_card", rarity: "epic", weight: 15, discountAmount: 10, label: "€10 Gift Card" },
            { type: "gift_card", rarity: "legendary", weight: 10, discountAmount: 50, label: "€50 Gift Card" },
            { type: "product", rarity: "legendary", weight: 5, label: "Mystery Game Key" },
            { type: "points", rarity: "legendary", weight: 5, pointsAmount: 2000, label: "JACKPOT 2000 Points!" },
          ],
        },
      ]);
    }

    // Default memberships
    const membershipCount = await Membership.countDocuments();
    if (membershipCount === 0) {
      await Membership.insertMany([
        {
          tier: "silver",
          name: "GamePlus Silver",
          price: 500,
          yearlyPrice: 5000,
          pointsMultiplier: 1.5,
          perks: ["1.5x points on purchases", "Access to Premium Packs", "Monthly bonus points"],
        },
        {
          tier: "gold",
          name: "GamePlus Gold",
          price: 1200,
          yearlyPrice: 12000,
          pointsMultiplier: 2.0,
          perks: ["2x points on purchases", "Access to Legendary Packs", "Exclusive rewards", "Priority support", "Monthly mega bonus"],
        },
      ]);
    }

    res.json({ message: "Defaults seeded successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

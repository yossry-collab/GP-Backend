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


// MODULE IMPORTS (REFACTORED)
const {
  TIER_ORDER,
  RARITY_ORDER,
  DEFAULT_PACK_PROFILES,
  DEFAULT_QUEST_CATALOG,
  normalizePackClass,
} = require("../Config/loyaltyCatalogs");

const {
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
} = require("../Utils/loyaltyHelpers");

// RE-EXPORTED FOR OTHER CONTROLLERS
exports.awardReferralInviteBonus = require("../Utils/loyaltyHelpers").addPoints; // mapped appropriately in logic
// Actually, let's keep the re-exports matching exactly what was in the original loyaltyController.js
// Wait! Let's check how the original exported them.
// In loyaltyController.js, at line 1458: exports.awardPurchasePointsForOrder = awardPurchasePointsForOrder;
// and at line 1459: exports.revokePurchasePointsForOrder = revokePurchasePointsForOrder;
// and at line 1623: exports.awardReferralInviteBonus = awardReferralInviteBonus;
// Since we want these functions to still reside in loyaltyController.js (or be imported and exported),
// let's make sure we import them from the controller if they are still inside,
// OR import them if we move them.
// Wait, are awardPurchasePointsForOrder, revokePurchasePointsForOrder, and awardReferralInviteBonus still in the controller?
// Yes, they are! They start after line 1100.
// So they are kept in the controller and exported exactly as before!
// Therefore, we don't need any special re-exports here, they are already at their original places in bottomLines!

// 1. POINTS & BALANCE

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

// 2. REWARDS & REDEMPTION

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

// 3. SIDE QUESTS

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

// 4. PACKS (Loot System)

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

      // Tier restriction removed based on user request
      /* if (!tierAllows(bal.tier, pack.tierRequired)) {
        throw new Error(`Requires ${pack.tierRequired} tier`);
      } */

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
      let selectedDrop = chooseWeightedDrop(
        dropsPool,
        membershipLuck * (pack.bonusMultiplier || 1),
        secureRoll.roll
      );

      // --- NEW LOGIC: User requested that every pack ALWAYS gives a redeem code
      if (selectedDrop.type !== "coupon" && selectedDrop.type !== "gift_card") {
        selectedDrop = {
          type: "coupon",
          rarity: selectedDrop.rarity,
          discountPercent: pack.pointsCost >= 400 ? 25 : 10,
          label: `${pack.pointsCost >= 400 ? 25 : 10}% Store Coupon`,
          revealText: "Guaranteed code drop!"
        };
      }

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

// 5. MEMBERSHIP / TIERS

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

// 6. ADMIN ENDPOINTS

function adminCheck(req, res) {
  if (req.user.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return false;
  }
  return true;
}

// Rewards CRUD
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

// Quests CRUD
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

// Packs CRUD
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

// Config CRUD
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

// Admin: Grant points to a user
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

// Admin: Loyalty overview stats
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
      totalUsers: totalBalances[0]?.count || 0,
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

// Admin: Abuse flags list
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

// Admin: Pack expected value / ROI preview
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

// Admin: Manage memberships
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

// Seed default config & quests if empty
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

// 7. COUPONS

// POST /api/loyalty/validate-coupon
exports.validateCoupon = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ message: "Coupon code is required" });
    }

    const coupon = await Coupon.findOne({
      code: code.toUpperCase(),
      status: "unused"
    });

    if (!coupon) {
      return res.status(400).json({ message: "Invalid or already used coupon" });
    }

    if (new Date() > new Date(coupon.expiresAt)) {
      return res.status(400).json({ message: "Coupon has expired" });
    }

    // Check if the user trying to use it is the owner
    // if the coupon was assigned to a specific user (which it usually is)
    if (coupon.userId && coupon.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ message: "This coupon does not belong to you" });
    }

    const isPercentage = coupon.discountPercent > 0;

    res.json({
      type: isPercentage ? "percentage" : "fixed",
      value: isPercentage ? coupon.discountPercent : coupon.discountAmount,
      minimumCartValue: coupon.minimumCartValue || 0
    });

  } catch (err) {
    res.status(500).json({ message: "Error validating coupon", error: err.message });
  }
};

// GET /api/loyalty/coupons
exports.getCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find({
      userId: req.user.userId,
      status: "unused",
      expiresAt: { $gt: new Date() }
    }).sort({ expiresAt: 1 });

    res.json(coupons);
  } catch (err) {
    res.status(500).json({ message: "Error fetching coupons", error: err.message });
  }
};

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/authMiddleware");
const lc = require("../Controller/loyaltyController");

// ═══════════════════════════════════════════════════════
// ─── USER ENDPOINTS (all require auth) ───────────────
// ═══════════════════════════════════════════════════════

// Points & Balance
router.get("/balance", verifyToken, lc.getBalance);
router.get("/history", verifyToken, lc.getHistory);
router.post("/daily-login", verifyToken, lc.dailyLogin);
router.post("/earn-purchase", verifyToken, lc.earnFromPurchase);
router.post("/signup-bonus", verifyToken, lc.signupBonus);

// Rewards
router.get("/rewards", verifyToken, lc.getRewards);
router.post("/rewards/:id/redeem", verifyToken, lc.redeemReward);
router.get("/redemptions", verifyToken, lc.getRedemptions);

// Quests
router.get("/quests", verifyToken, lc.getQuests);
router.post("/quests/:id/complete", verifyToken, lc.completeQuest);

// Packs
router.get("/packs", verifyToken, lc.getPacks);
router.post("/packs/:id/open", verifyToken, lc.openPack);
router.get("/packs/history", verifyToken, lc.getPackHistory);

// Membership
router.get("/membership", verifyToken, lc.getMembership);
router.post("/membership/upgrade", verifyToken, lc.upgradeTier);

// ═══════════════════════════════════════════════════════
// ─── ADMIN ENDPOINTS ─────────────────────────────────
// ═══════════════════════════════════════════════════════

// Admin: Overview
router.get("/admin/stats", verifyToken, lc.adminLoyaltyStats);
router.post("/admin/seed", verifyToken, lc.seedDefaults);
router.post("/admin/grant-points", verifyToken, lc.adminGrantPoints);

// Admin: Config
router.get("/admin/config", verifyToken, lc.adminGetConfig);
router.post("/admin/config", verifyToken, lc.adminSetConfig);

// Admin: Rewards CRUD
router.get("/admin/rewards", verifyToken, lc.adminGetRewards);
router.post("/admin/rewards", verifyToken, lc.adminCreateReward);
router.put("/admin/rewards/:id", verifyToken, lc.adminUpdateReward);
router.delete("/admin/rewards/:id", verifyToken, lc.adminDeleteReward);

// Admin: Quests CRUD
router.get("/admin/quests", verifyToken, lc.adminGetQuests);
router.post("/admin/quests", verifyToken, lc.adminCreateQuest);
router.put("/admin/quests/:id", verifyToken, lc.adminUpdateQuest);

// Admin: Packs CRUD
router.get("/admin/packs", verifyToken, lc.adminGetPacks);
router.post("/admin/packs", verifyToken, lc.adminCreatePack);
router.put("/admin/packs/:id", verifyToken, lc.adminUpdatePack);

// Admin: Memberships
router.get("/admin/memberships", verifyToken, lc.adminGetMemberships);
router.post("/admin/memberships", verifyToken, lc.adminUpsertMembership);

module.exports = router;

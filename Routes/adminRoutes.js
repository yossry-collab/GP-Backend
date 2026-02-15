const express = require("express");
const router = express.Router();
const { getStats, getAdvancedStats, getMailingList } = require("../Controller/adminController");
const { verifyToken } = require("../Middleware/authMiddleware");

// GET /api/admin/stats - Dashboard statistics (admin only)
router.get("/stats", verifyToken, getStats);

// GET /api/admin/advanced-stats - Advanced KPI metrics (admin only)
router.get("/advanced-stats", verifyToken, getAdvancedStats);

// GET /api/admin/mailing-list - Export user emails (admin only)
router.get("/mailing-list", verifyToken, getMailingList);

module.exports = router;

const express = require("express");
const router = express.Router();
const { getStats } = require("../Controller/adminController");
const { verifyToken } = require("../Middleware/authMiddleware");

// GET /api/admin/stats - Dashboard statistics (admin only)
router.get("/stats", verifyToken, getStats);

module.exports = router;

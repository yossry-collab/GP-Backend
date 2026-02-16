const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/authMiddleware");
const nc = require("../Controller/notificationController");

// All routes require authentication
router.get("/", verifyToken, nc.getNotifications);
router.get("/unread-count", verifyToken, nc.getUnreadCount);
router.put("/read-all", verifyToken, nc.markAllAsRead);
router.put("/:id/read", verifyToken, nc.markAsRead);
router.delete("/clear", verifyToken, nc.clearAll);
router.delete("/:id", verifyToken, nc.deleteNotification);

module.exports = router;

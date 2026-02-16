const Notification = require("../Models/notificationModel");

// ═══════════════════════════════════════════════════════
// ─── HELPER: Create a notification (used by other controllers) ──
// ═══════════════════════════════════════════════════════
exports.createNotification = async (userId, type, title, message, data = {}) => {
  try {
    const notif = await Notification.create({ userId, type, title, message, data });
    return notif;
  } catch (err) {
    console.error("Failed to create notification:", err.message);
    return null;
  }
};

// ═══════════════════════════════════════════════════════
// ─── GET /api/notifications — User's notifications ───
// ═══════════════════════════════════════════════════════
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId }),
      Notification.countDocuments({ userId, read: false }),
    ]);

    res.json({ notifications, total, unreadCount, page, limit });
  } catch (err) {
    res.status(500).json({ message: "Error fetching notifications", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── GET /api/notifications/unread-count ─────────────
// ═══════════════════════════════════════════════════════
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const count = await Notification.countDocuments({ userId, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: "Error fetching unread count", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── PUT /api/notifications/:id/read — Mark one as read
// ═══════════════════════════════════════════════════════
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId },
      { read: true },
      { new: true }
    );
    if (!notif) return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Marked as read", notification: notif });
  } catch (err) {
    res.status(500).json({ message: "Error marking notification", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── PUT /api/notifications/read-all — Mark all as read
// ═══════════════════════════════════════════════════════
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const result = await Notification.updateMany({ userId, read: false }, { read: true });
    res.json({ message: "All notifications marked as read", modified: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: "Error marking all as read", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── DELETE /api/notifications/:id — Delete one ──────
// ═══════════════════════════════════════════════════════
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const notif = await Notification.findOneAndDelete({ _id: req.params.id, userId });
    if (!notif) return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Notification deleted" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting notification", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════
// ─── DELETE /api/notifications — Clear all ────────────
// ═══════════════════════════════════════════════════════
exports.clearAll = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const result = await Notification.deleteMany({ userId });
    res.json({ message: "All notifications cleared", deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ message: "Error clearing notifications", error: err.message });
  }
};

const User = require("../Models/userModel");
const Product = require("../Models/productModel");
const Order = require("../Models/orderModel");

// GET /api/admin/stats - Dashboard statistics
exports.getStats = async (req, res) => {
  try {
    // Check admin
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    // Parallel queries for speed
    const [
      totalUsers,
      totalProducts,
      totalOrders,
      orders,
      recentUsers,
      productsByCategory,
    ] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
      Order.find().sort({ createdAt: -1 }),
      User.find().sort({ createdAt: -1 }).limit(5).select("-password"),
      Product.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]),
    ]);

    // Calculate revenue
    const totalRevenue = orders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const completedOrders = orders.filter(o => o.status === "completed").length;
    const pendingOrders = orders.filter(o => o.status === "pending").length;
    const failedOrders = orders.filter(o => o.status === "failed").length;

    // Orders by month (last 12 months)
    const now = new Date();
    const monthlyOrders = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthOrders = orders.filter(o => {
        const d = new Date(o.createdAt);
        return d >= start && d <= end;
      });
      const monthRevenue = monthOrders.reduce((s, o) => s + (o.totalPrice || 0), 0);
      monthlyOrders.push({
        month: start.toLocaleString("default", { month: "short" }),
        year: start.getFullYear(),
        orders: monthOrders.length,
        revenue: Math.round(monthRevenue * 100) / 100,
        completed: monthOrders.filter(o => o.status === "completed").length,
        pending: monthOrders.filter(o => o.status === "pending").length,
        failed: monthOrders.filter(o => o.status === "failed").length,
      });
    }

    // Users registered by month (last 12 months)
    const allUsers = await User.find().select("createdAt");
    const monthlyUsers = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const count = allUsers.filter(u => {
        const d = new Date(u.createdAt);
        return d >= start && d <= end;
      }).length;
      monthlyUsers.push({
        month: start.toLocaleString("default", { month: "short" }),
        year: start.getFullYear(),
        users: count,
      });
    }

    // Category distribution
    const categories = {};
    productsByCategory.forEach(c => {
      categories[c._id] = c.count;
    });

    res.status(200).json({
      totalUsers,
      totalProducts,
      totalOrders,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      completedOrders,
      pendingOrders,
      failedOrders,
      monthlyOrders,
      monthlyUsers,
      categories,
      recentUsers,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching stats",
      error: error.message,
    });
  }
};

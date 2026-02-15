const User = require("../Models/userModel");
const Product = require("../Models/productModel");
const Order = require("../Models/orderModel");

// ─── Seeded random for consistent virtual data per day ───
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ─── Generate realistic virtual data blended with real DB data ───
function generateVirtualData(real) {
  const now = new Date();
  const daySeed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const rand = seededRandom(daySeed);

  // Helper: random int in range (inclusive)
  const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  // Helper: random float in range
  const randFloat = (min, max) => +(rand() * (max - min) + min).toFixed(2);

  // ── Boost totals to look realistic ──
  const totalUsers = real.totalUsers + randInt(230, 380);
  const totalProducts = real.totalProducts + randInt(45, 85);
  const vCompletedOrders = randInt(420, 680);
  const vPendingOrders = randInt(50, 120);
  const vFailedOrders = randInt(12, 35);
  const totalOrders = real.totalOrders + vCompletedOrders + vPendingOrders + vFailedOrders;
  const completedOrders = real.completedOrders + vCompletedOrders;
  const pendingOrders = real.pendingOrders + vPendingOrders;
  const failedOrders = real.failedOrders + vFailedOrders;
  const totalRevenue = real.totalRevenue + randFloat(18000, 42000);

  // ── Monthly orders with a natural growth trend ──
  // Base curves with seasonal variation
  const ordersTrend = [28, 35, 42, 55, 48, 62, 70, 58, 75, 82, 90, 95];
  const usersTrend = [12, 18, 15, 22, 28, 20, 35, 30, 38, 42, 45, 50];

  const monthlyOrders = real.monthlyOrders.map((mo, i) => {
    const vOrders = ordersTrend[i] + randInt(-8, 12);
    const vCompleted = Math.floor(vOrders * randFloat(0.55, 0.72));
    const vPending = Math.floor(vOrders * randFloat(0.15, 0.28));
    const vFailed = vOrders - vCompleted - vPending;
    const vRevenue = vOrders * randFloat(25, 65);
    return {
      month: mo.month,
      year: mo.year,
      orders: mo.orders + vOrders,
      revenue: Math.round((mo.revenue + vRevenue) * 100) / 100,
      completed: mo.completed + vCompleted,
      pending: mo.pending + Math.max(0, vPending),
      failed: mo.failed + Math.max(0, vFailed),
    };
  });

  const monthlyUsers = real.monthlyUsers.map((mu, i) => ({
    month: mu.month,
    year: mu.year,
    users: mu.users + usersTrend[i] + randInt(-4, 8),
  }));

  // ── Categories with realistic product counts ──
  const virtualCategories = {
    game: randInt(30, 55),
    software: randInt(18, 35),
    "gift-card": randInt(12, 28),
  };
  const categories = {};
  for (const key of Object.keys(virtualCategories)) {
    categories[key] = (real.categories[key] || 0) + virtualCategories[key];
  }
  // Add any real categories not in virtual
  for (const key of Object.keys(real.categories)) {
    if (!categories[key]) categories[key] = real.categories[key];
  }

  // ── Virtual recent users to fill the table ──
  const virtualNames = [
    { username: "sophia_dev", email: "sophia.chen@gmail.com", role: "user" },
    { username: "marcus_k", email: "marcus.kelly@outlook.com", role: "user" },
    { username: "emma_w", email: "emma.wilson@yahoo.com", role: "user" },
    { username: "alex_j", email: "alex.johnson@proton.me", role: "admin" },
    { username: "nadia_r", email: "nadia.rossi@gmail.com", role: "user" },
    { username: "liam_t", email: "liam.thomas@hotmail.com", role: "user" },
    { username: "yuki_m", email: "yuki.miyamoto@gmail.com", role: "user" },
    { username: "carlos_f", email: "carlos.fernandez@live.com", role: "user" },
  ];

  // Mix real recent users with virtual ones (real first, fill up to 8)
  const recentUsers = [...real.recentUsers];
  const needed = Math.max(0, 8 - recentUsers.length);
  for (let i = 0; i < needed && i < virtualNames.length; i++) {
    const daysAgo = randInt(1, 30);
    const joinDate = new Date(now);
    joinDate.setDate(joinDate.getDate() - daysAgo);
    recentUsers.push({
      _id: `virtual_${i}_${daySeed}`,
      username: virtualNames[i].username,
      email: virtualNames[i].email,
      role: virtualNames[i].role,
      createdAt: joinDate.toISOString(),
    });
  }

  return {
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
    recentUsers: recentUsers.slice(0, 8),
  };
}

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

    // ── Blend real data with virtual data for rich charts ──
    const realData = {
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
    };

    const enrichedStats = generateVirtualData(realData);
    res.status(200).json(enrichedStats);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching stats",
      error: error.message,
    });
  }
};

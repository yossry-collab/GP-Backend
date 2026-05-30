const User = require("../Models/userModel");
const Product = require("../Models/productModel");
const Order = require("../Models/orderModel");
const SupportTicket = require("../Models/supportTicketModel");



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
      allProducts,
    ] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
      Order.find().sort({ createdAt: -1 }),
      User.find().sort({ createdAt: -1 }).limit(5).select("-password"),
      Product.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]),
      Product.find().select("createdAt"),
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

    // Products created by month (last 12 months)
    const monthlyProducts = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const count = allProducts.filter(p => {
        const d = new Date(p.createdAt);
        return d >= start && d <= end;
      }).length;
      monthlyProducts.push({
        month: start.toLocaleString("default", { month: "short" }),
        year: start.getFullYear(),
        products: count,
      });
    }

    // Category distribution
    const categories = {};
    productsByCategory.forEach(c => {
      categories[c._id] = c.count;
    });

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
      monthlyProducts,
      categories,
      recentUsers,
    };

    res.status(200).json(realData);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching stats",
      error: error.message,
    });
  }
};

// GET /api/admin/advanced-stats - Advanced KPI metrics
exports.getAdvancedStats = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const [orders, users, products] = await Promise.all([
      Order.find().populate("items.productId", "name image category"),
      User.countDocuments(),
      Product.find().select("name price category stock"),
    ]);

    const completedOrders = orders.filter(o => o.status === "completed");
    const totalRevenue = completedOrders.reduce((s, o) => s + (o.totalPrice || 0), 0);
    const avgOrderValue = completedOrders.length > 0 ? totalRevenue / completedOrders.length : 0;
    const conversionRate = orders.length > 0 ? (completedOrders.length / orders.length) * 100 : 0;

    // Revenue by month (last 12 months)
    const now = new Date();
    const revenueByMonth = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthOrders = completedOrders.filter(o => {
        const d = new Date(o.createdAt);
        return d >= start && d <= end;
      });
      const revenue = monthOrders.reduce((s, o) => s + (o.totalPrice || 0), 0);
      revenueByMonth.push({
        month: start.toLocaleString("default", { month: "short" }),
        year: start.getFullYear(),
        revenue: Math.round(revenue * 100) / 100,
        orders: monthOrders.length,
      });
    }

    // Top 5 products by order frequency
    const productFreq = {};
    orders.forEach(order => {
      (order.items || []).forEach(item => {
        const pid = item.productId?._id?.toString() || item.productId?.toString();
        const name = item.name || item.productId?.name || "Unknown";
        if (!pid) return;
        if (!productFreq[pid]) {
          productFreq[pid] = { name, image: item.productId?.image || "", category: item.productId?.category || item.category || "", count: 0, revenue: 0 };
        }
        productFreq[pid].count += item.quantity || 1;
        productFreq[pid].revenue += (item.price || 0) * (item.quantity || 1);
      });
    });
    const topProducts = Object.entries(productFreq)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([id, data]) => ({ productId: id, ...data, revenue: Math.round(data.revenue * 100) / 100 }));

    // Revenue this month
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const revenueThisMonth = completedOrders
      .filter(o => new Date(o.createdAt) >= thisMonthStart)
      .reduce((s, o) => s + (o.totalPrice || 0), 0);

    // Low stock products
    const lowStock = products.filter(p => p.stock <= 5).map(p => ({ _id: p._id, name: p.name, stock: p.stock, category: p.category }));

    // Top category by revenue
    const categoryRevenue = {};
    completedOrders.forEach(o => {
      (o.items || []).forEach(item => {
        const cat = item.category || item.productId?.category || "other";
        categoryRevenue[cat] = (categoryRevenue[cat] || 0) + (item.price || 0) * (item.quantity || 1);
      });
    });
    const topCategory = Object.entries(categoryRevenue).sort((a, b) => b[1] - a[1])[0];

    res.status(200).json({
      avgOrderValue: Math.round(avgOrderValue * 100) / 100,
      conversionRate: Math.round(conversionRate * 10) / 10,
      revenueThisMonth: Math.round(revenueThisMonth * 100) / 100,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      topCategory: topCategory ? { name: topCategory[0], revenue: Math.round(topCategory[1] * 100) / 100 } : null,
      topProducts,
      revenueByMonth,
      lowStock,
      totalOrders: orders.length,
      completedOrders: completedOrders.length,
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching advanced stats", error: error.message });
  }
};

// GET /api/admin/mailing-list - Export user emails for mailing list
exports.getMailingList = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const users = await User.find().select("username email role createdAt").sort({ createdAt: -1 });

    // Also get unique emails from orders (guests who might not have accounts)
    const orderEmails = await Order.aggregate([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: "$user" },
      { $group: { _id: "$user.email", username: { $first: "$user.username" }, orderCount: { $sum: 1 }, totalSpent: { $sum: "$totalPrice" } } },
      { $sort: { totalSpent: -1 } },
    ]);

    res.status(200).json({
      message: "Mailing list retrieved",
      totalUsers: users.length,
      users: users.map(u => ({
        _id: u._id,
        username: u.username,
        email: u.email,
        role: u.role,

        joinedAt: u.createdAt,
      })),
      topBuyers: orderEmails.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching mailing list", error: error.message });
  }
};

// GET /api/admin/tickets - List all tickets for admin
exports.getAdminTickets = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const tickets = await SupportTicket.find()
      .populate("userId", "username email phonenumber profileImage")
      .populate("orderId", "totalPrice totalItems status paymentStatus createdAt")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      message: "All support tickets retrieved successfully",
      count: tickets.length,
      tickets,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving admin tickets",
      error: error.message,
    });
  }
};

// PUT /api/admin/tickets/:id/status - Update ticket status
exports.updateAdminTicketStatus = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { status } = req.body;
    if (!["open", "in_progress", "waiting_on_customer", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ message: "Invalid ticket status" });
    }

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate("userId", "username email phonenumber");

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    const { createNotification } = require("./notificationController");
    await createNotification(
      ticket.userId._id,
      "system",
      "Support Ticket Updated",
      `Your support ticket ${ticket._id.toString().slice(-8).toUpperCase()} is now ${status.replace("_", " ")}.`,
      { ticketId: ticket._id, status }
    );

    res.status(200).json({
      message: "Ticket status updated successfully",
      ticket,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating ticket status",
      error: error.message,
    });
  }
};

// POST /api/admin/tickets/:id/messages - Reply to a support ticket
exports.replyToAdminTicket = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ message: "Message cannot be empty" });
    }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    ticket.messages.push({
      sender: "agent",
      message: message.trim(),
      createdAt: new Date(),
    });

    if (ticket.status === "open") {
      ticket.status = "in_progress";
    }

    await ticket.save();

    const populatedTicket = await SupportTicket.findById(ticket._id)
      .populate("userId", "username email phonenumber")
      .populate("orderId", "totalPrice totalItems status paymentStatus createdAt");

    const { createNotification } = require("./notificationController");
    await createNotification(
      ticket.userId,
      "system",
      "Support Agent Replied",
      `An agent replied to your support ticket ${ticket._id.toString().slice(-8).toUpperCase()}: "${message.length > 50 ? message.slice(0, 50) + "..." : message}"`,
      { ticketId: ticket._id, status: ticket.status }
    );

    res.status(200).json({
      message: "Reply sent successfully",
      ticket: populatedTicket,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error replying to ticket",
      error: error.message,
    });
  }
};


const express = require("express");
const {
  checkoutOrder,
  getOrderById,
  getUserOrders,
  cancelOrder,
  getAllOrders,
  updateOrderStatus,
} = require("../Controller/orderController");
const { verifyToken } = require("../Middleware/authMiddleware");

const router = express.Router();

// POST /checkout → checkoutOrder (protected)
router.post("/checkout", verifyToken, checkoutOrder);

// GET / → getUserOrders (protected)
router.get("/", verifyToken, getUserOrders);

// GET /admin/all → getAllOrders (protected, admin only) — must be before /:id
router.get("/admin/all", verifyToken, getAllOrders);

// PUT /admin/:id/status → updateOrderStatus (protected, admin only)
router.put("/admin/:id/status", verifyToken, updateOrderStatus);

// GET /:id → getOrderById (protected)
router.get("/:id", verifyToken, getOrderById);

// PUT /:id/cancel → cancelOrder (protected)
router.put("/:id/cancel", verifyToken, cancelOrder);

module.exports = router;

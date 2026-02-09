const express = require("express");
const {
  checkoutOrder,
  getOrderById,
  getUserOrders,
  cancelOrder,
  getAllOrders,
} = require("../Controller/orderController");
const { verifyToken } = require("../Middleware/authMiddleware");

const router = express.Router();

// POST /checkout → checkoutOrder (protected)
router.post("/checkout", verifyToken, checkoutOrder);

// GET / → getUserOrders (protected)
router.get("/", verifyToken, getUserOrders);

// GET /:id → getOrderById (protected)
router.get("/:id", verifyToken, getOrderById);

// PUT /:id/cancel → cancelOrder (protected)
router.put("/:id/cancel", verifyToken, cancelOrder);

// GET /admin/all → getAllOrders (protected, admin only)
router.get("/admin/all", verifyToken, getAllOrders);

module.exports = router;

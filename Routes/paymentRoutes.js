const express = require("express");
const {
  initiatePayment,
  verifyPayment,
} = require("../Controller/paymentController");
const { verifyToken } = require("../Middleware/authMiddleware");

const router = express.Router();

// POST /api/payment/initiate — create Flouci payment session
router.post("/initiate", verifyToken, initiatePayment);

// GET /api/payment/verify/:payment_id — verify Flouci payment after redirect
router.get("/verify/:payment_id", verifyToken, verifyPayment);

module.exports = router;

const axios = require("axios");
const Order = require("../Models/orderModel");
const Cart = require("../Models/cartModel");
const Product = require("../Models/productModel");

const FLOUCI_API = "https://developers.flouci.com/api";

// 1. Initiate Payment — creates Flouci payment session for an existing order
exports.initiatePayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    const userId = req.user.userId || req.user._id;

    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    // Find the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Verify ownership
    if (order.userId.toString() !== userId.toString()) {
      return res
        .status(403)
        .json({ message: "Not authorized to pay for this order" });
    }

    // Don't allow paying for already-paid or failed orders
    if (order.paymentStatus === "paid") {
      return res.status(400).json({ message: "Order is already paid" });
    }

    // Calculate amount in millimes (1 TND = 1000 millimes)
    // totalPrice is in TND, include tax (10%)
    const amountMillimes = Math.round(order.totalPrice * 1.1 * 1000);

    // Build success/fail URLs
    const frontendUrl =
      process.env.FRONTEND_URL || "http://localhost:3000";
    const successUrl = `${frontendUrl}/payment/success?order_id=${order._id}`;
    const failUrl = `${frontendUrl}/payment/fail?order_id=${order._id}`;

    // Call Flouci generate_payment API
    const flouciRes = await axios.post(`${FLOUCI_API}/generate_payment`, {
      app_token: process.env.FLOUCI_APP_TOKEN,
      app_secret: process.env.FLOUCI_APP_SECRET,
      amount: amountMillimes.toString(),
      accept_card: "true",
      session_timeout_secs: 1200,
      success_link: successUrl,
      fail_link: failUrl,
      developer_tracking_id: process.env.FLOUCI_DEVELOPER_TRACKING_ID || order._id.toString(),
    });

    const { result } = flouciRes.data;

    if (!result || !result.link) {
      return res
        .status(502)
        .json({ message: "Failed to create Flouci payment session" });
    }

    // Save payment info on the order
    order.paymentId = result.payment_id;
    order.flouciPaymentLink = result.link;
    order.paymentMethod = "flouci";
    await order.save();

    return res.status(200).json({
      message: "Payment session created",
      paymentLink: result.link,
      paymentId: result.payment_id,
    });
  } catch (error) {
    console.error("Flouci initiatePayment error:", error?.response?.data || error.message);
    return res.status(500).json({
      message: "Error initiating payment",
      error: error.message,
    });
  }
};

// 2. Verify Payment — called after Flouci redirects back to success page
exports.verifyPayment = async (req, res) => {
  try {
    const { payment_id } = req.params;
    const userId = req.user.userId || req.user._id;

    if (!payment_id) {
      return res.status(400).json({ message: "payment_id is required" });
    }

    // Find order by paymentId
    const order = await Order.findOne({ paymentId: payment_id });
    if (!order) {
      return res.status(404).json({ message: "Order not found for this payment" });
    }

    // Verify ownership
    if (order.userId.toString() !== userId.toString()) {
      return res
        .status(403)
        .json({ message: "Not authorized to verify this payment" });
    }

    // If already paid, return success without re-processing
    if (order.paymentStatus === "paid") {
      return res.status(200).json({
        message: "Payment already verified",
        status: "SUCCESS",
        order,
      });
    }

    // Call Flouci verify_payment API
    const flouciRes = await axios.get(
      `${FLOUCI_API}/verify_payment/${payment_id}`,
      {
        headers: {
          apppublic: process.env.FLOUCI_APP_TOKEN,
          appsecret: process.env.FLOUCI_APP_SECRET,
        },
      }
    );

    const paymentStatus = flouciRes.data?.result?.status;

    if (paymentStatus === "SUCCESS") {
      // ✅ Payment confirmed — finalize the order

      // 1. Update order status
      order.paymentStatus = "paid";
      order.status = "completed";
      await order.save();

      // 2. Deduct product stock
      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: -item.quantity } },
          { new: true }
        );
      }

      // 3. Clear user's MongoDB cart
      await Cart.findOneAndUpdate(
        { userId: order.userId },
        { items: [], totalPrice: 0, totalItems: 0 },
        { new: true }
      );

      // Populate for response
      await order.populate("items.productId");

      return res.status(200).json({
        message: "Payment verified successfully",
        status: "SUCCESS",
        order,
      });
    } else {
      // ❌ Payment not successful
      order.paymentStatus = "failed";
      order.status = "failed";
      await order.save();

      return res.status(200).json({
        message: "Payment was not successful",
        status: paymentStatus || "FAILED",
        order,
      });
    }
  } catch (error) {
    console.error("Flouci verifyPayment error:", error?.response?.data || error.message);
    return res.status(500).json({
      message: "Error verifying payment",
      error: error.message,
    });
  }
};

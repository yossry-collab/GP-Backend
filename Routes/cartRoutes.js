const express = require("express");
const { verifyToken } = require("../Middleware/authMiddleware");
const {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
} = require("../Controller/cartController");

const router = express.Router();

// All routes are protected with verifyToken middleware

// GET user's cart
router.get("/", verifyToken, getCart);

// POST add item to cart
router.post("/add", verifyToken, addToCart);

// PUT update cart item quantity
router.put("/update", verifyToken, updateCartItem);

// POST remove item from cart
router.post("/remove", verifyToken, removeFromCart);

// POST clear entire cart
router.post("/clear", verifyToken, clearCart);

module.exports = router;

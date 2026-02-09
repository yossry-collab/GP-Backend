const Cart = require("../Models/cartModel");
const Product = require("../Models/productModel");

// Helper function to recalculate cart totals
const recalculateTotals = (cart) => {
  let totalPrice = 0;
  let totalItems = 0;

  cart.items.forEach((item) => {
    totalPrice += item.price * item.quantity;
    totalItems += item.quantity;
  });

  cart.totalPrice = totalPrice;
  cart.totalItems = totalItems;
  return cart;
};

// Get user's cart
exports.getCart = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;

    let cart = await Cart.findOne({ userId }).populate("items.productId");

    // If cart doesn't exist, return empty cart
    if (!cart) {
      return res.status(200).json({
        message: "Cart is empty",
        cart: {
          userId,
          items: [],
          totalPrice: 0,
          totalItems: 0,
        },
      });
    }

    res.status(200).json({
      message: "Cart retrieved successfully",
      cart,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving cart",
      error: error.message,
    });
  }
};

// Add item to cart
exports.addToCart = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const { productId, quantity } = req.body;

    // Validate inputs
    if (!productId || !quantity) {
      return res.status(400).json({
        message: "Product ID and quantity are required",
      });
    }

    if (quantity < 1 || !Number.isInteger(quantity)) {
      return res.status(400).json({
        message: "Quantity must be a positive integer",
      });
    }

    // Check if product exists
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    // Validate stock
    if (product.stock < quantity) {
      return res.status(400).json({
        message: `Insufficient stock. Available: ${product.stock}`,
        availableStock: product.stock,
      });
    }

    // Find or create cart
    let cart = await Cart.findOne({ userId });

    if (!cart) {
      cart = new Cart({
        userId,
        items: [],
      });
    }

    // Check if product already exists in cart
    const existingItem = cart.items.find(
      (item) => item.productId.toString() === productId.toString(),
    );

    if (existingItem) {
      // Check if new quantity + existing quantity exceeds stock
      const newQuantity = existingItem.quantity + quantity;
      if (newQuantity > product.stock) {
        return res.status(400).json({
          message: `Cannot add ${quantity} items. Total would be ${newQuantity}, but only ${product.stock} available`,
          availableStock: product.stock - existingItem.quantity,
        });
      }
      existingItem.quantity += quantity;
    } else {
      // Add new item to cart
      cart.items.push({
        productId: product._id,
        quantity,
        price: product.price,
        name: product.name,
        category: product.category,
      });
    }

    // Recalculate totals
    recalculateTotals(cart);

    // Save cart
    await cart.save();
    await cart.populate("items.productId");

    res.status(201).json({
      message: "Item added to cart successfully",
      cart,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error adding item to cart",
      error: error.message,
    });
  }
};

// Update cart item quantity
exports.updateCartItem = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const { productId, quantity } = req.body;

    // Validate inputs
    if (!productId || quantity === undefined) {
      return res.status(400).json({
        message: "Product ID and quantity are required",
      });
    }

    if (quantity < 1 || !Number.isInteger(quantity)) {
      return res.status(400).json({
        message: "Quantity must be a positive integer",
      });
    }

    // Check if product exists
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    // Validate stock
    if (product.stock < quantity) {
      return res.status(400).json({
        message: `Insufficient stock. Available: ${product.stock}`,
        availableStock: product.stock,
      });
    }

    // Find user's cart
    const cart = await Cart.findOne({ userId });

    if (!cart) {
      return res.status(404).json({
        message: "Cart not found",
      });
    }

    // Find item in cart
    const item = cart.items.find(
      (item) => item.productId.toString() === productId.toString(),
    );

    if (!item) {
      return res.status(404).json({
        message: "Item not found in cart",
      });
    }

    // Update quantity
    item.quantity = quantity;

    // Recalculate totals
    recalculateTotals(cart);

    // Save cart
    await cart.save();
    await cart.populate("items.productId");

    res.status(200).json({
      message: "Cart item updated successfully",
      cart,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating cart item",
      error: error.message,
    });
  }
};

// Remove item from cart
exports.removeFromCart = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    const { productId } = req.body;

    // Validate input
    if (!productId) {
      return res.status(400).json({
        message: "Product ID is required",
      });
    }

    // Find user's cart
    const cart = await Cart.findOne({ userId });

    if (!cart) {
      return res.status(404).json({
        message: "Cart not found",
      });
    }

    // Filter out the item
    const initialLength = cart.items.length;
    cart.items = cart.items.filter(
      (item) => item.productId.toString() !== productId.toString(),
    );

    // Check if item was found and removed
    if (cart.items.length === initialLength) {
      return res.status(404).json({
        message: "Item not found in cart",
      });
    }

    // Recalculate totals
    recalculateTotals(cart);

    // Save cart
    await cart.save();
    await cart.populate("items.productId");

    res.status(200).json({
      message: "Item removed from cart successfully",
      cart,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error removing item from cart",
      error: error.message,
    });
  }
};

// Clear entire cart
exports.clearCart = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;

    // Find and remove cart, or just clear items
    const cart = await Cart.findOne({ userId });

    if (!cart) {
      return res.status(404).json({
        message: "Cart not found",
      });
    }

    // Clear items and reset totals
    cart.items = [];
    cart.totalPrice = 0;
    cart.totalItems = 0;

    await cart.save();

    res.status(200).json({
      message: "Cart cleared successfully",
      cart,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error clearing cart",
      error: error.message,
    });
  }
};

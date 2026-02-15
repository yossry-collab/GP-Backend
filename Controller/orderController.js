const Order = require("../Models/orderModel");
const Cart = require("../Models/cartModel");
const Product = require("../Models/productModel");
const User = require("../Models/userModel");

// Helper function to validate stock availability
const validateStockAvailability = async (items) => {
  for (const item of items) {
    const product = await Product.findById(item.productId);
    if (!product) {
      throw new Error(`Product with ID ${item.productId} not found`);
    }
    if (product.stock < item.quantity) {
      throw new Error(
        `Insufficient stock for ${product.name}. Available: ${product.stock}, Requested: ${item.quantity}`
      );
    }
  }
};

// Helper function to validate product prices
const validatePrices = async (items) => {
  for (const item of items) {
    const product = await Product.findById(item.productId);
    if (!product) {
      throw new Error(`Product with ID ${item.productId} not found`);
    }
    // Store original prices at time of purchase - no need to validate exact match
    // but we can warn if prices differ significantly
    if (Math.abs(product.price - item.price) > 0.01) {
      console.warn(
        `Price mismatch for product ${product.name}: stored ${item.price}, current ${product.price}`
      );
    }
  }
};

// 1. Checkout Order - Main checkout function
exports.checkoutOrder = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;
    let cartItems, cartTotalPrice, cartTotalItems;

    // Accept items from request body (frontend localStorage cart)
    if (req.body.items && req.body.items.length > 0) {
      cartItems = req.body.items.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price,
        name: item.name,
        category: item.category || '',
      }));
      cartTotalItems = cartItems.reduce((sum, i) => sum + i.quantity, 0);
      cartTotalPrice = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
    } else {
      // Fallback: check MongoDB cart
      const cart = await Cart.findOne({ userId });
      if (!cart || cart.items.length === 0) {
        return res.status(400).json({
          message: "Cart is empty. Cannot proceed with checkout.",
        });
      }
      cartItems = cart.items;
      cartTotalPrice = cart.totalPrice;
      cartTotalItems = cart.totalItems;
    }

    // Validate all products still exist
    for (const item of cartItems) {
      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(404).json({
          message: `Product with ID ${item.productId} not found.`,
        });
      }
    }

    // Validate stock for each item
    await validateStockAvailability(cartItems);

    // Validate prices (warn if prices changed but still proceed)
    await validatePrices(cartItems);

    // Create new Order with cart items
    const order = new Order({
      userId,
      items: cartItems,
      totalPrice: cartTotalPrice,
      totalItems: cartTotalItems,
      status: "pending",
      paymentStatus: "pending",
    });

    // Save order to database
    await order.save();

    // Populate product details in the saved order
    await order.populate("items.productId");

    // Update product stock (subtract ordered quantities)
    for (const item of cartItems) {
      await Product.findByIdAndUpdate(
        item.productId,
        { $inc: { stock: -item.quantity } },
        { new: true }
      );
    }

    // Clear MongoDB cart if it exists
    await Cart.findOneAndUpdate(
      { userId },
      { items: [], totalPrice: 0, totalItems: 0 },
      { new: true }
    );

    // Return order confirmation
    return res.status(201).json({
      message: "Order placed successfully",
      order,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error during checkout",
      error: error.message,
    });
  }
};

// 2. Get Order by ID - Get single order
exports.getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId || req.user._id;
    const userRole = req.user.role;

    // Fetch order from database
    const order = await Order.findById(id).populate("items.productId");

    // Validate order exists
    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      });
    }

    // Check user owns order (or is admin)
    if (order.userId.toString() !== userId.toString() && userRole !== "admin") {
      return res.status(403).json({
        message: "You are not authorized to view this order",
      });
    }

    // Return order
    return res.status(200).json({
      message: "Order retrieved successfully",
      order,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving order",
      error: error.message,
    });
  }
};

// 3. Get User Orders - Get user's order history
exports.getUserOrders = async (req, res) => {
  try {
    const userId = req.user.userId || req.user._id;

    // Get all orders for user, populated with product details
    const orders = await Order.find({ userId })
      .populate("items.productId")
      .sort({ createdAt: -1 }); // Sort by date (newest first)

    return res.status(200).json({
      message: "User orders retrieved successfully",
      count: orders.length,
      orders,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving user orders",
      error: error.message,
    });
  }
};

// 4. Cancel Order - Cancel pending order
exports.cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId || req.user._id;

    // Check order exists
    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      });
    }

    // Check user owns order
    if (order.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        message: "You are not authorized to cancel this order",
      });
    }

    // Check order status is "pending"
    if (order.status !== "pending") {
      return res.status(400).json({
        message: `Cannot cancel order with status: ${order.status}. Only pending orders can be cancelled.`,
      });
    }

    // Check payment not already processed
    if (order.paymentStatus === "paid") {
      return res.status(400).json({
        message: "Cannot cancel order that has already been paid. Please contact support.",
      });
    }

    // Restore product stock as order is being cancelled
    for (const item of order.items) {
      await Product.findByIdAndUpdate(
        item.productId,
        { $inc: { stock: item.quantity } },
        { new: true }
      );
    }

    // Mark status as "failed"
    order.status = "failed";
    await order.save();

    // Return confirmation
    return res.status(200).json({
      message: "Order cancelled successfully",
      order,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error cancelling order",
      error: error.message,
    });
  }
};

// 5. Get All Orders - Admin view all orders
exports.getAllOrders = async (req, res) => {
  try {
    const userRole = req.user.role;

    // Check if user is admin
    if (userRole !== "admin") {
      return res.status(403).json({
        message: "You are not authorized to view all orders. Admin access required.",
      });
    }

    // Get all orders with user and product details
    const orders = await Order.find()
      .populate({
        path: "userId",
        select: "username email phonenumber",
      })
      .populate("items.productId")
      .sort({ createdAt: -1 }); // Sort by date (newest first)

    return res.status(200).json({
      message: "All orders retrieved successfully",
      count: orders.length,
      orders,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving all orders",
      error: error.message,
    });
  }
};

// 6. Update Order Status - Admin update order status
exports.updateOrderStatus = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (userRole !== "admin") {
      return res.status(403).json({ message: "Admin access required." });
    }

    const { id } = req.params;
    const { status, paymentStatus } = req.body;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (status) {
      if (!["pending", "completed", "failed"].includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }
      order.status = status;
    }

    if (paymentStatus) {
      if (!["pending", "paid", "failed"].includes(paymentStatus)) {
        return res.status(400).json({ message: "Invalid payment status value" });
      }
      order.paymentStatus = paymentStatus;
    }

    await order.save();

    // Re-populate for response
    await order.populate([
      { path: "userId", select: "username email phonenumber" },
      { path: "items.productId" },
    ]);

    return res.status(200).json({
      message: "Order status updated successfully",
      order,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating order status",
      error: error.message,
    });
  }
};

// 6. Override Order - Admin can edit items, prices, status (full override)
exports.overrideOrder = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (userRole !== "admin") {
      return res.status(403).json({ message: "Admin access required." });
    }

    const { id } = req.params;
    const { items, totalPrice, totalItems, status, paymentStatus } = req.body;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Update items if provided
    if (items && Array.isArray(items) && items.length > 0) {
      order.items = items.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price,
        name: item.name,
        category: item.category || "",
      }));
    }

    // Update totals
    if (totalPrice !== undefined) {
      order.totalPrice = totalPrice;
    } else if (items) {
      // Auto-calculate if items changed but totalPrice not provided
      order.totalPrice = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
    }

    if (totalItems !== undefined) {
      order.totalItems = totalItems;
    } else if (items) {
      order.totalItems = order.items.reduce((s, i) => s + i.quantity, 0);
    }

    // Update status fields
    if (status && ["pending", "completed", "failed"].includes(status)) {
      order.status = status;
    }
    if (paymentStatus && ["pending", "paid", "failed"].includes(paymentStatus)) {
      order.paymentStatus = paymentStatus;
    }

    await order.save();

    await order.populate([
      { path: "userId", select: "username email phonenumber" },
      { path: "items.productId" },
    ]);

    return res.status(200).json({
      message: "Order overridden successfully",
      order,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error overriding order",
      error: error.message,
    });
  }
};

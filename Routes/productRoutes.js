const express = require("express");
const router = express.Router();
const {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  searchProducts,
} = require("../Controller/productController");
const { verifyToken } = require("../Middleware/authMiddleware");

// Get all products with optional category filter
router.get("/", getAllProducts);

// Search products by category or name
router.get("/search", searchProducts);

// Get product by ID
router.get("/:id", getProductById);

// POST - Create new product (protected)
router.post("/", verifyToken, createProduct);

// PUT - Update product (protected)
router.put("/:id", verifyToken, updateProduct);

// DELETE - Delete product (protected)
router.delete("/:id", verifyToken, deleteProduct);

module.exports = router;

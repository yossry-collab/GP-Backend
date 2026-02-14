const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/authMiddleware");
const {
  browseProducts,
  getProduct,
  syncProducts,
  getPlatforms,
  getRegions,
  getAccountDetails,
} = require("../Controller/codesWholesaleController");

// Browse CW products (public - for viewing)
router.get("/products", browseProducts);

// Get single CW product with image + description
router.get("/products/:id", getProduct);

// Sync CW products into local database (admin only - protected)
router.post("/sync", verifyToken, syncProducts);

// Get available platforms
router.get("/platforms", getPlatforms);

// Get available regions
router.get("/regions", getRegions);

// Get CW account details (protected)
router.get("/account", verifyToken, getAccountDetails);

module.exports = router;

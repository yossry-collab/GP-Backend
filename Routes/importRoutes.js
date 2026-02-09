const express = require("express");
const router = express.Router();
const upload = require("../Middleware/uploadMiddleware");
const { 
  importProductsCSV, 
  downloadSampleCSV 
} = require("../Controller/productImportController");
const { verifyToken } = require("../Middleware/authMiddleware");

// POST - Import products from CSV (protected)
router.post("/import-csv", verifyToken, upload.single("file"), importProductsCSV);

// GET - Download sample CSV template (public)
router.get("/sample-csv", downloadSampleCSV);

module.exports = router;

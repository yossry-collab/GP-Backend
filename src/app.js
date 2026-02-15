const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db.js");
const userRoutes = require("../Routes/userRoutes");
const productRoutes = require("../Routes/productRoutes");
const importRoutes = require("../Routes/importRoutes");
const cartRoutes = require("../Routes/cartRoutes");
const orderRoutes = require("../Routes/orderRoutes");
const cwRoutes = require("../Routes/codesWholesaleRoutes");
const adminRoutes = require("../Routes/adminRoutes");
const loyaltyRoutes = require("../Routes/loyaltyRoutes");
const paymentRoutes = require("../Routes/paymentRoutes");

connectDB();

const app = express();

// CORS Configuration
const corsOptions = {
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://gameplug.onrender.com'],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API running with MongoDB 🚀");
});

// User Routes
app.use("/api/users", userRoutes);

// Product Routes
app.use("/api/products", productRoutes);

// Import Routes
app.use("/api/import", importRoutes);

// Cart Routes
app.use("/api/cart", cartRoutes);

// Order Routes
app.use("/api/orders", orderRoutes);

// CodesWholesale Routes
app.use("/api/cw", cwRoutes);

// Admin Routes
app.use("/api/admin", adminRoutes);

// Loyalty & Rewards Routes
app.use("/api/loyalty", loyaltyRoutes);

// Payment Routes (Flouci)
app.use("/api/payment", paymentRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

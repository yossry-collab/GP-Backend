const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const connectDB = require("./src/config/db.js");
const userRoutes = require("./Routes/userRoutes.js");
const productRoutes = require("./Routes/productRoutes.js");
const importRoutes = require("./Routes/importRoutes.js");
const orderRoutes = require("./Routes/orderRoutes.js");
const cwRoutes = require("./Routes/codesWholesaleRoutes.js");
const adminRoutes = require("./Routes/adminRoutes.js");
const loyaltyRoutes = require("./Routes/loyaltyRoutes.js");
const paymentRoutes = require("./Routes/paymentRoutes.js");
const notificationRoutes = require("./Routes/notificationRoutes.js");
const supportRoutes = require("./Routes/supportRoutes.js");
const chatbotRoutes = require("./Routes/chatbotRoutes.js");

connectDB();

const app = express();

// Simple request logger to aid debugging
app.use((req, res, next) => {
  try {
    console.log(`[REQ] ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
    if (req.method !== 'GET') {
      console.log('[REQ BODY]', JSON.stringify(req.body || req._parsedUrl || {}));
    }
  } catch (e) {}
  next();
});

// CORS Configuration
const corsOptions = {
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://gameplug.onrender.com', 'https://gameplug.vercel.app', 'https://gp-frontend-navy.vercel.app'],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.send("API running with MongoDB 🚀");
});

// User Routes
app.use("/api/users", userRoutes);

// Product Routes
app.use("/api/products", productRoutes);

// Import Routes
app.use("/api/import", importRoutes);

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

// Notification Routes
app.use("/api/notifications", notificationRoutes);

// Support Routes
app.use("/api/support", supportRoutes);

// Chatbot Routes
app.use("/api/chatbot", chatbotRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db.js");
const userRoutes = require("../Routes/userRoutes");
const productRoutes = require("../Routes/productRoutes");
const importRoutes = require("../Routes/importRoutes");
const cartRoutes = require("../Routes/cartRoutes");
const orderRoutes = require("../Routes/orderRoutes");

dotenv.config();
connectDB();

const app = express();

// CORS Configuration
const corsOptions = {
  origin: ['http://localhost:3000', 'https://your-frontend-domain.com'],
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

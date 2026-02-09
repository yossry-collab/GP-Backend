const express = require("express");
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

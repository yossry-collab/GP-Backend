const mongoose = require("mongoose");

let _isConnected = false;

const connectDB = async (options = {}) => {
  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;

  if (!uri) {
    throw new Error("❌ MongoDB URI is missing in .env file");
  }

  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 2000; // ms

  console.log("🔌 Connecting to MongoDB...");
  console.log("URI loaded:", uri ? "YES" : "NO");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        // keep other options safe
      });

      _isConnected = true;
      console.log("✅ MongoDB connected successfully");
      console.log("📦 Host:", mongoose.connection.host);
      return;
    } catch (error) {
      _isConnected = false;
      console.error(`❌ MongoDB connection attempt ${attempt} failed:`);
      console.error("Message:", error.message);
      console.error("Code:", error.code);

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error("All MongoDB connection attempts failed. Continuing without DB (fallback mode).");
      }
    }
  }
};

const isConnected = () => _isConnected || mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.isConnected = isConnected;
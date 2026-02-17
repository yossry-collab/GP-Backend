const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    console.log("📌 MONGO_URI:", process.env.MONGO_URI ? "✅ SET" : "❌ UNDEFINED");
    console.log("📌 NODE_ENV:", process.env.NODE_ENV);
    console.log("📌 PORT:", process.env.PORT);
    
    await mongoose.connect(process.env.MONGO_URI);

    console.log("✅ MongoDB connected");

    // --- Fix stale indexes (one-time cleanup) ---
    try {
      const usersCol = mongoose.connection.collection("users");
      const indexes = await usersCol.indexes();
      const phoneIdx = indexes.find((i) => i.name === "phonenumber_1");
      if (phoneIdx && !phoneIdx.sparse) {
        console.log("🔧 Dropping old non-sparse phonenumber index…");
        await usersCol.dropIndex("phonenumber_1");
        console.log("✅ Old phonenumber index dropped – Mongoose will recreate it as sparse");
      }
    } catch (idxErr) {
      // Not fatal — the index may not exist yet
      if (idxErr.codeName !== "IndexNotFound") {
        console.warn("⚠️  Index cleanup skipped:", idxErr.message);
      }
    }
  } catch (error) {
    console.error("❌ MongoDB connection failed");
    console.error(error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

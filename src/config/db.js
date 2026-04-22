const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    console.log("MONGO_URI:", process.env.MONGO_URI ? "SET" : "UNDEFINED");
    console.log("NODE_ENV:", process.env.NODE_ENV);
    console.log("PORT:", process.env.PORT);
    
    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed");
    console.error(error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

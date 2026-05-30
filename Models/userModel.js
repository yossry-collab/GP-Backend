const mongoose = require("mongoose");
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerified: { type: Boolean, default: false },
    password: { type: String, required: true },
    phonenumber: { type: String, required: false, unique: true, sparse: true },
    profileImage: { type: String, default: "" },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    resetPasswordCodeHash: { type: String, default: null },
    resetPasswordCodeExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);  

module.exports = mongoose.model("User", userSchema);
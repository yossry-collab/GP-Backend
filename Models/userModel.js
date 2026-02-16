const mongoose = require("mongoose");
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phonenumber: { type: String, required: false, unique: true },
    role: { type: String, enum: ['user', 'admin', 'visitor'], default: 'user' },
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationOtpHash: { type: String, default: null },
    emailVerificationOtpExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);  

module.exports = mongoose.model("User", userSchema);
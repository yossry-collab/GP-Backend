const User = require("../Models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { sendVerificationOtpEmail } = require("../Services/mailerService");

const OTP_EXPIRY_MINUTES = 10;

const generateOtp = () => `${Math.floor(100000 + Math.random() * 900000)}`;

const hashOtp = (otp) => {
  return crypto.createHash("sha256").update(otp).digest("hex");
};

const issueTokenForUser = (user) => {
  return jwt.sign(
    { userId: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

// REGISTER to Create new user with hashed password
exports.register = async (req, res) => {
  try {
    const { username, email, password, phonenumber } = req.body;

    if (!username || !email || !password || !phonenumber) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingByEmail = await User.findOne({ email });
    const existingByUsername = await User.findOne({ username });
    const existingByPhone = await User.findOne({ phonenumber });

    if (existingByEmail?.isEmailVerified) {
      return res.status(400).json({ message: "Email is already in use" });
    }

    if (
      existingByUsername &&
      (!existingByEmail || String(existingByUsername._id) !== String(existingByEmail._id))
    ) {
      return res.status(400).json({ message: "Username is already taken" });
    }

    if (
      existingByPhone &&
      (!existingByEmail || String(existingByPhone._id) !== String(existingByEmail._id))
    ) {
      return res.status(400).json({ message: "Phone number is already in use" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    let user;
    if (existingByEmail && !existingByEmail.isEmailVerified) {
      existingByEmail.username = username;
      existingByEmail.password = hashedPassword;
      existingByEmail.phonenumber = phonenumber;
      existingByEmail.emailVerificationOtpHash = otpHash;
      existingByEmail.emailVerificationOtpExpiresAt = otpExpiresAt;
      user = await existingByEmail.save();
    } else {
      user = new User({
        username,
        email,
        password: hashedPassword,
        phonenumber,
        isEmailVerified: false,
        emailVerificationOtpHash: otpHash,
        emailVerificationOtpExpiresAt: otpExpiresAt,
      });
      await user.save();
    }

    await sendVerificationOtpEmail({
      toEmail: email,
      username,
      otp,
    });

    res.status(201).json({
      message: "Registration successful. Verification OTP sent to your email.",
      requiresVerification: true,
      email: user.email,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern || {})[0] || "field";
      const fieldLabel =
        duplicateField === "phonenumber"
          ? "Phone number"
          : duplicateField === "username"
            ? "Username"
            : duplicateField === "email"
              ? "Email"
              : "Value";

      return res.status(400).json({
        message: `${fieldLabel} is already in use`,
        error: error.message,
      });
    }

    const isEmailConfigError =
      error.message?.includes("Email service is not configured") ||
      error.message?.includes("Email credentials missing");

    res.status(isEmailConfigError ? 503 : 500).json({
      message: isEmailConfigError
        ? "Email verification service is not configured"
        : "Registration error",
      error: error.message,
    });
  }
};

exports.verifyEmailOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    if (!user.emailVerificationOtpHash || !user.emailVerificationOtpExpiresAt) {
      return res.status(400).json({ message: "No OTP found. Please request a new OTP." });
    }

    if (new Date() > user.emailVerificationOtpExpiresAt) {
      return res.status(400).json({ message: "OTP expired. Please request a new OTP." });
    }

    const incomingHash = hashOtp(String(otp).trim());
    if (incomingHash !== user.emailVerificationOtpHash) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    user.isEmailVerified = true;
    user.emailVerificationOtpHash = null;
    user.emailVerificationOtpExpiresAt = null;
    await user.save();

    const token = issueTokenForUser(user);

    res.status(200).json({
      message: "Email verified successfully",
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        phonenumber: user.phonenumber,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Email verification error", error: error.message });
  }
};

exports.resendVerificationOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    const otp = generateOtp();
    user.emailVerificationOtpHash = hashOtp(otp);
    user.emailVerificationOtpExpiresAt = new Date(
      Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
    );
    await user.save();

    await sendVerificationOtpEmail({
      toEmail: user.email,
      username: user.username,
      otp,
    });

    res.status(200).json({ message: "A new OTP was sent to your email" });
  } catch (error) {
    res.status(500).json({ message: "Resend OTP error", error: error.message });
  }
};

// LOGIN - Verify credentials and return JWT token
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Find user by email
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({
        message: "Please verify your email before logging in",
        requiresEmailVerification: true,
      });
    }

    // Check if user is banned
    if (user.isBanned) {
      return res.status(403).json({ message: "Your account has been banned.", reason: user.banReason || 'No reason provided' });
    }

    // Compare provided password with hashed password in DB
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Create JWT token (expires in 7 days)
    const token = issueTokenForUser(user);

    res.status(200).json({
      message: "Login successful",
      token,
      user: { _id: user._id, username: user.username, email, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ message: "Login error", error: error.message });
  }
};
// CREATE - Add a new user
exports.createUser = async (req, res) => {
  try {
    const { username, email, password, phonenumber } = req.body;

    // Validation
    if (!username || !email || !password || !phonenumber) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }, { phonenumber }],
    });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user (admin-created users are marked verified)
    const user = new User({
      username,
      email,
      password: hashedPassword,
      phonenumber,
      isEmailVerified: true,
    });
    await user.save();

    res.status(201).json({
      message: "User created successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error creating user",
      error: error.message,
    });
  }
};

// READ - Get all users
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.status(200).json({
      message: "Users retrieved successfully",
      count: users.length,
      users,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving users",
      error: error.message,
    });
  }
};

// READ - Get a single user by ID
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "User retrieved successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving user",
      error: error.message,
    });
  }
};

// UPDATE - Update user by ID
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, phonenumber } = req.body;

    // Check if at least one field is provided
    if (!username && !email && !phonenumber) {
      return res.status(400).json({
        message: "At least one field is required to update",
      });
    }

    // Build update object
    const updateData = {};
    if (username) updateData.username = username;
    if (email) updateData.email = email;
    if (phonenumber) updateData.phonenumber = phonenumber;

    const user = await User.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "User updated successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating user",
      error: error.message,
    });
  }
};

// UPDATE PROFILE - Update own profile (authenticated user)
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { username, email, phonenumber, currentPassword, newPassword } = req.body;

    // Check if at least one field is provided
    if (!username && !email && !phonenumber && !newPassword) {
      return res.status(400).json({
        message: "At least one field is required to update",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // If changing password, verify current password
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: "Current password is required to change password" });
      }
      const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isPasswordValid) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters" });
      }
      user.password = await bcrypt.hash(newPassword, 10);
    }

    // Check for duplicate username/email/phone
    if (username && username !== user.username) {
      const existing = await User.findOne({ username });
      if (existing) return res.status(400).json({ message: "Username already taken" });
      user.username = username;
    }
    if (email && email !== user.email) {
      const existing = await User.findOne({ email });
      if (existing) return res.status(400).json({ message: "Email already in use" });
      user.email = email;
    }
    if (phonenumber && phonenumber !== user.phonenumber) {
      const existing = await User.findOne({ phonenumber });
      if (existing) return res.status(400).json({ message: "Phone number already in use" });
      user.phonenumber = phonenumber;
    }

    await user.save();

    res.status(200).json({
      message: "Profile updated successfully",
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        phonenumber: user.phonenumber,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating profile",
      error: error.message,
    });
  }
};

// BAN - Ban a user by ID
exports.banUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.role === 'admin') {
      return res.status(400).json({ message: 'Cannot ban an admin user' });
    }

    user.isBanned = true;
    user.banReason = reason || '';
    await user.save();

    res.status(200).json({ message: 'User banned successfully', user: { _id: user._id, username: user.username, email: user.email, isBanned: user.isBanned, banReason: user.banReason } });
  } catch (error) {
    res.status(500).json({ message: 'Error banning user', error: error.message });
  }
};

// UNBAN - Unban a user by ID
exports.unbanUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isBanned = false;
    user.banReason = '';
    await user.save();

    res.status(200).json({ message: 'User unbanned successfully', user: { _id: user._id, username: user.username, email: user.email, isBanned: user.isBanned } });
  } catch (error) {
    res.status(500).json({ message: 'Error unbanning user', error: error.message });
  }
};

// DELETE - Delete user by ID
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndDelete(id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "User deleted successfully",
      user,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error deleting user",
      error: error.message,
    });
  }
};

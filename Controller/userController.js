const User = require("../Models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// REGISTER to Create new user with hashed password
exports.register = async (req, res) => {
  try {
    const { username, email, password, phonenumber } = req.body;

    if (!username || !email || !password || !phonenumber) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }, { phonenumber }],
    });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash password (10 rounds of hashing = security level)
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user with hashed password
    const user = new User({ 
      username, 
      email, 
      password: hashedPassword,  // Store hashed version
      phonenumber 
    });
    await user.save();

    res.status(201).json({
      message: "User registered successfully",
      user: { _id: user._id, username, email }  // Don't send password back
    });
  } catch (error) {
    res.status(500).json({ message: "Registration error", error: error.message });
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
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

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

    // Create new user
    const user = new User({ username, email, password, phonenumber });
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

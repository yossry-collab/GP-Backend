const User = require("../Models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const axios = require("axios");
const nodemailer = require("nodemailer");
const {
  normalizeEmail,
  validateTrustedEmail,
} = require("../Services/emailValidationService");

const RESET_CODE_LENGTH = 6;
const RESET_CODE_TTL_MINUTES = 10;
const SMTP_TIMEOUT_MS = 15000;

const smtpTransporters = new Map();

const getSmtpConfigCandidates = () => {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpSecure =
    process.env.SMTP_SECURE === undefined
      ? smtpPort === 465
      : String(process.env.SMTP_SECURE).toLowerCase() === "true";

  if (!smtpUser || !smtpPass) {
    return [];
  }

  const candidates = [
    {
      user: smtpUser,
      pass: smtpPass,
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
    },
  ];

  if (smtpHost === "smtp.gmail.com") {
    if (smtpPort !== 587 || smtpSecure !== false) {
      candidates.push({
        user: smtpUser,
        pass: smtpPass,
        host: smtpHost,
        port: 587,
        secure: false,
      });
    }

    if (smtpPort !== 465 || smtpSecure !== true) {
      candidates.push({
        user: smtpUser,
        pass: smtpPass,
        host: smtpHost,
        port: 465,
        secure: true,
      });
    }
  }

  return candidates;
};

const getSmtpTransporter = (smtpConfig) => {
  const key = `${smtpConfig.host}:${smtpConfig.port}:${smtpConfig.secure}`;

  if (smtpTransporters.has(key)) {
    return smtpTransporters.get(key);
  }

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass,
    },
    pool: {
      maxConnections: 3,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  smtpTransporters.set(key, transporter);
  return transporter;
};

const toUserPayload = (user) => ({
  _id: user._id,
  username: user.username,
  email: user.email,
  phonenumber: user.phonenumber,
  profileImage: user.profileImage || "",
  role: user.role,
});

const issueTokenForUser = (user) => {
  return jwt.sign(
    { userId: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

const hashResetCode = (code) =>
  crypto.createHash("sha256").update(code).digest("hex");

const generateResetCode = () => {
  const min = 10 ** (RESET_CODE_LENGTH - 1);
  const max = 10 ** RESET_CODE_LENGTH - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
};

const buildPasswordResetEmail = (code) => ({
  subject: "GamePlug password reset code",
  text: `Your GamePlug password reset code is ${code}. This code expires in ${RESET_CODE_TTL_MINUTES} minutes.`,
  html: `
      <div style="font-family: Arial, sans-serif; background: #f3f5f8; padding: 24px; color: #1f2937;">
        <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 14px; padding: 28px; border: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 8px; font-size: 24px; color: #111827;">GamePlug Security</h2>
          <p style="margin: 0 0 18px; color: #4b5563; line-height: 1.5;">
            We received a request to reset your password. Use the verification code below to continue.
          </p>
          <div style="font-size: 34px; letter-spacing: 8px; font-weight: 700; text-align: center; color: #0f172a; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 12px; padding: 16px 10px; margin: 10px 0 20px;">
            ${code}
          </div>
          <p style="margin: 0 0 10px; color: #4b5563; line-height: 1.5;">
            This code expires in <strong>${RESET_CODE_TTL_MINUTES} minutes</strong>.
          </p>
          <p style="margin: 0; color: #6b7280; line-height: 1.5;">
            If you did not request this reset, you can safely ignore this email.
          </p>
        </div>
      </div>
    `,
});

const sendWithBrevo = async (email, code) => {
  const brevoApiKey = process.env.BREVO_API_KEY;
  const brevoFromEmail = process.env.BREVO_FROM_EMAIL;
  const brevoFromName = process.env.BREVO_FROM_NAME || "GamePlug Security";

  if (!brevoApiKey || !brevoFromEmail) {
    return { ok: false, skipped: true, reason: "BREVO_API_KEY/BREVO_FROM_EMAIL not set" };
  }

  try {
    const emailContent = buildPasswordResetEmail(code);

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          name: brevoFromName,
          email: brevoFromEmail,
        },
        to: [{ email }],
        subject: emailContent.subject,
        textContent: emailContent.text,
        htmlContent: emailContent.html,
      },
      {
        headers: {
          "api-key": brevoApiKey,
          "Content-Type": "application/json",
        },
        timeout: SMTP_TIMEOUT_MS,
      },
    );

    return { ok: true };
  } catch (error) {
    const brevoStatus = error.response?.status;
    const brevoPayload = error.response?.data;
    const brevoReason =
      brevoPayload?.message ||
      brevoPayload?.code ||
      error.message;
    console.warn("Brevo API unavailable, falling back to other mail providers:", {
      message: error.message,
      status: brevoStatus,
      response: brevoPayload,
    });
    return {
      ok: false,
      reason: `Brevo${brevoStatus ? ` ${brevoStatus}` : ""}${brevoReason ? `: ${brevoReason}` : ""}`,
    };
  }
};

const sendWithSmtp = async (email, code) => {
  const emailContent = buildPasswordResetEmail(code);
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const smtpConfigCandidates = getSmtpConfigCandidates();

  if (!smtpConfigCandidates.length || !fromEmail) {
    return { ok: false, skipped: true, reason: "SMTP transport not configured" };
  }

  const smtpErrors = [];

  for (const smtpConfig of smtpConfigCandidates) {
    const transporter = getSmtpTransporter(smtpConfig);

    try {
      await Promise.race([
        transporter.sendMail({
          from: `GamePlug Security <${fromEmail}>`,
          to: email,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("SMTP request timed out. Please check SMTP credentials and provider access."));
          }, SMTP_TIMEOUT_MS + 1000);
        }),
      ]);

      return { ok: true };
    } catch (error) {
      const details = `${smtpConfig.host}:${smtpConfig.port}/${smtpConfig.secure ? "ssl" : "tls"} - ${error.message}`;
      smtpErrors.push(details);
      console.warn("SMTP email unavailable, trying next SMTP option if available:", {
        details,
      });
    }
  }

  return { ok: false, reason: `SMTP: ${smtpErrors.join(" | ")}` };
};

const sendPasswordResetEmail = async (email, code) => {
  const providerErrors = [];

  const smtpResult = await sendWithSmtp(email, code);
  if (smtpResult.ok === true) {
    return;
  }
  if (!smtpResult.skipped && smtpResult.reason) {
    providerErrors.push(smtpResult.reason);
  }

  const emailContent = buildPasswordResetEmail(code);
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFromEmail =
    process.env.RESEND_FROM_EMAIL ||
    process.env.SMTP_FROM_EMAIL ||
    process.env.SMTP_USER;

  if (resendApiKey && resendFromEmail) {
    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: `GamePlug Security <${resendFromEmail}>`,
          to: [email],
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        },
        {
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: SMTP_TIMEOUT_MS,
        },
      );

      return;
    } catch (error) {
      const status = error.response?.status;
      const reason = error.response?.data?.message || error.message;
      providerErrors.push(`Resend${status ? ` ${status}` : ""}${reason ? `: ${reason}` : ""}`);
      console.warn("Resend API unavailable, falling back to other mail providers:", {
        message: error.message,
        status,
        response: error.response?.data,
      });
    }
  }

  const brevoResult = await sendWithBrevo(email, code);
  if (brevoResult.ok === true) {
    return;
  }
  if (!brevoResult.skipped && brevoResult.reason) {
    providerErrors.push(brevoResult.reason);
  }

  throw new Error(
    `Failed to send reset code using SMTP, Resend, or Brevo. ${providerErrors.length ? `Details: ${providerErrors.join(" | ")}` : "No provider was configured."}`,
  );
};

// REGISTER to Create new user with hashed password
exports.register = async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const phonenumber = String(req.body?.phonenumber || "").trim();
    const emailCheck = validateTrustedEmail(req.body?.email);
    const normalizedEmail = emailCheck.normalizedEmail;

    if (!username || !normalizedEmail || !password) {
      return res.status(400).json({ message: "Username, email, and password are required" });
    }

    if (!emailCheck.isValid) {
      return res.status(emailCheck.reason === "provider_not_allowed" ? 422 : 400).json({
        message: emailCheck.message,
      });
    }

    const [existingByEmail, existingByUsername, existingByPhone] = await Promise.all([
      User.findOne({ email: normalizedEmail }),
      User.findOne({ username }),
      phonenumber ? User.findOne({ phonenumber }) : Promise.resolve(null),
    ]);

    if (existingByEmail) {
      return res.status(400).json({ message: "Email is already in use" });
    }

    if (existingByUsername) {
      return res.status(400).json({ message: "Username is already taken" });
    }

    if (existingByPhone) {
      return res.status(400).json({ message: "Phone number is already in use" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      username,
      email: normalizedEmail,
      password: hashedPassword,
      phonenumber: phonenumber || undefined,
    });
    await user.save();

    const token = issueTokenForUser(user);

    res.status(201).json({
      message: "Registration successful",
      token,
      user: toUserPayload(user),
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

    if (error?.name === "ValidationError") {
      const firstError = Object.values(error.errors || {})[0];
      return res.status(422).json({
        message: firstError?.message || "Invalid user data",
        error: error.message,
      });
    }

    res.status(500).json({
      message: "Registration error",
      error: error.message,
    });
  }
};

// LOGIN - Verify credentials and return JWT token
exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

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
    const token = issueTokenForUser(user);

    res.status(200).json({
      message: "Login successful",
      token,
      user: toUserPayload(user)
    });
  } catch (error) {
    res.status(500).json({ message: "Login error", error: error.message });
  }
};

exports.requestPasswordResetCode = async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || "");
    if (!rawEmail.trim()) {
      return res.status(400).json({ message: "Email is required" });
    }

    const emailCheck = validateTrustedEmail(rawEmail);
    if (!emailCheck.isValid) {
      return res.status(emailCheck.reason === "provider_not_allowed" ? 422 : 400).json({
        message: emailCheck.message,
      });
    }

    const email = emailCheck.normalizedEmail;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: "No account is associated with this email.",
      });
    }

    const resetCode = generateResetCode();
    user.resetPasswordCodeHash = hashResetCode(resetCode);
    user.resetPasswordCodeExpiresAt = new Date(
      Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000,
    );
    await user.save();

    try {
      await sendPasswordResetEmail(email, resetCode);
    } catch (sendError) {
      user.resetPasswordCodeHash = null;
      user.resetPasswordCodeExpiresAt = null;
      await user.save();
      throw sendError;
    }

    res.status(200).json({
      message: "A reset code has been sent to your email.",
    });
  } catch (error) {
    const details = String(error.message || "");
    const timedOut = /timeout|timed out|ETIMEDOUT|ESOCKET/i.test(details);
    const responsePayload = {
      message: timedOut
        ? "Reset email service is temporarily unavailable. Please try again shortly."
        : "Failed to send reset code. Please try again later.",
    };

    if (process.env.NODE_ENV !== "production") {
      responsePayload.error = error.message;
    }

    res.status(503).json(responsePayload);
  }
};

exports.verifyPasswordResetCode = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();

    if (!email || !code) {
      return res.status(400).json({
        message: "Email and code are required",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: "Code must be 6 digits" });
    }

    const user = await User.findOne({ email });

    if (
      !user ||
      !user.resetPasswordCodeHash ||
      !user.resetPasswordCodeExpiresAt ||
      user.resetPasswordCodeExpiresAt.getTime() < Date.now()
    ) {
      return res.status(400).json({ message: "Code is invalid or expired" });
    }

    const incomingHash = hashResetCode(code);
    if (incomingHash !== user.resetPasswordCodeHash) {
      return res.status(400).json({ message: "Code is invalid or expired" });
    }

    res.status(200).json({ message: "Code verified successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to verify code",
      error: error.message,
    });
  }
};

exports.resetPasswordWithCode = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    const newPassword = String(req.body?.newPassword || "");

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        message: "Email, code, and new password are required",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: "Code must be 6 digits" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    const user = await User.findOne({ email });

    if (
      !user ||
      !user.resetPasswordCodeHash ||
      !user.resetPasswordCodeExpiresAt ||
      user.resetPasswordCodeExpiresAt.getTime() < Date.now()
    ) {
      return res.status(400).json({ message: "Code is invalid or expired" });
    }

    const incomingHash = hashResetCode(code);
    if (incomingHash !== user.resetPasswordCodeHash) {
      return res.status(400).json({ message: "Code is invalid or expired" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordCodeHash = null;
    user.resetPasswordCodeExpiresAt = null;
    await user.save();

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to reset password",
      error: error.message,
    });
  }
};

// CREATE - Add a new user
exports.createUser = async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const phonenumber = String(req.body?.phonenumber || "").trim();
    const emailCheck = validateTrustedEmail(req.body?.email);
    const normalizedEmail = emailCheck.normalizedEmail;

    // Validation
    if (!username || !normalizedEmail || !password || !phonenumber) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (!emailCheck.isValid) {
      return res.status(emailCheck.reason === "provider_not_allowed" ? 422 : 400).json({
        message: emailCheck.message,
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email: normalizedEmail }, { username }, { phonenumber }],
    });

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user (admin-created users are marked verified)
    const user = new User({
      username,
      email: normalizedEmail,
      password: hashedPassword,
      phonenumber,
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
    const normalizedEmail = email ? normalizeEmail(email) : "";

    // Check if at least one field is provided
    if (!username && !email && !phonenumber) {
      return res.status(400).json({
        message: "At least one field is required to update",
      });
    }

    // Build update object
    const updateData = {};
    if (username) updateData.username = username;
    if (email) {
      const emailCheck = validateTrustedEmail(normalizedEmail);
      if (!emailCheck.isValid) {
        return res.status(emailCheck.reason === "provider_not_allowed" ? 422 : 400).json({
          message: emailCheck.message,
        });
      }
      updateData.email = normalizedEmail;
    }
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
    const normalizedIncomingEmail = email ? normalizeEmail(email) : "";

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

    if (email) {
      const emailCheck = validateTrustedEmail(normalizedIncomingEmail);
      if (!emailCheck.isValid) {
        return res.status(emailCheck.reason === "provider_not_allowed" ? 422 : 400).json({
          message: emailCheck.message,
        });
      }
    }

    if (normalizedIncomingEmail && normalizedIncomingEmail !== normalizeEmail(user.email)) {
      const existing = await User.findOne({ email: normalizedIncomingEmail });
      if (existing) return res.status(400).json({ message: "Email already in use" });
      user.email = normalizedIncomingEmail;
    }
    if (phonenumber && phonenumber !== user.phonenumber) {
      const existing = await User.findOne({ phonenumber });
      if (existing) return res.status(400).json({ message: "Phone number already in use" });
      user.phonenumber = phonenumber;
    }

    await user.save();

    res.status(200).json({
      message: "Profile updated successfully",
      user: toUserPayload(user),
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating profile",
      error: error.message,
    });
  }
};

exports.uploadProfileImage = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!req.file) {
      return res.status(400).json({ message: "Profile image file is required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.profileImage = `/uploads/profiles/${req.file.filename}`;
    await user.save();

    res.status(200).json({
      message: "Profile image updated successfully",
      user: toUserPayload(user),
    });
  } catch (error) {
    res.status(500).json({
      message: "Error uploading profile image",
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

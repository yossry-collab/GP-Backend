const express = require("express");
const router = express.Router();
const {
  register,
  login,
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  updateProfile,
  deleteUser,
  banUser,
  unbanUser,
} = require("../Controller/userController");
const { verifyToken } = require("../Middleware/authMiddleware");

// PUBLIC routes (no authentication needed)
router.post("/register", register);
router.post("/login", login);

// PROTECTED routes (requires valid JWT token)
router.put("/profile", verifyToken, updateProfile);
router.get("/get", verifyToken, getAllUsers);
router.get("/get/:id", verifyToken, getUserById);
router.put("/update/:id", verifyToken, updateUser);
router.delete("/delete/:id", verifyToken, deleteUser);
router.post("/create", verifyToken, createUser); // Only authenticated users can create new users

// Ban / Unban routes (admin only)
router.put("/ban/:id", verifyToken, banUser);
router.put("/unban/:id", verifyToken, unbanUser);

module.exports = router;





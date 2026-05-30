const express = require("express");
const router = express.Router();
const chatbotController = require("../Controller/chatbotController");
const { verifyToken, verifyTokenOptional } = require("../Middleware/authMiddleware");

// Public routes (no authentication required)
router.post("/send", verifyTokenOptional, chatbotController.sendMessage);

// Protected routes (authentication required)
router.get("/conversations", verifyToken, chatbotController.getConversations);
router.get("/conversation/:conversationId", verifyToken, chatbotController.getConversation);
router.delete("/conversation/:conversationId", verifyToken, chatbotController.deleteConversation);
router.put("/conversation/:conversationId/clear", verifyToken, chatbotController.clearConversation);

module.exports = router;

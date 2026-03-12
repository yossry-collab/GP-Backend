const express = require("express");
const {
  getKnowledgeBase,
  getSupportContext,
  askSupportAssistant,
  createSupportTicket,
  getMySupportTickets,
  getSupportTicketById,
} = require("../Controller/supportController");
const { verifyToken } = require("../Middleware/authMiddleware");

const router = express.Router();

router.get("/knowledge", getKnowledgeBase);
router.get("/context", verifyToken, getSupportContext);
router.post("/assistant", verifyToken, askSupportAssistant);
router.post("/tickets", verifyToken, createSupportTicket);
router.get("/tickets", verifyToken, getMySupportTickets);
router.get("/tickets/:id", verifyToken, getSupportTicketById);

module.exports = router;
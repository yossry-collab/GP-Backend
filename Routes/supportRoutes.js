const express = require("express");
const {
  getKnowledgeBase,
  getSupportContext,
  createSupportTicket,
  getMySupportTickets,
  getSupportTicketById,
} = require("../Controller/supportController");
const { verifyToken } = require("../Middleware/authMiddleware");

const router = express.Router();

router.get("/knowledge", getKnowledgeBase);
router.get("/context", verifyToken, getSupportContext);
router.post("/tickets", verifyToken, createSupportTicket);
router.get("/tickets", verifyToken, getMySupportTickets);
router.get("/tickets/:id", verifyToken, getSupportTicketById);

module.exports = router;
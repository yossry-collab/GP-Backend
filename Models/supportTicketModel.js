const mongoose = require("mongoose");

const supportMessageSchema = new mongoose.Schema(
  {
    sender: {
      type: String,
      enum: ["customer", "ai", "agent"],
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["order", "payment", "refund", "account", "loyalty", "product", "technical", "other"],
      default: "other",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "waiting_on_customer", "resolved", "closed"],
      default: "open",
    },
    language: {
      type: String,
      enum: ["en", "fr"],
      default: "en",
    },
    source: {
      type: String,
      enum: ["chatwoot", "web", "email", "manual"],
      default: "chatwoot",
    },
    summary: {
      type: String,
      default: "",
      trim: true,
    },
    customerMessage: {
      type: String,
      required: true,
      trim: true,
    },
    aiSummary: {
      type: String,
      default: "",
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    messages: {
      type: [supportMessageSchema],
      default: [],
    },
  },
  { timestamps: true }
);

supportTicketSchema.index({ userId: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: 1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
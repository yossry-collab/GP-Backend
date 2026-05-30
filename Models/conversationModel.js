const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // Allow anonymous conversations
    },
    messages: [
      {
        role: {
          type: String,
          enum: ["user", "bot"],
          required: true,
        },
        content: {
          type: String,
          required: true,
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    title: {
      type: String,
      default: "New Conversation",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Auto-generate title from first user message if not set
conversationSchema.pre("save", async function (next) {
  if (this.isNew && this.messages.length > 0 && !this.title) {
    const firstUserMessage = this.messages.find((msg) => msg.role === "user");
    if (firstUserMessage) {
      this.title =
        firstUserMessage.content.substring(0, 50) +
        (firstUserMessage.content.length > 50 ? "..." : "");
    }
  }
  next();
});

module.exports = mongoose.model("Conversation", conversationSchema);

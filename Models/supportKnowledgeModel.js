const mongoose = require("mongoose");

const supportKnowledgeTranslationSchema = new mongoose.Schema(
  {
    locale: {
      type: String,
      enum: ["en", "fr"],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    answer: {
      type: String,
      required: true,
      trim: true,
    },
    summary: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

const supportKnowledgeSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    category: {
      type: String,
      enum: [
        "general",
        "orders",
        "payments",
        "refunds",
        "delivery",
        "loyalty",
        "account",
        "products",
      ],
      required: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    isPublished: {
      type: Boolean,
      default: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    translations: {
      type: [supportKnowledgeTranslationSchema],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: "At least one translation is required.",
      },
    },
  },
  { timestamps: true }
);

supportKnowledgeSchema.index({ category: 1, isPublished: 1, sortOrder: 1 });
supportKnowledgeSchema.index({ tags: 1 });

module.exports = mongoose.model("SupportKnowledge", supportKnowledgeSchema);
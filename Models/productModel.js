const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { 
      type: String, 
      required: true 
    },
    description: { 
      type: String, 
      required: false 
    },
    price: { 
      type: Number, 
      required: true 
    },
    category: { 
      type: String, 
      enum: ["game", "software", "gift-card"], 
      required: true 
    },
    subcategory: {
      type: String,
      default: null
    },
    image: { 
      type: String, 
      required: false 
    },
    stock: { 
      type: Number, 
      default: 0 
    },
    rating: { 
      type: String, 
      default: null
    },
    genre: {
      type: String,
      default: null
    },
    publisher: {
      type: String,
      default: null
    },
    releaseDate: {
      type: String,
      default: null
    },
    features: {
      type: [String],
      default: []
    },
    isDigital: {
      type: Boolean,
      default: true
    },
    discountPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    featured: {
      type: Boolean,
      default: false
    },
    reviews: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        comment: String,
        rating: Number,
        createdAt: { type: Date, default: Date.now }
      }
    ],
    createdBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User",
      required: false
    },
    cwProductId: {
      type: String,
      default: null,
      index: true
    },
    platform: {
      type: String,
      default: null
    },
    region: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);

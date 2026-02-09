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
    image: { 
      type: String, 
      required: false 
    },
    stock: { 
      type: Number, 
      default: 0 
    },
    rating: { 
      type: Number, 
      default: 0,
      min: 0,
      max: 5
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
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);

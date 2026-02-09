const Product = require("../Models/productModel");

// CREATE - Add new product
exports.createProduct = async (req, res) => {
  try {
    const { name, description, price, category, image, stock } = req.body;

    // Validate required fields
    if (!name || !price || !category) {
      return res.status(400).json({
        message: "Name, price, and category are required",
      });
    }

    // Validate category enum
    const validCategories = ["game", "software", "gift-card"];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        message: "Category must be one of: game, software, gift-card",
      });
    }

    // Validate price is positive
    if (price < 0) {
      return res.status(400).json({
        message: "Price must be a positive number",
      });
    }

    const product = new Product({
      name,
      description,
      price,
      category,
      image,
      stock: stock || 0,
      createdBy: req.user.userId,
    });

    await product.save();
    await product.populate("createdBy", "username email");

    res.status(201).json({
      message: "Product created successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error creating product",
      error: error.message,
    });
  }
};

// READ - Get all products with optional category filter
exports.getAllProducts = async (req, res) => {
  try {
    const { category, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const filter = {};
    if (category) {
      const validCategories = ["game", "software", "gift-card"];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          message: "Invalid category filter",
        });
      }
      filter.category = category;
    }

    const products = await Product.find(filter)
      .populate("createdBy", "username email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Product.countDocuments(filter);

    res.status(200).json({
      message: "Products retrieved successfully",
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      products,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching products",
      error: error.message,
    });
  }
};

// READ - Get product by ID
exports.getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id)
      .populate("createdBy", "username email")
      .populate("reviews.user", "username email");

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    res.status(200).json({
      message: "Product retrieved successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching product",
      error: error.message,
    });
  }
};

// UPDATE - Update product
exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, category, image, stock } = req.body;

    // Find product first
    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    // Validate category if provided
    if (category) {
      const validCategories = ["game", "software", "gift-card"];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          message: "Category must be one of: game, software, gift-card",
        });
      }
    }

    // Validate price if provided
    if (price !== undefined && price < 0) {
      return res.status(400).json({
        message: "Price must be a positive number",
      });
    }

    // Update fields
    if (name !== undefined) product.name = name;
    if (description !== undefined) product.description = description;
    if (price !== undefined) product.price = price;
    if (category !== undefined) product.category = category;
    if (image !== undefined) product.image = image;
    if (stock !== undefined) product.stock = stock;

    await product.save();
    await product.populate("createdBy", "username email");

    res.status(200).json({
      message: "Product updated successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error updating product",
      error: error.message,
    });
  }
};

// DELETE - Delete product
exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findByIdAndDelete(id);

    if (!product) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    res.status(200).json({
      message: "Product deleted successfully",
      product,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error deleting product",
      error: error.message,
    });
  }
};

// SEARCH - Search products by category and/or name
exports.searchProducts = async (req, res) => {
  try {
    const { category, name } = req.query;

    const filter = {};

    if (category) {
      const validCategories = ["game", "software", "gift-card"];
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          message: "Invalid category filter",
        });
      }
      filter.category = category;
    }

    if (name) {
      filter.name = { $regex: name, $options: "i" }; // Case-insensitive search
    }

    const products = await Product.find(filter)
      .populate("createdBy", "username email")
      .sort({ createdAt: -1 });

    res.status(200).json({
      message: "Products found successfully",
      count: products.length,
      products,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error searching products",
      error: error.message,
    });
  }
};

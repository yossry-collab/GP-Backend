const Product = require("../Models/productModel");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

// IMPORT - Import products from CSV file
exports.importProductsCSV = async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        message: "No file uploaded",
      });
    }

    const filePath = req.file.path;
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    // Parse CSV file
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        results.push(data);
      })
      .on("end", async () => {
        try {
          // Validate and insert products
          for (let i = 0; i < results.length; i++) {
            try {
              const row = results[i];

              // Validate required fields
              if (!row.name || !row.price || !row.category) {
                errorCount++;
                errors.push({
                  row: i + 2, // +2 because CSV includes header and 1-indexed
                  error: "Missing required fields (name, price, category)",
                });
                continue;
              }

              // Validate category
              const validCategories = ["game", "software", "gift-card"];
              if (!validCategories.includes(row.category)) {
                errorCount++;
                errors.push({
                  row: i + 2,
                  error: `Invalid category. Must be one of: ${validCategories.join(", ")}`,
                });
                continue;
              }

              // Validate price
              const price = parseFloat(row.price);
              if (isNaN(price) || price < 0) {
                errorCount++;
                errors.push({
                  row: i + 2,
                  error: "Price must be a valid positive number",
                });
                continue;
              }

              // Validate stock if provided
              let stock = 0;
              if (row.stock) {
                stock = parseInt(row.stock);
                if (isNaN(stock) || stock < 0) {
                  errorCount++;
                  errors.push({
                    row: i + 2,
                    error: "Stock must be a valid non-negative number",
                  });
                  continue;
                }
              }

              // Create product
              const product = new Product({
                name: row.name.trim(),
                description: row.description?.trim() || "",
                price,
                category: row.category.trim().toLowerCase(),
                image: row.image?.trim() || "",
                stock,
                createdBy: req.user.userId,
              });

              await product.save();
              successCount++;
            } catch (error) {
              errorCount++;
              errors.push({
                row: i + 2,
                error: error.message,
              });
            }
          }

          // Delete the uploaded file after processing
          fs.unlink(filePath, (err) => {
            if (err) console.error("Error deleting file:", err);
          });

          res.status(200).json({
            message: "CSV import completed",
            summary: {
              totalRows: results.length,
              successCount,
              errorCount,
            },
            errors: errors.length > 0 ? errors : [],
          });
        } catch (error) {
          // Delete file on error
          fs.unlink(filePath, (err) => {
            if (err) console.error("Error deleting file:", err);
          });

          res.status(500).json({
            message: "Error processing CSV",
            error: error.message,
          });
        }
      })
      .on("error", (error) => {
        // Delete file on error
        fs.unlink(filePath, (err) => {
          if (err) console.error("Error deleting file:", err);
        });

        res.status(500).json({
          message: "Error parsing CSV file",
          error: error.message,
        });
      });
  } catch (error) {
    // Clean up file if it exists
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("Error deleting file:", err);
      });
    }

    res.status(500).json({
      message: "Error importing products",
      error: error.message,
    });
  }
};

// SAMPLE CSV - Download sample CSV template
exports.downloadSampleCSV = async (req, res) => {
  try {
    const csvContent = `name,description,price,category,image,stock
Gaming Laptop,High-performance laptop for gaming,1299.99,game,image1.jpg,5
Photoshop 2024,Professional image editing software,699.99,software,image2.jpg,10
$50 Gift Card,Digital gift card,50.00,gift-card,image3.jpg,100`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=sample-products.csv",
    );
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({
      message: "Error generating sample CSV",
      error: error.message,
    });
  }
};

/**
 * CodesWholesale Sync Controller
 * 
 * Provides endpoints to:
 *  - Sync all products from CodesWholesale into local MongoDB
 *  - Browse CW products without syncing
 *  - Check CW account status
 */

const cwService = require("../Services/codesWholesaleService");
const Product = require("../Models/productModel");

/**
 * GET /api/cw/products
 * Browse all products from CodesWholesale (raw API response, no DB save)
 */
exports.browseProducts = async (req, res) => {
  try {
    const products = await cwService.getProducts();
    res.status(200).json({
      message: "CodesWholesale products fetched",
      count: Array.isArray(products) ? products.length : (products?.items?.length || 0),
      products,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching CodesWholesale products",
      error: error.message,
    });
  }
};

/**
 * GET /api/cw/products/:id
 * Get a single product from CodesWholesale with image and description
 */
exports.getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch product, image, and description in parallel
    const [product, image, description] = await Promise.all([
      cwService.getProductById(id),
      cwService.getProductImage(id),
      cwService.getProductDescription(id),
    ]);

    res.status(200).json({
      message: "Product details fetched",
      product,
      image,
      description,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching product details",
      error: error.message,
    });
  }
};

/**
 * POST /api/cw/sync
 * Sync all CodesWholesale products into local MongoDB database.
 * - Fetches all CW products
 * - Fetches images for each product
 * - Maps them to our product schema
 * - Upserts into MongoDB (creates new or updates existing)
 */
exports.syncProducts = async (req, res) => {
  try {
    const { clearExisting = false, limit = 0 } = req.body;

    console.log("🔄 Starting CodesWholesale product sync...");

    // 1. Fetch all products from CW
    const cwData = await cwService.getProducts();
    let cwProducts = Array.isArray(cwData) ? cwData : (cwData?.items || cwData?.products || []);

    console.log(`📦 Found ${cwProducts.length} products on CodesWholesale`);

    // Optionally limit for testing
    if (limit > 0) {
      cwProducts = cwProducts.slice(0, limit);
      console.log(`⚙️  Limited to ${cwProducts.length} products`);
    }

    // 2. Optionally clear existing products
    if (clearExisting) {
      await Product.deleteMany({});
      console.log("🗑️  Cleared existing products");
    }

    // 3. Process each product
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const errors = [];

    for (const cwProduct of cwProducts) {
      try {
        const productId = cwProduct.productId || cwProduct.id;

        if (!productId) {
          skippedCount++;
          continue;
        }

        // Map to local format (images resolved via Steam CDN / Unsplash fallback)
        const localProduct = cwService.mapToLocalProduct(cwProduct);

        // Skip products with 0 price (not actually available)
        if (localProduct.price <= 0) {
          skippedCount++;
          continue;
        }

        // Upsert: update if cwProductId exists, otherwise create new
        await Product.findOneAndUpdate(
          { cwProductId: productId },
          {
            $set: {
              name: localProduct.name,
              description: localProduct.description,
              price: localProduct.price,
              category: localProduct.category,
              image: localProduct.image,
              stock: localProduct.stock,
              cwProductId: productId,
              platform: localProduct.platform,
              region: localProduct.region,
            },
          },
          { upsert: true, new: true }
        );

        successCount++;
      } catch (error) {
        errorCount++;
        errors.push({
          product: cwProduct.name || "Unknown",
          error: error.message,
        });
      }
    }

    console.log(`   📊 Processed ${cwProducts.length} products`);

    // 4. Return summary
    const totalInDb = await Product.countDocuments();

    console.log(`\n✅ Sync complete!`);
    console.log(`   ✓ Synced: ${successCount}`);
    console.log(`   ✗ Errors: ${errorCount}`);
    console.log(`   ⊘ Skipped: ${skippedCount}`);
    console.log(`   📦 Total in DB: ${totalInDb}`);

    res.status(200).json({
      message: "CodesWholesale sync completed",
      summary: {
        totalFromCW: cwProducts.length,
        synced: successCount,
        errors: errorCount,
        skipped: skippedCount,
        totalInDatabase: totalInDb,
      },
      errors: errors.length > 0 ? errors : [],
    });
  } catch (error) {
    console.error("❌ Sync error:", error);
    res.status(500).json({
      message: "Error syncing CodesWholesale products",
      error: error.message,
    });
  }
};

/**
 * GET /api/cw/platforms
 * Fetch all available platforms from CW
 */
exports.getPlatforms = async (req, res) => {
  try {
    const platforms = await cwService.getPlatforms();
    res.status(200).json({ platforms });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching platforms",
      error: error.message,
    });
  }
};

/**
 * GET /api/cw/regions
 * Fetch all available regions from CW
 */
exports.getRegions = async (req, res) => {
  try {
    const regions = await cwService.getRegions();
    res.status(200).json({ regions });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching regions",
      error: error.message,
    });
  }
};

/**
 * GET /api/cw/account
 * Get CW account details (balance, credits, etc.)
 */
exports.getAccountDetails = async (req, res) => {
  try {
    const account = await cwService.getAccountDetails();
    res.status(200).json({ account });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching account details",
      error: error.message,
    });
  }
};

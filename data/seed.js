/**
 * Seed Script - Import products from CSV into MongoDB
 * 
 * Usage:
 *   1. Make sure your backend .env has MONGO_URI set
 *   2. Run: node data/seed.js
 * 
 * This will read ecommerce_products_fixed.csv and insert all products into your database.
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
require('dotenv').config();

const Product = require('../Models/productModel');

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gameplug';

// Map CSV category names to our model enum values
const categoryMap = {
    'Video Games': 'game',
    'Software': 'software',
    'Gift Cards': 'gift-card',
};

async function seed() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const products = [];
        const csvPath = path.join(__dirname, 'ecommerce_products_fixed.csv');

        if (!fs.existsSync(csvPath)) {
            console.error('❌ CSV file not found:', csvPath);
            return;
        }

        // Parse CSV
        await new Promise((resolve, reject) => {
            fs.createReadStream(csvPath)
                .pipe(csv())
                .on('data', (row) => {
                    const category = categoryMap[row.category?.trim()] || 'game';
                    const price = parseFloat(row.price) || 0;
                    const stock = parseInt(row.stock_quantity) || 0;
                    const discount = parseInt(row.discount_percentage) || 0;
                    const featured = row.featured?.trim()?.toUpperCase() === 'TRUE';
                    const isDigital = row.is_digital?.trim()?.toUpperCase() !== 'FALSE';

                    // Parse features string like "Open World, Exploration, Puzzle" into array
                    const features = row.features
                        ? row.features.split(',').map(f => f.trim()).filter(Boolean)
                        : [];

                    products.push({
                        name: row.product_name?.trim() || 'Unknown Product',
                        description: row.description?.trim() || '',
                        price,
                        category,
                        subcategory: row.subcategory?.trim() || null,
                        image: row.image_url?.trim() || '',
                        stock,
                        rating: row.rating?.trim() || null,
                        genre: row.genre?.trim() || null,
                        publisher: row.publisher?.trim() || null,
                        releaseDate: row.release_date?.trim() || null,
                        platform: row.platform?.trim() || null,
                        features,
                        isDigital,
                        discountPercentage: discount,
                        featured,
                    });
                })
                .on('end', resolve)
                .on('error', reject);
        });

        console.log(`📦 Parsed ${products.length} products from CSV`);

        // Clear existing products
        const existingCount = await Product.countDocuments();
        if (existingCount > 0) {
            console.log(`⚠️  Found ${existingCount} existing products. Clearing...`);
            await Product.deleteMany({});
            console.log('🗑️  Cleared existing products');
        }

        // Insert all products
        const result = await Product.insertMany(products);
        console.log(`✅ Successfully inserted ${result.length} products!`);

        // Summary
        const games = products.filter(p => p.category === 'game').length;
        const software = products.filter(p => p.category === 'software').length;
        const giftCards = products.filter(p => p.category === 'gift-card').length;
        const featuredCount = products.filter(p => p.featured).length;
        const withDiscount = products.filter(p => p.discountPercentage > 0).length;

        // Subcategory breakdown
        const subcategories = {};
        products.forEach(p => {
            const key = `${p.category} > ${p.subcategory || 'N/A'}`;
            subcategories[key] = (subcategories[key] || 0) + 1;
        });

        console.log('\n📊 Summary:');
        console.log(`   🎮 Games:        ${games}`);
        console.log(`   💻 Software:     ${software}`);
        console.log(`   🎁 Gift Cards:   ${giftCards}`);
        console.log(`   ⭐ Featured:     ${featuredCount}`);
        console.log(`   🏷️  With Discount: ${withDiscount}`);
        console.log(`   📦 Total:        ${products.length}`);
        console.log('\n📂 Subcategories:');
        Object.entries(subcategories).sort().forEach(([key, count]) => {
            console.log(`   ${key}: ${count}`);
        });

    } catch (error) {
        console.error('❌ Seed error:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');
    }
}

seed();

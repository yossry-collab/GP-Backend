/**
 * Seed Script - Import products from CSV into MongoDB
 * 
 * Usage:
 *   1. Make sure your backend .env has MONGODB_URI set
 *   2. Run: node data/seed.js
 * 
 * This will read products.csv and insert all products into your database.
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
require('dotenv').config();

const Product = require('../Models/productModel');

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gameverse';

async function seed() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const products = [];
        const csvPath = path.join(__dirname, 'products.csv');

        // Parse CSV
        await new Promise((resolve, reject) => {
            fs.createReadStream(csvPath)
                .pipe(csv())
                .on('data', (row) => {
                    products.push({
                        name: row.name.trim(),
                        description: row.description?.trim() || '',
                        price: parseFloat(row.price),
                        category: row.category.trim(),
                        image: row.image?.trim() || '',
                        stock: parseInt(row.stock) || 0,
                        rating: 0,
                    });
                })
                .on('end', resolve)
                .on('error', reject);
        });

        console.log(`📦 Parsed ${products.length} products from CSV`);

        // Ask before clearing
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

        console.log('\n📊 Summary:');
        console.log(`   🎮 Games:      ${games}`);
        console.log(`   💻 Software:   ${software}`);
        console.log(`   🎁 Gift Cards: ${giftCards}`);
        console.log(`   📦 Total:      ${products.length}`);

    } catch (error) {
        console.error('❌ Seed error:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');
    }
}

seed();

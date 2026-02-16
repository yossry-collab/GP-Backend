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

// ── Reliable fallback images for products whose original URLs are hotlink-blocked ──
const imageFallbacks = {
    // AAA Games
    'The Legend of Zelda: Tears of the Kingdom': 'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=600&h=400&fit=crop',
    'Elden Ring': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg',
    'God of War Ragnarök': 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=600&h=400&fit=crop',
    'Red Dead Redemption 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg',
    'Cyberpunk 2077': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
    'Spider-Man 2': 'https://images.unsplash.com/photo-1635514569146-9a9607ecf303?w=600&h=400&fit=crop',
    'Valorant': 'https://images.unsplash.com/photo-1542751110-97427bbecf20?w=600&h=400&fit=crop',
    'Minecraft': 'https://images.unsplash.com/photo-1587573089734-599849c614c6?w=600&h=400&fit=crop',
    'Super Mario Odyssey': 'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=600&h=400&fit=crop',
    'Mario Kart 8 Deluxe': 'https://images.unsplash.com/photo-1551103782-8ab07afd45c1?w=600&h=400&fit=crop',
    'Gran Turismo 7': 'https://images.unsplash.com/photo-1511882150382-421056c89033?w=600&h=400&fit=crop',
    'Dragon Quest XI S': 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=600&h=400&fit=crop',
    'Super Smash Bros. Ultimate': 'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8?w=600&h=400&fit=crop',
    'Grand Theft Auto V': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/271590/header.jpg',
    'Resident Evil 4 Remake': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2050650/header.jpg',
    'The Last of Us Part II Remastered': 'https://images.unsplash.com/photo-1552820728-8b83bb6b2b28?w=600&h=400&fit=crop',
    'Monster Hunter Rise': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1446780/header.jpg',
    'Overcooked! All You Can Eat': 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=600&h=400&fit=crop',
    'Baba Is You': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/736260/header.jpg',
    'Inside': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/304430/header.jpg',
    'Undertale': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/391540/header.jpg',
    // Software - Creative
    'Adobe Creative Cloud All Apps': 'https://images.unsplash.com/photo-1611532736597-de2d4265fba3?w=600&h=400&fit=crop',
    'Adobe Premiere Pro': 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=600&h=400&fit=crop',
    'Final Cut Pro': 'https://images.unsplash.com/photo-1536240478700-b869070f9279?w=600&h=400&fit=crop',
    'Logic Pro': 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=600&h=400&fit=crop',
    'Ableton Live 11 Suite': 'https://images.unsplash.com/photo-1598653222000-6b7b7a552625?w=600&h=400&fit=crop',
    'FL Studio Producer Edition': 'https://images.unsplash.com/photo-1563330232-57114bb0823c?w=600&h=400&fit=crop',
    'Camtasia': 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=600&h=400&fit=crop',
    // Software - Security
    'Malwarebytes Premium': 'https://images.unsplash.com/photo-1555949963-ff9fe0c870eb?w=600&h=400&fit=crop',
    'Norton 360 Deluxe': 'https://images.unsplash.com/photo-1563986768609-322da13575f2?w=600&h=400&fit=crop',
    'Bitdefender Total Security': 'https://images.unsplash.com/photo-1510511459019-5dda7724fd87?w=600&h=400&fit=crop',
    'Kaspersky Total Security': 'https://images.unsplash.com/photo-1614064641938-3bbee52942c7?w=600&h=400&fit=crop',
    'NordVPN - 1 Year': 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&h=400&fit=crop',
    'ExpressVPN - 1 Year': 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop',
    // Software - Utilities
    'CCleaner Professional': 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop',
    'WinRAR': 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=600&h=400&fit=crop',
    'Parallels Desktop': 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600&h=400&fit=crop',
    'VMware Workstation Pro': 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop',
    // Software - Productivity
    'Grammarly Premium': 'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=600&h=400&fit=crop',
    'Notion Personal Pro': 'https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?w=600&h=400&fit=crop',
    'Evernote Personal': 'https://images.unsplash.com/photo-1517842645767-c639042777db?w=600&h=400&fit=crop',
    'Todoist Premium': 'https://images.unsplash.com/photo-1507925921958-8a62f3d1a50d?w=600&h=400&fit=crop',
    '1Password Families': 'https://images.unsplash.com/photo-1633265486064-086b219458ec?w=600&h=400&fit=crop',
    'LastPass Premium': 'https://images.unsplash.com/photo-1614064641938-3bbee52942c7?w=600&h=400&fit=crop',
    // Software - Cloud
    'Dropbox Plus': 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&h=400&fit=crop',
    'Google One - 2TB': 'https://images.unsplash.com/photo-1535191042502-e6a9a3d407e7?w=600&h=400&fit=crop',
    'iCloud+ 2TB': 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&h=400&fit=crop',
    // Gift Cards - Gaming
    'PlayStation Store Gift Card $25': 'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=600&h=400&fit=crop',
    'PlayStation Store Gift Card $50': 'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=600&h=400&fit=crop',
    'PlayStation Store Gift Card $100': 'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=600&h=400&fit=crop',
    'Xbox Gift Card $25': 'https://images.unsplash.com/photo-1621259182978-fbf93132d53d?w=600&h=400&fit=crop',
    'Xbox Gift Card $50': 'https://images.unsplash.com/photo-1621259182978-fbf93132d53d?w=600&h=400&fit=crop',
    'Xbox Gift Card $100': 'https://images.unsplash.com/photo-1621259182978-fbf93132d53d?w=600&h=400&fit=crop',
    'Nintendo eShop Gift Card $20': 'https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?w=600&h=400&fit=crop',
    'Nintendo eShop Gift Card $50': 'https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?w=600&h=400&fit=crop',
    'Roblox Gift Card $25': 'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=600&h=400&fit=crop',
    'Minecraft: Minecoins Pack - 1720': 'https://images.unsplash.com/photo-1587573089734-599849c614c6?w=600&h=400&fit=crop',
    // Gift Cards - Entertainment
    'Netflix Gift Card $30': 'https://images.unsplash.com/photo-1574375927938-d5a98e8d7e28?w=600&h=400&fit=crop',
    'Netflix Gift Card $60': 'https://images.unsplash.com/photo-1574375927938-d5a98e8d7e28?w=600&h=400&fit=crop',
    'Disney+ Gift Subscription - 1 Year': 'https://images.unsplash.com/photo-1616530940355-351fabd9524b?w=600&h=400&fit=crop',
    // Gift Cards - Retail
    'Apple Gift Card $25': 'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=600&h=400&fit=crop',
    'Apple Gift Card $50': 'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=600&h=400&fit=crop',
    'Google Play Gift Card $25': 'https://images.unsplash.com/photo-1535191042502-e6a9a3d407e7?w=600&h=400&fit=crop',
    'Google Play Gift Card $50': 'https://images.unsplash.com/photo-1535191042502-e6a9a3d407e7?w=600&h=400&fit=crop',
    'Visa Prepaid Gift Card $100': 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=400&fit=crop',
    'Mastercard Prepaid Gift Card $50': 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=400&fit=crop',
    'Discord Nitro - 1 Year': 'https://images.unsplash.com/photo-1614680376593-902f74cf0d41?w=600&h=400&fit=crop',
};

async function seed() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const products = [];
        const csvPath = path.join(__dirname, 'ecommerce_products.csv');

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

                    const productName = row.product_name?.trim() || 'Unknown Product';
                    const originalImage = row.image_url?.trim() || '';
                    // Use fallback image if the original URL is from a hotlink-blocked domain
                    const image = imageFallbacks[productName] || originalImage;

                    products.push({
                        name: productName,
                        description: row.description?.trim() || '',
                        price,
                        category,
                        subcategory: row.subcategory?.trim() || null,
                        image,
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

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const User = require('../Models/userModel');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gameplug';

async function seedAdmin() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const adminEmail = 'admin@gameplug.com';
    const existing = await User.findOne({ email: adminEmail });

    if (existing) {
      console.log(`Admin account already exists: ${adminEmail}`);
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        await existing.save();
        console.log('Updated role to admin.');
      }
    } else {
      const hashedPassword = await bcrypt.hash('Admin123!', 10);
      const admin = new User({
        username: 'Admin',
        email: adminEmail,
        password: hashedPassword,
        role: 'admin',
        emailVerified: true,
      });
      await admin.save();
      console.log('✅ Default admin user created successfully!');
      console.log('   Email:    admin@gameplug.com');
      console.log('   Password: Admin123!');
    }
  } catch (err) {
    console.error('Error creating admin:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

seedAdmin();

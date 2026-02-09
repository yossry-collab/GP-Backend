# Render Deployment Guide

This backend is configured for free deployment on [Render](https://render.com).

## ✅ Prerequisites
- Render account (free signup at https://render.com)
- GitHub repository pushed (already done! ✓)
- MongoDB Atlas account with connection string

## 📋 Deployment Steps

### Step 1: Connect GitHub to Render
1. Go to https://render.com
2. Click **"New +"** → **"Web Service"**
3. Select **"Deploy an existing GitHub repository"**
4. Authorize Render to access your GitHub account
5. Select repository: `yossry-collab/GP-Backend`
6. Click **"Connect"**

### Step 2: Configure Service
1. **Name**: `gameplug-backend` (or your choice)
2. **Environment**: Node
3. **Region**: Choose closest to your users (default: Oregon)
4. **Plan**: Free (stays free forever)
5. **Build Command**: `npm install`
6. **Start Command**: `npm start`

### Step 3: Add Environment Variables
1. Scroll down to **"Environment"**
2. Click **"Add Environment Variable"**
3. Add these variables:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `5000` |
| `MONGO_URI` | Your MongoDB connection string (from MongoDB Atlas) |
| `JWT_SECRET` | Your JWT secret key (can use any long random string) |

### Step 4: Deploy
1. Click **"Create Web Service"**
2. Render will automatically build and deploy
3. Wait 2-3 minutes for build to complete
4. You'll get a URL like: `https://gameplug-backend.onrender.com`

## 📌 Important Notes

- **Free Tier**: Free instance will spin down after 15 minutes of inactivity
- **Cold Start**: First request after inactivity takes 30-50 seconds
- **MongoDB Atlas**: Must whitelist Render's IP in MongoDB Network Access (or allow all IPs)
- **Updates**: Push to GitHub → Render auto-deploys

## 🔗 Test Your API
Once deployed, test with:
```
https://gameplug-backend.onrender.com/
```

Should return: `"API running with MongoDB 🚀"`

## 📝 Environment Variables (.env.example)
Copy `.env.example` to `.env` for local development:
```bash
PORT=5000
MONGO_URI=mongodb+srv://...
JWT_SECRET=your_secret_key
NODE_ENV=development
```

## ❌ Troubleshooting

**Build fails?**
- Check `package.json` has all dependencies listed
- Verify Node 18+ is available

**Cannot connect to MongoDB?**
- Check MongoDB Atlas whitelist (allow all IPs or add Render's IP range)
- Verify MONGO_URI is correct in environment variables

**Port already in use locally?**
- Change `PORT` in `.env` to different value (e.g. 5001)

---

Your backend is ready to scale! 🚀

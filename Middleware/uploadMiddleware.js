const multer = require("multer");
const path = require("path");

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Save to uploads directory
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const originalName = file.originalname;
    const ext = path.extname(originalName);
    const basename = path.basename(originalName, ext);
    const uniqueName = `${basename}-${timestamp}${ext}`;
    cb(null, uniqueName);
  }
});

// File filter - Only accept CSV files
const fileFilter = (req, file, cb) => {
  if (file.mimetype === "text/csv" || path.extname(file.originalname).toLowerCase() === ".csv") {
    cb(null, true);
  } else {
    cb(new Error("Only CSV files are allowed"), false);
  }
};

// Create multer upload instance
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

module.exports = upload;

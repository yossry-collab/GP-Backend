const fs = require("fs");
const multer = require("multer");
const path = require("path");

const createStorage = (folderName) =>
  multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = path.join(__dirname, "..", "uploads", folderName);
      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const ext = path.extname(file.originalname).toLowerCase();
      const basename = path
        .basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9-_]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);

      cb(null, `${basename || "file"}-${timestamp}${ext}`);
    },
  });

const csvUpload = multer({
  storage: createStorage("csv"),
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      path.extname(file.originalname).toLowerCase() === ".csv"
    ) {
      cb(null, true);
      return;
    }

    cb(new Error("Only CSV files are allowed"), false);
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const avatarUpload = multer({
  storage: createStorage("profiles"),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }

    cb(new Error("Only image files are allowed"), false);
  },
  limits: {
    fileSize: 3 * 1024 * 1024,
  },
});

module.exports = {
  csvUpload,
  avatarUpload,
};

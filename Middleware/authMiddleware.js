const jwt = require("jsonwebtoken");

exports.verifyToken = (req, res, next) => {
  try {
    // Get token from header: "Bearer <token>"
    const token = req.headers.authorization?.split(" ")[1];
    
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;  // Store user info in request
    next();
  } catch (error) {
    res.status(403).json({ message: "Invalid token" });
  }
};
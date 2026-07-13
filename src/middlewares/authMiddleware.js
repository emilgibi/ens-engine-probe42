import jwt from 'jsonwebtoken';
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const SECRET_KEY = process.env.JWT_SECRET_KEY; // Ensure this is set in your environment variables
const JWT_ALGORITHM = "HS256";
const JWT_ISSUER = "my-app";

// Middleware to Verify JWT Token
export const getCurrentUser = async (req, res, next) => {
  try {
    // Extract Authorization header (case-insensitive for consistency)
    const authHeader = req.headers["authorization"];

    // Validate the presence and format of the Authorization header
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Invalid or missing token" });
    }

    // Extract the JWT token from the header
    const token = authHeader.split(" ")[1]; // Fixed splitting logic


    // Verify JWT token
    const decoded = jwt.verify(token, SECRET_KEY, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
    });


    // Attach decoded user info to the request object
    req.user = decoded;
    if (decoded.sub === 'orchestration' && decoded.ugr === 'analysis')
    {
      // Proceed to the next middleware or route handler
      next();
    }
    else{
      return res.status(401).json({ error: "Unauthorized" });
    }
  } catch (error) {
    console.error("JWT Verification Error:", error);
    return res.status(401).json({ error: "Token invalid or expired" });
  }
};

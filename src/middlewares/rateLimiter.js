import Bottleneck from 'bottleneck';

// Configure Bottleneck for rate limiting
const limiter = new Bottleneck({
  maxConcurrent: 5, // Allow up to 5 parallel requests
  minTime: 500, // At least 500ms between each request (120 requests per minute) - 60,000ms / 120 = 500ms
  reservoir: 120, // Maximum of 120 requests per minute
  reservoirRefreshAmount: 120, // Refill 120 requests per minute
  reservoirRefreshInterval: 60 * 1000, // Refresh reservoir every 1 minute
});
// Middleware to apply rate limiting
export const rateLimitMiddleware = (req, res, next) => {
  limiter
    .schedule(() => Promise.resolve()) // Schedule an empty task to enforce limits
    .then(() => next()) // Proceed to the next middleware/route handler
    .catch(() => res.status(429).json({ error: 'Too many requests' }));
};

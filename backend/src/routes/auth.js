const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  register,
  login,
  logout,
  getProfile,
  updateProfile,
  changePassword,
} = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");
const { validateRequest } = require("../middleware/validation");
const {
  registerValidation,
  loginValidation,
  updateProfileValidation,
  changePasswordValidation,
} = require("../utils/validations");

const router = express.Router();

// Only throttle the public credential endpoints. Authenticated endpoints such as
// /profile are called on every page load and must NOT be throttled, otherwise a
// normal user session can be unexpectedly logged out with a 429 response.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // multiple attempts allowed for a smoother UX
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many authentication attempts, please try again later.",
  },
});

// Public routes
router.post(
  "/register",
  authLimiter,
  registerValidation,
  validateRequest,
  register
);
router.post("/login", authLimiter, loginValidation, validateRequest, login);

// Protected routes
router.use(authenticate); // All routes below require authentication

router.get("/logout", logout);
router.get("/profile", getProfile);
router.put("/profile", updateProfileValidation, validateRequest, updateProfile);
router.put(
  "/change-password",
  changePasswordValidation,
  validateRequest,
  changePassword
);

module.exports = router;

const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  register,
  registerDemoV2,
  login,
  logout,
  getProfile,
  updateProfile,
  changePassword,
} = require("../controllers/authController");
const { authenticate, checkBusinessAccess } = require("../middleware/auth");
const { body, validationResult } = require('express-validator');
const { validateRequest } = require("../middleware/validation");
const {
  registerValidation,
  registrationIdentityValidation,
  loginValidation,
  updateProfileValidation,
  changePasswordValidation,
} = require("../utils/validations");

const router = express.Router();

const demoEnabled = (req, res, next) => process.env.DEMO_V2_REGISTRATION_ENABLED === 'true'
  ? next() : res.status(404).json({ success: false, message: 'Not found' });
const demoBody = (req, res, next) => {
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object'
      || Object.keys(req.body).some(key => !['name', 'email', 'password'].includes(key))) {
    return res.status(400).json({ success: false, message: 'Invalid demo registration request.' });
  }
  next();
};
// Reuse normal identity/password rules, but do not echo credential values.
const demoValidation = registrationIdentityValidation;
const demoTypes = ['name', 'email', 'password'].map(field => body(field).isString().bail());
const demoPasswordLimit = body('password').custom(value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72);
const safeDemoValidation = (req, res, next) => validationResult(req).isEmpty()
  ? next() : res.status(400).json({ success: false, message: 'Invalid name, email or password.' });

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
router.post('/register-demo-v2', demoEnabled, authLimiter, authenticate, checkBusinessAccess,
  demoBody, demoTypes, demoValidation, demoPasswordLimit, safeDemoValidation, registerDemoV2);

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

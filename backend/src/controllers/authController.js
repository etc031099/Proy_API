const { User } = require('../models');
const { generateAuthTokens } = require('../utils/jwt');
const { asyncHandler } = require('../middleware/validation');

const isDuplicateField = (error, field, indexName) => error?.code === 11000 && (
  error?.index === indexName
  || error?.keyPattern?.[field] === 1
  || Object.prototype.hasOwnProperty.call(error?.keyValue || {}, field)
);

/**
 * @desc    Register new user
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  // Normalize input. Emails are case-insensitive, so always store/compare them
  // in lowercase to avoid duplicated accounts such as "User@x.com" vs "user@x.com".
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password;
  const businessId = (req.body.businessId || '').trim();

  // Check if a user with this email already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(409).json({
      success: false,
      code: 'EMAIL_EXISTS',
      message: 'An account with this email already exists. Please sign in instead.'
    });
  }

  // Every registration must create its own isolated system. Reject a Business ID
  // that is already in use so two unrelated accounts never end up sharing data.
  const existingBusiness = await User.findOne({ businessId });
  if (existingBusiness) {
    return res.status(409).json({
      success: false,
      code: 'BUSINESS_EXISTS',
      message: 'This Business ID is already in use. Please choose a different one.'
    });
  }

  // Unique email and businessId indexes are the final guards against races
  // between simultaneous registration requests.
  let user;
  try {
    user = await User.create({
      name,
      email,
      password,
      businessId
    });
  } catch (error) {
    const isEmail = isDuplicateField(error, 'email', 'email_1');
    const isBusiness = isDuplicateField(error, 'businessId', 'businessId_1');
    if (isEmail || isBusiness) {
      return res.status(409).json({
        success: false,
        code: isEmail ? 'EMAIL_EXISTS' : 'BUSINESS_EXISTS',
        message: isEmail
          ? 'An account with this email already exists. Please sign in instead.'
          : 'This Business ID is already in use. Please choose a different one.'
      });
    }
    throw error;
  }

  // Generate tokens
  const tokens = generateAuthTokens(user);

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        businessId: user.businessId,
        role: user.role
      },
      ...tokens
    }
  });
});

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  // Normalize the email the same way it is stored (lowercase, trimmed).
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password;

  // Check if user exists and include password for comparison
  const user = await User.findOne({ email }).select('+password');

  if (!user) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password'
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_DISABLED',
      message: 'This account has been disabled. Please contact support.'
    });
  }

  // Check password
  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password'
    });
  }

  // Generate tokens
  const tokens = generateAuthTokens(user);

  res.json({
    success: true,
    message: 'Login successful',
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        businessId: user.businessId,
        role: user.role
      },
      ...tokens
    }
  });
});

/**
 * @desc    Logout user
 * @route   GET /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  // Note: In a more sophisticated setup, you might want to 
  // maintain a blacklist of tokens or use refresh tokens
  res.json({
    success: true,
    message: 'Logout successful'
  });
});

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/profile
 * @access  Private
 */
const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  res.json({
    success: true,
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        businessId: user.businessId,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    }
  });
});

/**
 * @desc    Update user profile
 * @route   PUT /api/auth/profile
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name } = req.body;
  
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { name },
    { new: true, runValidators: true }
  );

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  res.json({
    success: true,
    message: 'Profile updated successfully',
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        businessId: user.businessId,
        role: user.role
      }
    }
  });
});

/**
 * @desc    Change password
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  // Get user with password
  const user = await User.findById(req.user.id).select('+password');
  
  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  // Check current password
  const isCurrentPasswordValid = await user.comparePassword(currentPassword);
  if (!isCurrentPasswordValid) {
    return res.status(400).json({
      success: false,
      message: 'Current password is incorrect'
    });
  }

  // Update password
  user.password = newPassword;
  await user.save();

  res.json({
    success: true,
    message: 'Password changed successfully'
  });
});

module.exports = {
  register,
  login,
  logout,
  getProfile,
  updateProfile,
  changePassword
};

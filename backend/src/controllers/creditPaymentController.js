const mongoose = require('mongoose');
const { Contact, CreditPayment } = require('../models');
const { asyncHandler } = require('../middleware/validation');

const getCustomer = (id, businessId, session) => Contact.findOne({
  _id: id,
  businessId,
  type: 'customer',
  isActive: true
}).session(session);

const createCreditPayment = asyncHandler(async (req, res) => {
  const { customerId, amount, currency = 'PEN', paymentMethod, notes } = req.body;
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const customer = await getCustomer(customerId, req.businessId, session);
    if (!customer) {
      throw Object.assign(new Error('Customer not found'), { statusCode: 404 });
    }
    const paymentAmount = Number(amount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      throw Object.assign(new Error('Payment amount must be greater than zero'), { statusCode: 400 });
    }
    if (!['PEN', 'USD', 'EUR'].includes(currency)) {
      throw Object.assign(new Error('Currency must be PEN, USD, or EUR'), { statusCode: 400 });
    }
    const currencyBalance = Number(
      customer.balancesByCurrency?.[currency]
      || (currency === 'PEN' ? customer.currentBalance : 0)
    );
    if (paymentAmount > currencyBalance) {
      throw Object.assign(new Error('Payment cannot exceed the customer balance'), { statusCode: 400 });
    }
    const [payment] = await CreditPayment.create([{
      customerId,
      businessId: req.businessId,
      amount: paymentAmount,
      currency,
      paymentMethod,
      notes
    }], { session });
    customer.balancesByCurrency[currency] = Math.max(0, currencyBalance - paymentAmount);
    if (currency === 'PEN') customer.currentBalance = customer.balancesByCurrency.PEN;
    await customer.save({ session });
    await session.commitTransaction();
    res.status(201).json({ success: true, message: 'Payment recorded successfully', data: { payment, customer } });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
});

const getCustomerCreditPayments = asyncHandler(async (req, res) => {
  const customer = await Contact.findOne({
    _id: req.params.customerId,
    businessId: req.businessId,
    type: 'customer',
    isActive: true
  });
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
  const payments = await CreditPayment.find({
    customerId: customer._id,
    businessId: req.businessId
  }).sort({ date: -1 });
  res.json({ success: true, data: { payments, balance: customer.currentBalance, balancesByCurrency: customer.balancesByCurrency } });
});

module.exports = { createCreditPayment, getCustomerCreditPayments };

const mongoose = require('mongoose');

const connectionOptions = () => {
  const options = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10
  };

  if (process.env.MONGODB_REPLICA_SET) {
    options.replicaSet = process.env.MONGODB_REPLICA_SET;
  }

  return options;
};

let shutdownHandlersRegistered = false;

const registerShutdownHandlers = () => {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const shutdown = async (signal) => {
    try {
      await mongoose.connection.close();
      console.log(`MongoDB connection closed after ${signal}`);
      process.exit(0);
    } catch (error) {
      console.error('Error during database disconnection:', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
};

const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is required');
    }

    const conn = await mongoose.connect(process.env.MONGODB_URI, connectionOptions());
    const hello = await conn.connection.db.admin().command({ hello: 1 });

    if (!hello.setName || !hello.isWritablePrimary) {
      throw new Error('MongoDB must be connected to a replica set with a writable PRIMARY');
    }

    if (
      process.env.MONGODB_REPLICA_SET
      && hello.setName !== process.env.MONGODB_REPLICA_SET
    ) {
      throw new Error(
        `Connected replica set ${hello.setName} does not match ${process.env.MONGODB_REPLICA_SET}`
      );
    }

    console.log(
      `MongoDB Connected: ${conn.connection.host}`
      + (hello.setName ? ` (replica set ${hello.setName})` : '')
    );
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('MongoDB reconnected');
    });

    registerShutdownHandlers();
    return conn;

  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

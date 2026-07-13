import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const config = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
  ssl: true,
};

// --- Create Pool for general queries ---
const pool = new Pool(config);

// Handle pool events
pool.on('connect', () => {
  console.log('Connection pool established with the database');
});

pool.on('error', (err) => {
  console.error('Connection pool error:', err);
});

// Export pool for use in queries
export default pool;

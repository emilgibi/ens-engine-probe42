import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from './config/db.js';
import swaggerJsDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import internalRoutes from './routes/internalRoutes.js';
import orbisRoutes from './routes/orbisRouter.js';
import errorHandling from './middlewares/errorHandler.js';
import createOrgTable from './data/createOrgTable.js';
import { globSync } from 'glob';

dotenv.config();

const app = express();
const port = process.env.ENGINE_PORT || 3002;

// Middlewares
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Routes
app.use('/api/v1/internal', internalRoutes);
app.use('/api/v1/orbis', orbisRoutes);

let pasth = globSync('./routes/*.js', { absolute: true });
let routes_path = process.cwd() + '\\src\\routes\\*.js';
let docs_path = process.cwd() + '\\src\\docs\\*.js';

// Swagger setup
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ENS-ORBIS-ENGINE API',
      version: '1.0.0',
      description: 'API documentation for ENS-ORBIS-ENGINE app',
    },
    servers: [
      {
        url: `http://localhost:${port}`, // Server URL
      },
    ],
  },
  apis: [routes_path, docs_path],
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Error handling middleware
app.use(errorHandling);

// Create table before starting server
createOrgTable();

// Testing POSTGRES Connection
app.get('/', async (req, res) => {
  console.log('Start');
  const result = await pool.query('SELECT current_database()');
  res.send(`The database name is : ${result.rows[0].current_database}`);
});

// Server running
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

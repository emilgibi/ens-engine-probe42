import express from 'express';
import {
  insertInternalOrgData,
  reportGenerationNode,
} from '../controllers/internalController.js';
import { validateOrg } from '../middlewares/inputValidator.js';
import { getCurrentUser } from '../middlewares/authMiddleware.js';
const router = express.Router();

// Report Generation with Node.js
router.post('/report-generation-node', reportGenerationNode);

export default router;

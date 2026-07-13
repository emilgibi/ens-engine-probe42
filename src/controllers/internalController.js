import { insertInternalOrgDataService } from '../services/internalOrgModel.js';
import { generateReport } from '../utils/generateReports.js';
import { handleResponse } from '../utils/helpers.js';

export const insertInternalOrgData = async (req, res, next) => {
  const { orgName, orgIdentifier } = req.body;

  try {
    const orgData = await insertInternalOrgDataService(orgName, orgIdentifier);
    return handleResponse(res, 201, 'Org created successfully', orgData);
  } catch (err) {
    next(err);
  }
};

export const reportGenerationNode = async (req, res, next) => {
  try {
    await generateReport(req.body);

    return handleResponse(res, 200, {
      message: 'Report generated successfully',
    });
  } catch (err) {
    next(err);
  }
};

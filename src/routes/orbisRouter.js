import express from 'express';
import {
    getCompanybyName,
    getEmployeeSanctionsScreening,
    getProbe42CompanyData,
    getProbe42CompanyFullData,
    getSanctionsScreening,
    getMsmeStatus,
    searchProbe42CompaniesByName
} from '../controllers/orbisController.js';
import {
    getAddressImages,
    getPlaceDetails,
    getPoiDensity
} from '../controllers/mapController.js';
import {
    getCyberRisk
} from '../controllers/cyberController.js';
import {
    validateInstaFinancialPAN,
    validateInstaFinancialName,
    validateSanctionsScreening,
    validateAddressImageQuery,
    validateRatingQuery,
    validateCyberRisk,
    validateSanctionsEmployeeScreening,
    validateMSMEValidation,
    validateCompanyFullData,
    validateProbe42NameSearch
} from '../middlewares/inputValidator.js';
import { rateLimitMiddleware } from '../middlewares/rateLimiter.js';
import { getCurrentUser } from '../middlewares/authMiddleware.js';

const router = express.Router();
// For identifying company by name via Insta Financials (run-validation)
router.get('/instaFinancial/getCompanybyName', validateInstaFinancialName, getCompanybyName)

// For listing Probe42 company and LLP matches by name (procurevision)
router.get('/probe42/nameSearch', validateProbe42NameSearch, searchProbe42CompaniesByName)

// For getting Insta Financial Information (triger-analysis)
router.get('/instaFinancial/getCompanyData', validateInstaFinancialPAN, getProbe42CompanyData)

router.get(
    '/sanctions/screen',getCurrentUser, validateSanctionsScreening, rateLimitMiddleware, getSanctionsScreening,
); // In-use (trigger-analysis)

router.post(
    '/sanctions-employee/screen',getCurrentUser, validateSanctionsEmployeeScreening, rateLimitMiddleware, getEmployeeSanctionsScreening,
); // In-use (trigger-analysis)

// For getting Google Images
router.get("/location/images", validateAddressImageQuery, rateLimitMiddleware, getAddressImages);

// For getting Google Rating
router.get("/location/rating", validateRatingQuery, rateLimitMiddleware, getPlaceDetails);

// For getting Google location category
router.get("/location/category", validateRatingQuery, rateLimitMiddleware, getPoiDensity);

router.get('/cyber', getCurrentUser, validateCyberRisk, rateLimitMiddleware, getCyberRisk);

router.get('/msme', getCurrentUser, validateMSMEValidation, rateLimitMiddleware, getMsmeStatus);

// For getting full Probe42 company information (procurevision)
router.get('/instaFinancial/getCompanyFullData', validateCompanyFullData, getProbe42CompanyFullData)

export default router;

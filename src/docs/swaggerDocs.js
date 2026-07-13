/**
 * @swagger
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */
/**
 * @swagger
 * /api/v1/orbis/match/companies:
 *   get:
 *     summary: Retrieve company match information from the Orbis API
 *     description: Fetches exact or potential matches for a company based on the provided name and country.
 *     tags:
 *       - Orbis
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: orgName
 *         schema:
 *           type: string
 *         required: true
 *         description: Name of the organization to match.
 *       - in: query
 *         name: orgCountry
 *         schema:
 *           type: string
 *         required: true
 *         description: Country of the organization to match.
 *     responses:
 *       200:
 *         description: Successfully retrieved company match data.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bvdid:
 *                   type: string
 *                 name:
 *                   type: string
 *                 name_international:
 *                   type: string
 *                 address:
 *                   type: string
 *                 postcode:
 *                   type: string
 *                 city:
 *                   type: string
 *                 country:
 *                   type: string
 *                 phone_or_fax:
 *                   type: string
 *                 email_or_website:
 *                   type: string
 *                 national_id:
 *                   type: string
 *                 state:
 *                   type: string
 *                 address_type:
 *                   type: string
 *                 ens_id:
 *                   type: string
 *       400:
 *         description: Invalid or missing query parameters.
 *       404:
 *         description: No valid match found.
 *       500:
 *         description: Internal server error.
 */

/**
 * @swagger
 * /api/v1/orbis/truesight/companies:
 *   get:
 *     summary: Retrieve company match information from the Orbis API
 *     description: Fetches exact or potential matches for a company based on the provided name and country.
 *     tags:
 *       - Orbis
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: orgName
 *         schema:
 *           type: string
 *         required: true
 *         description: Name of the organization to match.
 *       - in: query
 *         name: orgCountry
 *         schema:
 *           type: string
 *         required: true
 *         description: Country of the organization to match.
 *       - in: query
 *         name: ensId
 *         schema:
 *           type: string
 *         required: true
 *         description: Ens Id.
 *       - in: query
 *         name: sessionId
 *         schema:
 *           type: string
 *         required: true
 *         description: Session Id.
 *       - in: query
 *         name: nationalId
 *         schema:
 *           type: string
 *         required: true
 *         description: National Id.
 *     responses:
 *       200:
 *         description: Successfully retrieved company match data.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bvdid:
 *                   type: string
 *                 name:
 *                   type: string
 *                 name_international:
 *                   type: string
 *                 address:
 *                   type: string
 *                 postcode:
 *                   type: string
 *                 city:
 *                   type: string
 *                 country:
 *                   type: string
 *                 phone_or_fax:
 *                   type: string
 *                 email_or_website:
 *                   type: string
 *                 national_id:
 *                   type: string
 *                 state:
 *                   type: string
 *                 address_type:
 *                   type: string
 *                 ens_id:
 *                   type: string
 *       400:
 *         description: Invalid or missing query parameters.
 *       404:
 *         description: No valid match found.
 *       500:
 *         description: Internal server error.
 */


/**
 * @swagger
 * /api/v1/orbis/companies:
 *   get:
 *     summary: Retrieve company match information from the Orbis API
 *     description: Fetches exact or potential matches for a company based on the provided name and country.
 *     tags:
 *       - Orbis
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: bvdId
 *         schema:
 *           type: string
 *         required: true
 *         description: BVD id.
 *       - in: query
 *         name: ensId
 *         schema:
 *           type: string
 *         required: true
 *         description: Ens Id.
 *       - in: query
 *         name: sessionId
 *         schema:
 *           type: string
 *         required: true
 *         description: Session Id.
 *     responses:
 *       200:
 *         description: Successfully retrieved company match data.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bvdid:
 *                   type: string
 *                 name:
 *                   type: string
 *                 name_international:
 *                   type: string
 *                 address:
 *                   type: string
 *                 postcode:
 *                   type: string
 *                 city:
 *                   type: string
 *                 country:
 *                   type: string
 *                 phone_or_fax:
 *                   type: string
 *                 email_or_website:
 *                   type: string
 *                 national_id:
 *                   type: string
 *                 state:
 *                   type: string
 *                 address_type:
 *                   type: string
 *                 ens_id:
 *                   type: string
 *       400:
 *         description: Invalid or missing query parameters.
 *       404:
 *         description: No valid match found.
 *       500:
 *         description: Internal server error.
 */

/**
 * @swagger
 * /api/v1/orbis/grid/companies:
 *   get:
 *     summary: Retrieve company match information from the Orbis API
 *     description: Fetches exact or potential matches for a company based on the provided name and country.
 *     tags:
 *       - Orbis
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: orgName
 *         schema:
 *           type: string
 *         required: true
 *         description: The name of the organization (e.g., Apple).
 *       - in: query
 *         name: sessionId
 *         schema:
 *           type: string
 *         required: true
 *         description: The session identifier (e.g., heya).
 *       - in: query
 *         name: ensId
 *         schema:
 *           type: string
 *         required: true
 *         description: The ENS identifier (e.g., hello).
 *       - in: query
 *         name: city
 *         schema:
 *           type: string
 *         required: true
 *         description: The city (e.g., Bangalore).
 *       - in: query
 *         name: bvdId
 *         schema:
 *           type: string
 *         required: true
 *         description: The BVD ID (e.g., IN54678).
 *       - in: query
 *         name: country
 *         schema:
 *           type: string
 *         required: true
 *         description: The country (e.g., India).
 *     responses:
 *       200:
 *         description: Successfully retrieved company match data.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bvdid:
 *                   type: string
 *                 name:
 *                   type: string
 *                 name_international:
 *                   type: string
 *                 address:
 *                   type: string
 *                 postcode:
 *                   type: string
 *                 city:
 *                   type: string
 *                 country:
 *                   type: string
 *                 phone_or_fax:
 *                   type: string
 *                 email_or_website:
 *                   type: string
 *                 national_id:
 *                   type: string
 *                 state:
 *                   type: string
 *                 address_type:
 *                   type: string
 *                 ens_id:
 *                   type: string
 *       400:
 *         description: Invalid or missing query parameters.
 *       404:
 *         description: No valid match found.
 *       500:
 *         description: Internal server error.
 * */
import pool from '../config/db.js';

export const insertInternalOrgDataService = async (orgName, orgIdentifier) => {
  const result = await pool.query(
    'INSERT INTO orgData (orgName, orgIdentifier) VALUES ($1, $2) RETURNING *',
    [orgName, orgIdentifier],
  );
  return result.rows[0];
};

export const updateInternalOrgDataService = async (orgIdentifier, bvdID) => {
  const result = await pool.query(
    'UPDATE orgData SET BvDIds = $1 WHERE orgIdentifier = $2 RETURNING *',
    [bvdID, orgIdentifier],
  );

  return result.rows[0];
};

import pool from '../config/db.js';

/**
 * Inserts data into the specified table.
 * @param {string} tableName - Name of the table
 * @param {Object} data - Key-value pairs of column names and values
 * @returns {Promise<number|null>} - Returns inserted row ID or null on failure
 */
export async function updatedinsertTable(tableName, data, ens_id, session_id) {
  if (
    !tableName ||
    typeof data !== 'object' ||
    Object.keys(data).length === 0
  ) {
    throw new Error('Invalid table name or data');
  }

  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const query = `INSERT INTO ${tableName} (${columns.join(', ')}) 
        VALUES (${placeholders}) 
        ON CONFLICT (ens_id, session_id) 
        DO UPDATE SET ${columns
          .map((col) => `${col} = EXCLUDED.${col}`)
          .join(', ')}
        RETURNING *`;

  try {
    const result = await pool.query(query, values);
    if (result.rows) {
      console.log('Successfully inserted data');
    } else {
      console.log('Failed to insert data.');
    }
    return result.rows || [];
  } catch (error) {
    console.error('Error inserting data:', error);
    return null;
  }
}

export async function upsertTableByIdentifier(tableName, data, identifier) {
  if (
    !tableName ||
    typeof data !== 'object' ||
    Object.keys(data).length === 0 ||
    !identifier
  ) {
    throw new Error('Invalid table name, data, or identifier');
  }

  data.identifier = identifier;

  Object.keys(data).forEach((key) => {
    if (data[key] === undefined) {
      data[key] = null;
    }
  });

  const columns = Object.keys(data);
  const values = Object.values(data).map((value) => {
    if (value !== null && typeof value === 'object') {
      return JSON.stringify(value);
    }
    return value;
  });
  const updateColumns = columns.filter((col) => col !== 'identifier');
  const updateValues = updateColumns.map((col) => values[columns.indexOf(col)]);
  const updateClause = updateColumns
    .map((col, index) => `${col} = $${index + 1}`)
    .join(', ');

  const updateQuery = `
    UPDATE ${tableName}
    SET ${updateClause}
    WHERE identifier = $${updateValues.length + 1}
    RETURNING *;
  `;

  try {
    const updateResult = await pool.query(updateQuery, [...updateValues, identifier]);
    if (updateResult.rowCount > 0) {
      return {
        success: true,
        message: 'Record updated successfully',
        data: updateResult.rows,
      };
    }

    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const insertQuery = `
      INSERT INTO ${tableName} (${columns.join(', ')})
      VALUES (${placeholders})
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, values);
    return {
      success: true,
      message: 'Record inserted successfully',
      data: result.rows,
    };
  } catch (error) {
    console.error('Error upserting data by identifier:', error);
    throw error;
  }
}

export async function updateTable(tableName, data, ens_id, session_id) {
  if (
    !tableName ||
    typeof data !== 'object' ||
    Object.keys(data).length === 0
  ) {
    throw new Error('Invalid table name or data');
  }

  const columns = Object.keys(data); // Get column names from the data object
  const values = Object.values(data); // Get values from the data object

  // Generate the SET clause for updating each column
  const setClause = columns
    .map((col, index) => `${col} = $${index + 1}`)
    .join(', ');

  // Generate the query for updating based on ens_id and session_id
  const query = `
      UPDATE ${tableName}
      SET ${setClause}
      WHERE ens_id = $${columns.length + 1} AND session_id = $${
    columns.length + 2
  }
      RETURNING *;
    `;

  try {
    // Run the update query using your database connection pool
    const result = await pool.query(query, [...values, ens_id, session_id]);
    // Check if any row was updated
    if (result.rowCount === 0) {
      return {
        success: false,
        message: `No record found with ens_id = ${ens_id} and session_id = ${session_id}.`,
        data: [],
      };
    }
    return {
      success: true,
      message: `Success`,
      data: result.rows,
    }; // Return the updated rows
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
}

export async function insertIntoTable(tableName, data) {
  if (!tableName || typeof data !== "object" || Object.keys(data).length === 0) {
    throw new Error("Invalid table name or data");
  }

  // Convert undefined → null
  Object.keys(data).forEach((key) => {
    if (data[key] === undefined) {
      data[key] = null;
    }
  });

  const columns = Object.keys(data);
  const values = Object.values(data).map((value) => {
    // Explicitly serialize arrays and objects to JSON string for JSONB columns
    if (value !== null && typeof value === "object") {
      return JSON.stringify(value);
    }
    return value;
  });

  const columnClause = columns.join(", ");
  const valuePlaceholders = columns
      .map((_, index) => `$${index + 1}`)
      .join(", ");

  const query = `
    INSERT INTO ${tableName} (${columnClause})
    VALUES (${valuePlaceholders})
      RETURNING *;
  `;

  try {
    const result = await pool.query(query, values);
    return {
      success: true,
      message: "Record inserted successfully",
      data: result.rows[0],
    };
  } catch (error) {
    console.error("Error inserting data:", error);
    throw error;
  }
}

export async function checkExistingRecord(tableName, identifier) {
  if (!tableName || !identifier) {
    throw new Error('Invalid table name or identifier');
  }

  const query = `
    SELECT * FROM ${tableName}
    WHERE identifier = $1
    LIMIT 1;
  `;

  try {
    const result = await pool.query(query, [identifier]);
    if (result.rowCount === 0) {
      return { exists: false, data: null };
    }
    return { exists: true, data: result.rows[0] };
  } catch (error) {
    console.error('Error checking existing record:', error);
    throw error;
  }
}

export async function getMsmeFromCache(identifier, pan) {
  if (!identifier || !pan) {
    throw new Error('identifier and pan are required');
  }

  const query = `
    SELECT msme_status, response
    FROM msme_check
    WHERE identifier = $1
      AND pan = $2
      LIMIT 1;
  `;

  try {
    const result = await pool.query(query, [identifier, pan]);

    if (result.rowCount === 0) {
      return { exists: false, data: null };
    }

    return {
      exists: true,
      data: {
        msme_status: result.rows[0].msme_status,
        response: result.rows[0].response,
      },
    };
  } catch (error) {
    console.error('[msme] cache lookup failed:', error);
    throw error;
  }
}

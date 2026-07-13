CREATE TABLE IF NOT EXISTS orgData (
    id SERIAL PRIMARY KEY,
    orgName VARCHAR(100) NOT NULL,
    orgIdentifier VARCHAR(100) UNIQUE NOT NULL,
    BvDIds VARCHAR(100) UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matchBvdid (
    bvdid VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    name_international VARCHAR(255),
    address TEXT,
    postcode VARCHAR(50),
    city VARCHAR(255),
    country VARCHAR(255),
    phone_or_fax VARCHAR(255),
    email_or_website VARCHAR(255),
    national_id VARCHAR(255),
    state VARCHAR(255),
    address_type VARCHAR(255),
    ens_id VARCHAR(255) UNIQUE , 
    PRIMARY KEY (ens_id)
);
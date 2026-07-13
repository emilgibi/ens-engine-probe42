import Joi from "joi";

const instaFinancialNameSchema = Joi.object({
  orgName: Joi.string().min(3).required(),
  orgIdentifier: Joi.string(),
  orgIdentifierType: Joi.string(),
  orgEntityType: Joi.string(),
});

const instaFinancialPANSchema = Joi.object({
  orgIdentifier: Joi.string().min(3).required(),
  ensId: Joi.string().min(3).required(),
  sessionId: Joi.string().min(3).required(),
  orgType: Joi.string().min(3).required(),
  identifierType: Joi.string().min(3).required(),
});

const completeCompanyDataSchema = Joi.object({
  orgIdentifier: Joi.string().min(3).required(),
  orgType: Joi.string().min(3).required(),
  identifierType: Joi.string().min(3).required(),
});

const probe42NameSearchSchema = Joi.object({
  orgName: Joi.string().min(3).required(),
});

const orgScheme = Joi.object({
  orgName: Joi.string().min(3).required(),
  orgIdentifier: Joi.string().min(3).required(),
});

export const validateOrg = (req, res, next) => {
  const { error } = orgScheme.validate(req.body);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};


export const validateInstaFinancialName = (req, res, next) => {
  const { error } = instaFinancialNameSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    })
  next();
}

export const validateInstaFinancialPAN = (req, res, next) => {
  const { error } = instaFinancialPANSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    })
  next();
}

export const validateCompanyFullData = (req, res, next) => {
  const { error } = completeCompanyDataSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    })
  next();
}

// ── Sanctions Screening Schema ─────────────────────────────
const sanctionsScreeningSchema = Joi.object({
  name:       Joi.string().min(2).required(),
  identifier: Joi.string().min(2).required(),
  address:    Joi.string().min(3).optional().allow(''),
  sessionId:  Joi.string().min(3).required(),
  ensId:      Joi.string().min(3).required(),
});

const sanctionsScreeningEmployeeSchema = Joi.object({
  identifier: Joi.string().min(2).required(),
  directors: Joi.array().required(),
  sessionId:  Joi.string().min(3).required(),
  ensId:      Joi.string().min(3).required(),
});

export const validateSanctionsScreening = (req, res, next) => {
  const { error } = sanctionsScreeningSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};

export const validateSanctionsEmployeeScreening = (req, res, next) => {
  const { error } = sanctionsScreeningEmployeeSchema.validate(req.body);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};

const addressImageSchema = Joi.object({
  orgName: Joi.string().min(2),
  name: Joi.string().min(2),
  address: Joi.string().min(5).required(),
  identifier: Joi.string().min(5).required(),
  sessionId: Joi.string().min(5).required(),
  ensId:  Joi.string().min(5).required(),
});

export const validateAddressImageQuery = (req, res, next) => {
  const { error } = addressImageSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};

const ratingSchema = Joi.object({
  address: Joi.string().min(5),
  name: Joi.string().required(),
  entity_type: Joi.string().required(),
  identifier: Joi.string().required(),
  identifier_type: Joi.string().required(),
});

export const validateRatingQuery = (req, res, next) => {
  const { error } = ratingSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};


// ... (all existing code stays) ...

// ---- AbuseIPDB / Cyber Risk ----
const cyberRiskSchema = Joi.object({
  companyName: Joi.string().min(2).required(),
  domain: Joi.string().required(),
  ens_id: Joi.string().min(3).required(),
  session_id: Joi.string().min(3).required(),
});

export const validateCyberRisk = (req, res, next) => {
  const { error } = cyberRiskSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};


const msmeSchema = Joi.object({
  name: Joi.string().min(2).required(),
  pan: Joi.string().required(),
  identifier: Joi.string().min(3).required(),
  date: Joi.string().min(3).required(),
});

export const validateMSMEValidation = (req, res, next) => {
  const { error } = msmeSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    });
  next();
};

export const validateProbe42NameSearch = (req, res, next) => {
  const { error } = probe42NameSearchSchema.validate(req.query);
  if (error)
    return res.status(400).json({
      status: 400,
      message: error.details[0].message,
    })
  next();
}

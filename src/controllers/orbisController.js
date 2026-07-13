import { updatedinsertTable, updateTable, getMsmeFromCache, insertIntoTable, upsertTableByIdentifier } from "../utils/db_utils.js";
import axios from 'axios';


export const getCompanybyName = async (req, res) => {
    const {orgName, orgIdentifier, orgIdentifierType, orgEntityType} = req.query;

    try {

        const ENV = process.env.ENV?.toUpperCase();

        const probe42Config = ENV === "PROD"
            ? {
                baseUrl: process.env.probe42_prod_url,
                apiKey: process.env.probe42_prod_api_key
            }
            : {
                baseUrl: process.env.probe42_sandbox_url,
                apiKey: process.env.probe42_sandbox_api_key
            };

        const url = `${probe42Config.baseUrl}entities`;

        const headers = {
            "x-api-key": probe42Config.apiKey,
            "Accept": "application/json",
            "x-api-version": "1.3"
        };

        const params = {
            limit: 100,
            filters: JSON.stringify({
                nameStartsWith: `${orgName}`
            })
        };

        const timeout = 10000;

        const response = await axios.get(url, {
            headers,
            params,
            timeout
        });



        if (response.status === 200) {
            // const potentialCompanies = response.data.data.entities.companies;
            const consolidatedPotentialCompanies = response.data.data.entities
                ? Object.entries(response.data.data.entities).flatMap(([org_type, items]) =>
                    (items || []).map(item => ({
                        ...item,
                        org_type
                    }))
                )
                : [];

            const filteredCompanies = consolidatedPotentialCompanies.filter((item) => {
                if (!item?.org_type || !orgEntityType) return false;
                return String(item.org_type).toLowerCase() === String(orgEntityType).toLowerCase();
            });

            const AUTO_ACCEPT_MIN = 90;   // confidence %
            const REVIEW_MIN = 75;        // confidence %
            const VALID_STATUSES = ["ACTIVE"]; // auto-accept only if status is valid

            // normalization
            function normalize(name) {
                return name
                    .toLowerCase()
                    .replace(/&/g, "and")
                    .replace(/[^a-z0-9\s]/g, "")
                    .replace(/\b(limited|ltd|private|pvt|company|co|corp|corporation)\b/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
            }

            // fuzzy logic
            function similarity(a, b) {
                const aWords = new Set(normalize(a).split(" "));
                const bWords = new Set(normalize(b).split(" "));

                const intersection = [...aWords].filter(w => bWords.has(w));
                const score = intersection.length / Math.max(aWords.size, bWords.size);

                return Number((score * 100).toFixed(2));
            }

            function matchCompany(inputName, companies, filter) {
                let bestMatch = null;
                let bestScore = 0;
                let filterMatch =0
                if (filter)
                    filterMatch=100


                for (const company of companies) {
                    const score = similarity(inputName, company.legal_name);

                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = company;
                    }
                }

                const statusValid = VALID_STATUSES.includes(bestMatch?.status);

                let decision = "REJECT";

                if (bestScore >= AUTO_ACCEPT_MIN && statusValid) {
                    decision = "AUTO_ACCEPT";
                } else if (bestScore >= REVIEW_MIN) {
                    decision = "REVIEW";
                }
                if (bestMatch) {
                    bestScore = (bestScore + filterMatch) / 2
                }
                return {
                    input: inputName,
                    matched_company: bestMatch,
                    confidence: bestScore,
                    status: bestMatch?.status || null,
                    decision: decision
                };
            }
            if (orgIdentifier){
                const found = consolidatedPotentialCompanies.find(item =>
                    item.cin === orgIdentifier || item.llpin === orgIdentifier || item.bid === orgIdentifier
                );
                if (found){
                    let result= {
                        input: orgName,
                        matched_company: found,
                        confidence: 100,
                        status: found?.status || null,
                        decision: "AUTO_ACCEPT"
                    };

                    const orgType = String(
                        result.matched_company?.org_type ||
                        result.matched_company?.orgType ||
                        ""
                    ).trim().toLowerCase();

                    if (orgType === 'companies' || orgType === 'company') {
                        result.entityType = 'Company';
                        result.identifierType = 'CIN';
                    } else if (orgType === 'llps' || orgType === 'llp') {
                        result.entityType = 'LLP';
                        result.identifierType = 'LLPIN';
                    } else if (orgType === 'proprietorships' || orgType === 'proprietorship') {
                        result.entityType = 'Proprietorship';
                        result.identifierType = 'BID';
                    } else if (orgType === 'partnerships' || orgType === 'partnership') {
                        result.entityType = 'Partnership';
                        result.identifierType = 'BID';
                    } else {
                        console.log("No matching orgType for:", orgType);
                    }

                    console.log(result);
                    return res.status(200).json({ success: true, message: "Successful", data: result });
                }
            }
            let result = {}
            if (orgEntityType) {
                const result1 = matchCompany(orgName, filteredCompanies, true);
                const result2 = matchCompany(orgName, consolidatedPotentialCompanies, false);
                if (result1.confidence >= result2.confidence)
                    result = result1
                else
                    result = result2
            }
            else{
                result = matchCompany(orgName, consolidatedPotentialCompanies, true);
            }

            if (!result?.matched_company) {
                return res.status(200).json({
                    success: false,
                    message: "No matching company found",
                    data: result,
                });
            }
            if (result.matched_company.org_type === 'companies') {
                result.entityType = 'Company';
                result.identifierType = 'CIN';
            } else if (result.matched_company.org_type === 'llps') {
                result.entityType = 'LLP';
                result.identifierType = 'LLPIN';
            } else if (result.matched_company.org_type === 'proprietorships') {
                result.entityType = 'Proprietorship';
                result.identifierType = 'BID';
            } else {
                result.entityType = 'Partnership';
                result.identifierType = 'BID';
            }
            return res.status(200).json({ success: true, message: "Successful", data: result})
        } else {
            return res.status(409).json({ error: 'API request failed.', details: response.data });
        }
    } catch (error) {
        console.error('Error fetching data from Orbis API:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }


}

const probe42EntitySearchConfig = {
    companies: {
        identifierField: "cin",
        identifierType: "CIN",
        entityType: "Company"
    },
    llps: {
        identifierField: "llpin",
        identifierType: "LLPIN",
        entityType: "LLP"
    },
    proprietorships: {
        identifierField: "bid",
        identifierType: "BID",
        entityType: "Proprietorship"
    },
    partnerships: {
        identifierField: "bid",
        identifierType: "BID",
        entityType: "Partnership"
    }
};

export const searchProbe42CompaniesByName = async (req, res) => {
    const { orgName } = req.query;

    try {
        const ENV = process.env.ENV?.toUpperCase();

        const probe42Config =
            ENV === "PROD"
                ? {
                    baseUrl: process.env.probe42_prod_url,
                    apiKey: process.env.probe42_prod_api_key
                }
                : {
                    baseUrl: process.env.probe42_sandbox_url,
                    apiKey: process.env.probe42_sandbox_api_key
                };

        const url = `${probe42Config.baseUrl}entities`;

        const headers = {
            "x-api-key": probe42Config.apiKey,
            Accept: "application/json",
            "x-api-version": "1.3"
        };

        const params = {
            limit: 100,
            filters: JSON.stringify({
                nameStartsWith: `${orgName}`
            })
        };

        const response = await axios.get(url, {
            headers,
            params,
            timeout: 10000
        });

        if (response.status === 200) {
            const entities = response.data?.data?.entities ?? {};

            // Flatten all entity groups into a single array
            const results = Object.entries(entities).flatMap(([entityGroup, items]) => {
                const config = probe42EntitySearchConfig[entityGroup];
                if (!config || !Array.isArray(items)) return [];

                return items.map((item) => ({
                    name: item?.legal_name ?? item?.name ?? null,
                    identifier: item?.[config.identifierField] ?? null,
                    identifier_type: config.identifierType,
                    entity_type: config.entityType
                }));
            });

            // Re-rank results by how closely the name matches the query
            const query = orgName?.toLowerCase().trim() ?? "";

            // Bucket 0 — Exact match
            const bucket0 = results.filter(
                (r) => r.name?.toLowerCase() === query
            );

            // Bucket 1 — Starts with query (but not exact)
            const bucket1 = results.filter(
                (r) =>
                    r.name?.toLowerCase().startsWith(query) &&
                    r.name?.toLowerCase() !== query
            );

            // Bucket 2 — Contains query (but doesn't start with it)
            const bucket2 = results.filter(
                (r) =>
                    r.name?.toLowerCase().includes(query) &&
                    !r.name?.toLowerCase().startsWith(query)
            );

            // Bucket 3 — Everything else (weak / no match)
            const alreadyFound = new Set(
                [...bucket0, ...bucket1, ...bucket2].map((r) => r.identifier)
            );

            const bucket3 = results.filter(
                (r) => !alreadyFound.has(r.identifier)
            );

            // Final ranked result — best matches first regardless of entity type
            const rankedResults = [
                ...bucket0,
                ...bucket1,
                ...bucket2,
                ...bucket3
            ];

            return res.status(200).json({
                success: true,
                message: "Successful",
                data: rankedResults
            });
        }

        return res.status(409).json({
            error: "API request failed.",
            details: response.data
        });
    } catch (error) {
        console.error("Error fetching Probe42 name search data:", error);
        return res.status(500).json({
            error: "Internal server error."
        });
    }
};


export const getProbe42CompanyData = async (req, res) => {
    const { orgIdentifier, ensId, sessionId, orgType, identifierType } = req.query;
    let type = "companies"; // default

    if (orgType) {
        const norm = String(orgType).trim().toLowerCase();
        if (norm === "llp") {
            type = "llps";
        }
    }

    const safe = (fn, fallback = null) => {
        try {
            return fn();
        } catch (e) {
            console.error("Safe block failed:", e?.message || e);
            return fallback;
        }
    };

    const fyRank = (v) => {
        const s = String(v ?? "");
        const yrs = s.match(/\d{4}/g);
        if (!yrs || yrs.length === 0) return -1;
        return Number(yrs[yrs.length - 1]); // handles 2023-24, 2024, dates, etc.
    };

    const latestByFY = (arr, key = "financial_year") => {
        if (!Array.isArray(arr) || arr.length === 0) return null;
        return arr.reduce((latest, current) =>
            fyRank(current?.[key]) > fyRank(latest?.[key]) ? current : latest
        );
    };

    const getLatestYearValue = (fieldArray) => {
        if (!Array.isArray(fieldArray) || fieldArray.length === 0) return null;
        const latest = fieldArray.reduce((a, b) =>
            fyRank(b?.year) > fyRank(a?.year) ? b : a
        );
        return latest?.value ?? null;
    };

    const isAllNull = (obj) => {
        if (!obj || typeof obj !== "object") return true;
        const values = Object.values(obj);
        if (values.length === 0) return true;
        return values.every((v) => v === null);
    };

    const normalizeFinancialEntry = (entry) => {
        // Company shape
        if (entry?.bs || entry?.pnl || entry?.cash_flow) {
            return {
                year: entry?.year ?? null,
                nature: entry?.nature ?? null,
                bs: entry?.bs ?? {},
                pnl: entry?.pnl ?? {},
                cash_flow: entry?.cash_flow ?? {},
                ratios: entry?.ratios ?? null,
                auditor_comments: entry?.auditor_comments ?? null,
            };
        }

        // LLP shape
        return {
            year: entry?.year ?? null,
            nature: "STANDALONE",
            bs: entry?.statement_of_assets_and_liabilities
                ? {
                    assets: entry.statement_of_assets_and_liabilities.assets ?? {},
                    liabilities: entry.statement_of_assets_and_liabilities.liabilities ?? {},
                    subTotals: entry.statement_of_assets_and_liabilities.subTotals ?? {},
                }
                : {},
            pnl: entry?.statement_of_income_and_expenditure
                ? {
                    lineItems: entry.statement_of_income_and_expenditure.lineItems ?? {},
                    subTotals: {},
                    revenue_breakup: entry.statement_of_income_and_expenditure.revenue_breakup ?? {},
                    depreciation_breakup: entry.statement_of_income_and_expenditure.depreciation_breakup ?? {},
                }
                : {},
            cash_flow: {},
            ratios: entry?.ratios ?? null,
            auditor_comments: null,
        };
    };

    try {
        const ENV = process.env.ENV?.toUpperCase();

        const probe42Config =
            ENV === "PROD"
                ? {
                    baseUrl: process.env.probe42_prod_url,
                    apiKey: process.env.probe42_prod_api_key,
                }
                : {
                    baseUrl: process.env.probe42_sandbox_url,
                    apiKey: process.env.probe42_sandbox_api_key,
                };

        const url = `${probe42Config.baseUrl}${type}/${orgIdentifier}/comprehensive-details`;

        const headers = {
            "x-api-key": probe42Config.apiKey,
            Accept: "application/json",
            "x-api-version": "1.3",
        };

        const response = await axios.get(url, {
            headers,
            timeout: 10000,
        });

        if (response.status !== 200) {
            return res.status(409).json({ error: "API request failed.", details: response.data });
        }

        const data = response?.data?.data ?? {};
        const company = data?.company || data?.llp || data?.pnp || {};
        const contact_details = data?.contact_details || {};

        // Company has authorized_signatories; LLP has directors
        const signatorySource = Array.isArray(data?.authorized_signatories)
            ? data.authorized_signatories
            : Array.isArray(data?.directors)
                ? data.directors
                : [];

        const simplifiedSignatories = safe(
            () =>
                signatorySource.map((person) => ({
                    name: person?.name ?? null,
                    pan: person?.pan ?? null,
                    din: person?.din ?? null,
                    designation: person?.designation ?? null,
                    date_of_resignation: person?.date_of_cessation ?? null,
                })),
            []
        );

        const alias = safe(() => data?.name_history?.map((item) => item?.name).filter(Boolean), null);

        // related_party_transactions (schema key)
        const rpt = Array.isArray(data?.related_party_transactions) ? data.related_party_transactions : [];
        const related_party_transactions = safe(() => {
            const latestRPT = latestByFY(rpt, "financial_year");
            if (!latestRPT) return [];
            return Object.entries(latestRPT)
                .filter(([key]) => key !== "financial_year")
                .flatMap(([_, arr]) => (Array.isArray(arr) ? arr : []));
        }, []);

        const currentYear = new Date().getFullYear();
        const epfo = data?.establishments_registered_with_epfo ?? null;
        const director_network = data?.director_network ?? null;

        // Build merged financials (same output shape as old code expects)
        const financials = safe(() => {
            if (!Array.isArray(data?.financials)) return {};

            return data.financials
                .map(normalizeFinancialEntry)
                .filter((f) => {
                    const y = fyRank(f?.year);
                    if (y < 0) return false;
                    return currentYear - y <= 3;
                })
                .reduce((acc, curr) => {
                    const year = String(fyRank(curr?.year));

                    const processNested = (target, source) => {
                        if (!source || typeof source !== "object") return;

                        Object.entries(source).forEach(([key, value]) => {
                            if (value && typeof value === "object" && !Array.isArray(value)) {
                                target[key] = target[key] || {};
                                processNested(target[key], value);
                            } else {
                                target[key] = target[key] || [];
                                target[key].push({ year, value: value ?? null });
                            }
                        });
                    };

                    Object.entries(curr).forEach(([section, value]) => {
                        if (["year", "nature", "stated_on", "filing_type", "filing_standard"].includes(section)) return;
                        if (!value || typeof value !== "object") return;

                        acc[section] = acc[section] || {};
                        processNested(acc[section], value);
                    });

                    return acc;
                }, {});
        }, {});

        const shareholdingsLatest = safe(
            () => latestByFY(data?.shareholdings_more_than_five_percent ?? [], "financial_year"),
            null
        );

        const consolidatedShareholdings = safe(() => {
            if (!shareholdingsLatest) return null;
            return ["company", "llp", "individual", "others"].flatMap((t) =>
                (shareholdingsLatest[t] || []).map((item) => ({
                    financial_year: shareholdingsLatest.financial_year ?? null,
                    type: t,
                    ...item,
                }))
            );
        }, null);

        const consolidatedSubsidiaries = safe(() => {
            if (!data?.subsidiary_entities) return null;
            return ["company", "llp", "others"].flatMap((t) =>
                (data.subsidiary_entities[t] || []).map((item) => ({
                    financial_year: data.subsidiary_entities.financial_year ?? null,
                    type: t,
                    legal_name: item?.legal_name ?? null,
                    share_holding_percentage: item?.share_holding_percentage ?? null,
                }))
            );
        }, null);

        const consolidatedOpenCharges = safe(
            () =>
                Array.isArray(data?.open_charges)
                    ? data.open_charges.map((charge) => ({
                        id: charge?.id ?? null,
                        date: charge?.date ?? null,
                        holder_name: charge?.holder_name ?? null,
                        amount: charge?.amount ?? null,
                        type: charge?.type ?? null,
                    }))
                    : null,
            null
        );

        const consolidatedLegalHistory = safe(
            () =>
                Array.isArray(data?.legal_history)
                    ? data.legal_history.map((caseItem) => ({
                        petitioner: caseItem?.petitioner ?? null,
                        respondent: caseItem?.respondent ?? null,
                        court: caseItem?.court ?? null,
                        date: caseItem?.date ?? null,
                        case_status: caseItem?.case_status ?? null,
                        case_number: caseItem?.case_number ?? null,
                        case_type: caseItem?.case_type ?? null,
                        case_category: caseItem?.case_category ?? null,
                        severity: caseItem?.severity ?? null,
                    }))
                    : null,
            null
        );

        const zAltmanFactors = safe(() => {
            const totalAssets =
                getLatestYearValue(financials?.bs?.subTotals?.given_assets_total) ??
                getLatestYearValue(financials?.bs?.assets?.given_assets_total);

            const totalCurrentAssets = getLatestYearValue(financials?.bs?.subTotals?.total_current_assets);
            const totalCurrentLiabilities = getLatestYearValue(financials?.bs?.subTotals?.total_current_liabilities);
            const totalEquity = getLatestYearValue(financials?.bs?.subTotals?.total_equity);
            const totalDebt = getLatestYearValue(financials?.bs?.subTotals?.total_debt);
            const totalNonCurrentLiab = getLatestYearValue(financials?.bs?.subTotals?.total_non_current_liabilities);
            const retainedEarnings = getLatestYearValue(financials?.bs?.liabilities?.reserves_and_surplus);
            const ebit = getLatestYearValue(financials?.pnl?.lineItems?.profit_before_interest_and_tax);
            const sales = getLatestYearValue(financials?.pnl?.lineItems?.net_revenue);

            const workingCapital =
                totalCurrentAssets != null && totalCurrentLiabilities != null
                    ? totalCurrentAssets - totalCurrentLiabilities
                    : null;

            const totalLiabilities =
                totalDebt != null && totalCurrentLiabilities != null && totalNonCurrentLiab != null
                    ? totalDebt + totalCurrentLiabilities + totalNonCurrentLiab
                    : null;

            return {
                total_assets: totalAssets,
                total_current_assets: totalCurrentAssets,
                total_current_liabilities: totalCurrentLiabilities,
                working_capital: workingCapital,
                retained_earnings: retainedEarnings,
                ebit,
                total_equity: totalEquity,
                total_debt: totalDebt,
                total_non_current_liabilities: totalNonCurrentLiab,
                total_liabilities: totalLiabilities,
                sales,
            };
        }, null);

        const auditor_comments = safe(() => getLatestYearValue(financials?.auditor_comments), null);

        const ratioFactors = safe(
            () => ({
                total_current_assets: financials?.bs?.subTotals?.total_current_assets ?? null,
                total_current_liabilities: financials?.bs?.subTotals?.total_current_liabilities ?? null,
                total_equity: financials?.bs?.subTotals?.total_equity ?? null,
                total_debt: financials?.bs?.subTotals?.total_debt ?? null,
                total_non_current_liabilities: financials?.bs?.subTotals?.total_non_current_liabilities ?? null,

                given_assets_total: financials?.bs?.assets?.given_assets_total ?? null,
                inventories: financials?.bs?.assets?.inventories ?? null,
                trade_receivables: financials?.bs?.assets?.trade_receivables ?? null,
                cash_and_bank_balances:
                    financials?.bs?.assets?.cash_and_bank_balances ??
                    financials?.bs?.assets?.cash_and_cash_equivalents ??
                    null,
                other_current_assets: financials?.bs?.assets?.other_current_assets ?? null,

                trade_payables: financials?.bs?.liabilities?.trade_payables ?? null,
                share_capital:
                    financials?.bs?.liabilities?.share_capital ??
                    financials?.bs?.liabilities?.contribution_received ??
                    null,
                reserves_and_surplus: financials?.bs?.liabilities?.reserves_and_surplus ?? null,

                net_revenue: financials?.pnl?.lineItems?.net_revenue ?? null,
                profit_after_tax: financials?.pnl?.lineItems?.profit_after_tax ?? null,
                profit_before_tax: financials?.pnl?.lineItems?.profit_before_tax ?? null,
                interest: financials?.pnl?.lineItems?.interest ?? null,
                income_tax: financials?.pnl?.lineItems?.income_tax ?? null,
                depreciation: financials?.pnl?.lineItems?.depreciation ?? null,
                total_cost_of_materials_consumed: financials?.pnl?.lineItems?.total_cost_of_materials_consumed ?? null,
                total_purchases_of_stock_in_trade: financials?.pnl?.lineItems?.total_purchases_of_stock_in_trade ?? null,
                total_changes_in_inventories_or_finished_goods:
                    financials?.pnl?.lineItems?.total_changes_in_inventories_or_finished_goods ?? null,

                cash_flows_from_used_in_operating_activities:
                    financials?.cash_flow?.cash_flows_from_used_in_operating_activities ?? null,
            }),
            {}
        );

        const ratioFactorsToStore = isAllNull(ratioFactors) ? null : ratioFactors;
        const financialBsToStore = isAllNull(financials?.bs?.subTotals) ? null : financials?.bs?.subTotals;
        const financialPnlToStore = isAllNull(financials?.pnl?.lineItems) ? null : financials?.pnl?.lineItems;
        const financialCashFlowToStore = isAllNull(financials?.cash_flow) ? null : financials?.cash_flow;
        const financialRatiosToStore = isAllNull(financials?.ratios) ? null : financials?.ratios;

        // IMPORTANT: keeping same old columns only
        const data_to_push = {
            legal_name: company?.legal_name ?? null,
            e_filing_status: company?.efiling_status ?? null,
            incorporation_date: company?.incorporation_date ?? null,
            address: company?.registered_address?.full_address ?? null,
            city: company?.registered_address?.city ?? null,
            state: company?.registered_address?.state ?? null,
            pan: company?.pan ?? null,
            website: company?.website ?? null,
            classification: company?.classification ?? null,
            email: company?.email ?? null,
            directors: JSON.stringify(simplifiedSignatories) ?? null,
            phone: contact_details?.phone?.[0]?.phoneNumber ?? null,
            financial_ratios: financialRatiosToStore ?? null,
            financial_bs: financialBsToStore ?? null,
            financial_pnl: financialPnlToStore ?? null,
            financial_cash_flow: financialCashFlowToStore ?? null,
            auditors: financials?.auditor_comments ?? null,
            open_charges: JSON.stringify(consolidatedOpenCharges) ?? null,
            related_party_transaction: JSON.stringify(related_party_transactions) ?? null,
            shareholdings: JSON.stringify(consolidatedShareholdings) ?? null,
            legal_history: JSON.stringify(consolidatedLegalHistory) ?? null,
            credit_rating: JSON.stringify(data?.credit_ratings ?? null) ?? null,
            subsidiary: JSON.stringify(consolidatedSubsidiaries) ?? null,
            gst_details: JSON.stringify(data?.gst_details ?? null) ?? null,
            msme: JSON.stringify(data?.msme_supplier_payment_delays?.trend ?? null) ?? null,
            key_indicators: data?.key_indicators ?? null,
            ens_id: ensId,
            session_id: sessionId,
            cin_id: orgIdentifier, // unchanged column as requested
            alias: JSON.stringify(alias) ?? null,
            entity_type: orgType,
            identifier_type: identifierType,
            z_altman_factors: JSON.stringify(zAltmanFactors) ?? null,
            ratio_factors: ratioFactorsToStore ? JSON.stringify(ratioFactorsToStore) : null,
            epfo: epfo ? JSON.stringify(epfo) : null,
            auditor_comment: JSON.stringify(auditor_comments) ?? null,
            director_network: JSON.stringify(director_network) ?? null,
        };

        try {
            const tableName = "external_supplier_data";
            const inserted_response = await updatedinsertTable(tableName, data_to_push, ensId, sessionId);
            return res
                .status(200)
                .json({ success: true, message: "Successfully saved data", data: inserted_response });
        } catch (error) {
            return res.status(409).json({ success: false, message: error.message });
        }
    } catch (error) {
        console.error("Error fetching data from Probe42 API:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
};
export const getSanctionsScreening = async (req, res, next) => {
    const { name, identifier, address = '', sessionId, ensId } = req.query;

    console.log(`[sanctions] Screening name="${name}" identifier="${identifier}" ens=${ensId} session=${sessionId}`);
    const OPENSANCTIONS_URL = 'https://api.opensanctions.org/match/default'
    try {
        // ── Build OpenSanctions payload ────────────────────────────────────────
        const properties = {
            name:                 [name],
            registrationNumber:   [identifier],
            jurisdiction:         ['IN'],
        };
        if (address) properties.address = [address];

        const payload = {
            queries: {
                q1: { schema: 'Company', properties },
            },
        };

        // ── Call OpenSanctions ─────────────────────────────────────────────────
        const response = await axios.post(OPENSANCTIONS_URL, payload, {
            headers: {
                Authorization:  `ApiKey ${process.env.OPENSANCTIONS_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });

        const matches = response.data?.responses?.q1?.results ?? [];

        // ── Pick highest match score ───────────────────────────────────────────
        const topMatch = matches.reduce(
            (best, m) => (m.score ?? 0) > (best?.score ?? -1) ? m : best,
            null
        );

        // ── Extract only name, sanctionReason, topics, sourceUrl ──────────────
        let sanctionData = null;
        if (topMatch) {
            const props = topMatch.properties ?? {};
            sanctionData = {
                name:           props.name?.[0]   ?? null,
                sanctionReason: props.reason      ?? [],
                topics:         props.topics      ?? [],
                sourceUrl:      props.sourceUrl   ?? [],
                score:          topMatch.score ?? 0,
                isMatch:        topMatch.match    ?? false,
                datasets:       topMatch.dataset ?? [],
                first_seen:     topMatch.first_seen ?? 'N/A',
                last_seen:      topMatch.last_seen ?? 'N/A',
                last_change:    topMatch.last_change ?? 'N/A',
            };
        }

        // ── Stringify and store in external_supplier_data.sanctions ───────────
        const dbResult = await updateTable(
            'external_supplier_data',
            {
                sanctions: JSON.stringify(sanctionData),
                legal_name: name,
                identifier: identifier,
            },
            ensId,
            sessionId
        );

        if (!dbResult.success) {
            console.warn(`[sanctions] DB update found no row for ens=${ensId} session=${sessionId}`);
        } else {
            console.log(`[sanctions] Stored for ens=${ensId}, isMatch=${sanctionData?.isMatch ?? false}`);
        }

        return res.status(200).json({
            status:  200,
            message: 'Sanctions screening completed',
            data:    sanctionData,
        });

    } catch (error) {
        console.error('[sanctions] Error:', error?.response?.data ?? error.message);
        next(error);
    }
};

/* ------------------ FUZZY MATCH HELPERS ------------------ */

function editDistance(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();

    const costs = [];

    for (let i = 0; i <= a.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= b.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (a.charAt(i - 1) !== b.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[b.length] = lastValue;
    }

    return costs[b.length];
}

function similarity(a, b) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    const longerLength = longer.length;
    if (longerLength === 0) return 1.0;

    return (longerLength - editDistance(longer, shorter)) / longerLength;
}

function isStrongNameMatch(queryName, candidateNames = []) {
    const query = queryName.toLowerCase();
    const queryTokens = query.split(" ");

    return candidateNames.some(name => {
        const n = name.toLowerCase();

        const sim = similarity(query, n);
        const nameTokens = n.split(" ");

        const tokenOverlap = queryTokens.some(q => nameTokens.includes(q));

        return sim >= 0.85 && tokenOverlap;
    });
}

/* ------------------ MATCH SELECTION ------------------ */

function pickBestMatch(matches, directorName) {
    if (!matches || matches.length === 0) return null;

    let best = null;

    for (const m of matches) {
        const score = m.score ?? 0;
        const candidateNames = m.properties?.name || [];

        const strongMatch = isStrongNameMatch(directorName, candidateNames);

        if (score >= 0.85 && strongMatch) {
            if (!best || score > best.score) {
                best = m;
            }
        }

        // Debug if needed
        console.log({
            director: directorName,
            candidate: m.caption,
            score,
            strongMatch
        });
    }

    return best;
}

/* ------------------ MAIN FUNCTION ------------------ */

export const getEmployeeSanctionsScreening = async (req, res, next) => {
    const {
        identifier,
        directors = [],
        sessionId,
        ensId
    } = req.body;

    const OPENSANCTIONS_URL =
        "https://api.opensanctions.org/match/default?threshold=0.7&limit=10";

    try {
        if (!identifier || !sessionId || !ensId) {
            return res.status(400).json({
                status: 400,
                message: "identifier, sessionId, ensId required"
            });
        }

        if (!Array.isArray(directors) || directors.length === 0) {
            return res.status(400).json({
                status: 400,
                message: "Directors list is required"
            });
        }

        /* ---------- BUILD PAYLOAD ---------- */

        const queries = {};
        directors.forEach((director, index) => {
            queries[`director_${index + 1}`] = {
                schema: "Person",
                properties: {
                    name: [director],
                    nationality: ["IN"]
                }
            };
        });

        const response = await axios.post(OPENSANCTIONS_URL, { queries }, {
            headers: {
                Authorization: `ApiKey ${process.env.OPENSANCTIONS_API_KEY}`,
                "Content-Type": "application/json"
            },
            timeout: 30000
        });

        const responses = response.data?.responses ?? {};

        /* ---------- PROCESS RESULTS ---------- */

        /* ---------- PROCESS RESULTS ---------- */

        const screeningResults = Object.entries(responses)
            .map(([key, result], idx) => {

                const directorName =
                    result.query?.properties?.name?.[0] || directors[idx];

                const matches = result.results ?? [];

                const bestMatch = pickBestMatch(matches, directorName);

                // ✅ SKIP if no valid match
                if (!bestMatch) return null;

                const urls =
                    bestMatch.properties?.sourceUrl ||
                    bestMatch.properties?.source_url || [];

                // ✅ FIX: extract topics correctly
                const topics =
                    bestMatch.properties?.topics ||
                    bestMatch.topics || [];

                const confidence =
                    bestMatch.score >= 0.92
                        ? "HIGH"
                        : bestMatch.score >= 0.90
                            ? "MEDIUM"
                            : "LOW";

                return {
                    director: directorName,
                    matched: true,
                    score: bestMatch.score,
                    confidence,
                    matchName: bestMatch.caption,
                    entityId: bestMatch.id,
                    datasets: bestMatch.datasets ?? [],
                    first_seen: bestMatch.first_seen ?? null,
                    last_seen: bestMatch.last_seen ?? null,
                    urls,
                    topics   // ✅ ADDED
                };
            })
            .filter(Boolean);

        /* ---------- STORE CLEAN DATA ---------- */

        if (screeningResults.length > 0) {
            const dbResult = await updateTable(
                "external_supplier_data",
                {
                    sanctions_employee: JSON.stringify(screeningResults)
                },
                ensId,
                sessionId
            );

            if (!dbResult.success) {
                console.warn("DB update failed");
            }
        } else {
            console.log("No valid sanctions matches found → DB not updated");
        }

        /* ---------- STORE CLEAN DATA ---------- */

        const dbResult = await updateTable(
            "external_supplier_data",
            {
                sanctions_employee: JSON.stringify(screeningResults),
                identifier: identifier
            },
            ensId,
            sessionId
        );

        if (!dbResult.success) {
            console.warn("DB update failed");
        }

        return res.status(200).json({
            status: 200,
            message: "Employee sanctions screening completed",
            data: screeningResults
        });

    } catch (error) {
        console.error("Sanctions Screening Error");

        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }

        return res.status(500).json({
            status: 500,
            message: "Something went wrong",
            error: error?.response?.data || error.message
        });
    }
};

function normalizeLegalName(name) {
    if (!name) return name;

    return name
        .replace(/&amp;/gi, '&')   // decode HTML entities
        .replace(/\s+/g, ' ')      // collapse multiple spaces
        .trim()                    // trim leading/trailing spaces
        .toUpperCase();            // canonical form
}

export const getMsmeStatus = async (req, res, next) => {
    const { pan, name, identifier, date } = req.query;
    const attestrAuthToken =
        process.env.ATTESTR_BASE64_KEY || process.env.ATTESTR_API_TOKEN;

    console.log(`[msme] PAN=${pan}, identifier=${identifier}`);

    const ATTESTR_URL =
        'https://api.attestr.com/api/v2/public/corpx/pan-msme-status';

    try {
        const cached = await getMsmeFromCache(identifier, pan);

        let msmeStatus;
        let responseData;
        let source = 'CACHE';

        if (cached.exists) {
            msmeStatus = cached.data.msme_status;
            responseData = cached.data.response;
        } else {
            if (!date || !name) {
                return res.status(200).json({
                    status: 200,
                    data: {
                        identifier,
                        pan,
                        msme_status: 'UNKNOWN',
                        source: 'SKIPPED_MISSING_DATA',
                    },
                });
            }

            // ✅ Normalize date BEFORE calling Attestr
            const attestrDate = toAttestrDate(date);
            if (!attestrDate) {
                return res.status(200).json({
                    status: 200,
                    data: {
                        identifier,
                        pan,
                        msme_status: 'UNKNOWN',
                        source: 'INVALID_DATE',
                    },
                });
            }

            source = 'LIVE';
            const normalizedName = normalizeLegalName(name);

            const apiResponse = await axios.post(
                ATTESTR_URL,
                {
                    pan,
                    name: normalizedName,
                    birthOrIncorporatedDate: attestrDate, // ✅ ALWAYS correct
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Basic ${attestrAuthToken}`,
                    },
                    timeout: 30000,
                }
            );

            responseData = apiResponse.data;
            msmeStatus = apiResponse.data?.status ?? 'UNKNOWN';

            await insertIntoTable('msme_check', {
                identifier,
                pan,
                msme_status: msmeStatus,
                response: responseData,
            });
        }

        return res.status(200).json({
            status: 200,
            message: 'MSME status resolved successfully',
            data: {
                identifier,
                pan,
                msme_status: msmeStatus,
                source,
            },
        });
    } catch (error) {
        const status = error?.response?.status;
        const err = error?.response?.data;

        if ([400, 401, 403].includes(status)) {
            return res.status(200).json({
                status: 200,
                data: {
                    identifier,
                    pan,
                    msme_status: 'UNKNOWN',
                    source:
                        status === 400
                            ? 'INVALID_INPUT'
                            : status === 401
                                ? 'AUTH_FAILED'
                                : 'NOT_PROVISIONED',
                    reason: err?.message,
                },
            });
        }

        next(error);
    }
};

const toAttestrDate = (input) => {
    if (!input) return null;

    const d = new Date(input);
    if (isNaN(d.getTime())) return null;

    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();

    return `${day}/${month}/${year}`; // ✅ DD/MM/YYYY
};


export const getProbe42CompanyFullData = async (req, res) => {
    const {orgIdentifier, orgType, identifierType} = req.query;
    let type = 'companies'; // default

    if (orgType) {
        const norm = String(orgType).trim().toLowerCase();

        if (norm.toLowerCase() === 'llp') {
            type = 'llps';
        }
    }

    try {
        const ENV = process.env.ENV?.toUpperCase();

        const probe42Config = ENV === "PROD"
            ? {
                baseUrl: process.env.probe42_prod_url,
                apiKey: process.env.probe42_prod_api_key
            }
            : {
                baseUrl: process.env.probe42_sandbox_url,
                apiKey: process.env.probe42_sandbox_api_key
            };
        const url = `${probe42Config.baseUrl}${type}/${orgIdentifier}/comprehensive-details`;

        const headers = {
            "x-api-key": probe42Config.apiKey,
            "Accept": "application/json",
            "x-api-version": "1.3"
        };
        const response = await axios.get(url, {
            headers,
            timeout: 10000
        });

        if (response.status === 200) {
            const data = response.data.data;
            const company = data.company || data.llp || data.pnp;

            const data_to_push = {
                name: company?.legal_name ?? null,
                identifier: orgIdentifier,
                entity_type: orgType,
                identifier_type:identifierType,
                probe42_data: data
            };
            try{
                const tableName = "probe42_data";
                const inserted_response = await upsertTableByIdentifier(tableName, data_to_push, orgIdentifier);

                return res.status(200).json({ success: true, message: "Successfully saved data", data: inserted_response});
            } catch (error) {
                // Pass error to error-handling middleware
                return res.status(409).json({ success: false,  message: error.message});
            }

            return res.status(200).json({ success: true, message: "Successful", data: data_to_push})
        } else {
            return res.status(409).json({ error: 'API request failed.', details: response.data });
        }
    } catch (error) {
        console.error('Error fetching data from Orbis API:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}

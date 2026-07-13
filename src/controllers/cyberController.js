import axios from 'axios';
import dns from 'dns';
import { promisify } from 'util';
import { updateTable } from '../utils/db_utils.js';

const lookup = promisify(dns.lookup);

const ABUSEIPDB_URL = 'https://api.abuseipdb.com/api/v2/check';

const ABUSE_CATEGORY_MAP = {
    5: 'Port Scan',
    7: 'Web Attack',
    9: 'Botnet Activity',
    10: 'Exploited Host',
    12: 'Malware Host',
    15: 'Command & Control',
    16: 'Spam Server',
    18: 'Brute Force',
};

const resolveDomain = async (domain) => {
    try {
        const result = await lookup(domain);
        return result.address;
    } catch {
        return null;
    }
};

const fetchAbuseData = async (ip) => {
    const response = await axios.get(ABUSEIPDB_URL, {
        headers: {
            Key: process.env.ABUSEIPDB_API_KEY,
            Accept: 'application/json',
        },
        params: {
            ipAddress: ip,
            maxAgeInDays: 90,
            verbose: true,
        },
        timeout: 10000,
    });
    return response.data?.data || {};
};

const getCyberRiskScore = (abuseData) => {
    const score = abuseData.abuseConfidenceScore || 0;
    let level;
    if (score >= 70) level = 'High';
    else if (score >= 30) level = 'Medium';
    else level = 'Low';
    return { score, level };
};

const detectCompromisedSystems = (abuseData) => {
    const reports = abuseData.reports || [];
    const detected = {
        botnet: false,
        malware_hosting: false,
        command_and_control: false,
        spam_server: false,
        evidence: new Set(),
    };

    for (const report of reports) {
        for (const cat of report.categories || []) {
            const label = ABUSE_CATEGORY_MAP[cat];
            if (label) detected.evidence.add(label);
            if (cat === 9)               detected.botnet = true;
            if (cat === 12 || cat === 7) detected.malware_hosting = true;
            if (cat === 15)              detected.command_and_control = true;
            if (cat === 16)              detected.spam_server = true;
        }
    }

    const compromised =
        detected.botnet ||
        detected.malware_hosting ||
        detected.command_and_control ||
        detected.spam_server;

    return { ...detected, evidence: [...detected.evidence], compromised };
};

const getVendorRisk = (compromised, score) =>
    compromised || score >= 50 ? 'FLAGGED' : 'PASS';

const getFraudComplianceFlag = (compromised, score) =>
    compromised && score >= 30 ? 'YES' : 'NO';


export const getCyberRisk = async (req, res, next) => {
    const { companyName, domain, session_id, ens_id } = req.query;

    console.log(`[cyberRisk] company="${companyName}" domain="${domain}" ens=${ens_id} session=${session_id}`);

    try {
        // ── Resolve domain → IP ───────────────────────────────────────────────
        const ip = await resolveDomain(domain);
        if (!ip) {
            return res.status(400).json({ status: 400, message: 'Domain resolution failed' });
        }

        // ── Call AbuseIPDB ────────────────────────────────────────────────────
        const abuseData = await fetchAbuseData(ip);

        // ── Analyse ───────────────────────────────────────────────────────────
        const { score, level }   = getCyberRiskScore(abuseData);
        const compromisedSystems = detectCompromisedSystems(abuseData);
        const vendorFlag         = getVendorRisk(compromisedSystems.compromised, score);
        const fraudFlag          = getFraudComplianceFlag(compromisedSystems.compromised, score);

        // ── Combine everything into one object → cyber_risk column ────────────
        const cyberRiskObject = {
            resolved_ip:               ip,
            cyber_risk_score:          score,
            cyber_risk_level:          level,
            botnet:                    compromisedSystems.botnet,
            malware_hosting:           compromisedSystems.malware_hosting,
            command_and_control:       compromisedSystems.command_and_control,
            spam_server:               compromisedSystems.spam_server,
            compromised:               compromisedSystems.compromised,
            evidence:                  compromisedSystems.evidence,
            vendor_cyber_risk:         vendorFlag,
            fraud_compliance_red_flag: fraudFlag,
        };

        // ── Store in external_supplier_data.cyber_risk ────────────────────────
        const dbResult = await updateTable(
            'external_supplier_data',
            { cyber_risk: JSON.stringify(cyberRiskObject) },
            ens_id,
            session_id
        );

        if (!dbResult.success) {
            console.warn(`[cyberRisk] DB update found no row for ens=${ens_id} session=${session_id}`);
            return res.status(400).json({
                status:  400,
                message: 'No record found to update',
                data:    null,
            });
        }

        console.log(`[cyberRisk] Stored for ens=${ens_id}, level=${level}`);
        return res.status(200).json({
            status:  200,
            message: 'Cyber risk analysis completed',
            data:    cyberRiskObject,
        });

    } catch (error) {
        console.error('[cyberRisk] Error:', error?.response?.data ?? error.message);
        next(error);
    }
};

// const IPQS_URL = 'https://www.ipqualityscore.com/api/json/url';
//
// const getCyberRiskScore = (riskScore = 0) => {
//     let level;
//     if (riskScore >= 70) level = 'High';
//     else if (riskScore >= 30) level = 'Medium';
//     else level = 'Low';
//     return { score: riskScore, level };
// };
//
// const detectCompromisedSystems = (ipqsData) => {
//     const detected = {
//         botnet: false,                  // ❌ not supported by IPQS URL API
//         malware_hosting: false,
//         command_and_control: false,      // ❌ not supported
//         spam_server: false,
//         evidence: [],
//         compromised: false,
//     };
//
//     if (ipqsData.malware || ipqsData.hosted_content) {
//         detected.malware_hosting = true;
//         detected.evidence.push('Malware Hosting');
//     }
//
//     if (ipqsData.phishing) {
//         detected.evidence.push('Phishing');
//     }
//
//     if (ipqsData.spamming) {
//         detected.spam_server = true;
//         detected.evidence.push('Spam Server');
//     }
//
//     detected.compromised =
//         detected.malware_hosting ||
//         detected.spam_server ||
//         ipqsData.unsafe;
//
//     return detected;
// };
//
// const getVendorRisk = (compromised, score) =>
//     compromised || score >= 50 ? 'FLAGGED' : 'PASS';
//
// const getFraudComplianceFlag = (compromised, score) =>
//     compromised && score >= 30 ? 'YES' : 'NO';
//
// const fetchIPQSData = async (domain) => {
//     const response = await axios.get(
//         `${IPQS_URL}/${process.env.IPQS_API_KEY}/${encodeURIComponent(domain)}`,
//         { timeout: 10000 }
//     );
//     return response.data || {};
// };
//
// export const getCyberRisk = async (req, res, next) => {
//     const { companyName, domain, session_id, ens_id } = req.query;
//
//     console.log(
//         `[cyberRisk] company="${companyName}" domain="${domain}" ens=${ens_id} session=${session_id}`
//     );
//
//     try {
//         // ── Call IPQualityScore ──────────────────────────────────────────────
//         const ipqsData = await fetchIPQSData(domain);
//
//         if (ipqsData.success === false) {
//             return res.status(400).json({
//                 status: 400,
//                 message: 'IPQualityScore scan failed',
//                 data: null,
//             });
//         }
//
//         // ── Analyse ──────────────────────────────────────────────────────────
//         const { score, level } = getCyberRiskScore(ipqsData.risk_score);
//         const compromisedSystems = detectCompromisedSystems(ipqsData);
//         const vendorFlag = getVendorRisk(compromisedSystems.compromised, score);
//         const fraudFlag = getFraudComplianceFlag(
//             compromisedSystems.compromised,
//             score
//         );
//
//         // ── Build cyber_risk object (SAME SHAPE AS BEFORE) ───────────────────
//         const cyberRiskObject = {
//             resolved_ip: ipqsData.ip_address ?? null,
//             cyber_risk_score: score,
//             cyber_risk_level: level,
//             botnet: compromisedSystems.botnet,
//             malware_hosting: compromisedSystems.malware_hosting,
//             command_and_control: compromisedSystems.command_and_control,
//             spam_server: compromisedSystems.spam_server,
//             compromised: compromisedSystems.compromised,
//             evidence: compromisedSystems.evidence,
//             vendor_cyber_risk: vendorFlag,
//             fraud_compliance_red_flag: fraudFlag,
//         };
//
//         // ── Store in DB ──────────────────────────────────────────────────────
//         const dbResult = await updateTable(
//             'external_supplier_data',
//             { cyber_risk: JSON.stringify(cyberRiskObject) },
//             ens_id,
//             session_id
//         );
//
//         if (!dbResult.success) {
//             console.warn(
//                 `[cyberRisk] No record for ens=${ens_id} session=${session_id}`
//             );
//             return res.status(400).json({
//                 status: 400,
//                 message: 'No record found to update',
//                 data: null,
//             });
//         }
//
//         console.log(
//             `[cyberRisk] Stored for ens=${ens_id}, level=${level}`
//         );
//
//         return res.status(200).json({
//             status: 200,
//             message: 'Cyber risk analysis completed',
//             data: cyberRiskObject,
//         });
//     } catch (error) {
//         console.error(
//             '[cyberRisk] Error:',
//             error?.response?.data ?? error.message
//         );
//         next(error);
//     }
// };
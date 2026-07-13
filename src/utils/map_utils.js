import axios from "axios";
import "dotenv/config";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import * as fs from 'fs';
import * as path from 'path';
import {
  uploadImageBufferToAzure,
  checkImageExistsInAzure,
} from "./blob_utils.js";

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PLACE_PHOTO_MAX_WIDTH = 1200;
const PLACE_SEARCH_RADIUS_METERS = 1500;
const PLACE_FIND_BIAS_RADIUS_METERS = 10000;
const PLACE_MAX_ACCEPTED_DISTANCE_METERS = 120;
const PLACE_EXTENDED_ACCEPTED_DISTANCE_METERS = 1500;
const PLACE_TEXT_MATCH_ACCEPTED_DISTANCE_METERS = 10000;
const PLACE_MIN_NAME_SCORE = 0.55;
const PLACE_STRONG_NAME_SCORE = 0.8;
const PLACE_EXTENDED_MIN_ADDRESS_SCORE = 0.2;
const PLACE_MEDIUM_ADDRESS_SCORE = 0.4;
const PLACE_STRONG_ADDRESS_SCORE = 0.75;
const PLACE_POSTAL_OVERRIDE_ADDRESS_SCORE = 0.8;
const PLACE_MIN_CONFIDENCE_SCORE = 0.65;
const COMPANY_WORDS = new Set([
  "limited",
  "ltd",
  "private",
  "pvt",
  "company",
  "co",
  "corp",
  "corporation",
  "inc",
  "llp",
  "llc",
]);
const ADDRESS_STOP_WORDS = new Set([
  "road",
  "rd",
  "street",
  "st",
  "lane",
  "ln",
  "near",
  "opp",
  "opposite",
  "floor",
  "building",
  "block",
  "sector",
  "plot",
  "unit",
  "india",
]);

export const RADIUS = 100;
export const NORMALIZATION_FACTOR = 10;

export const POI_WEIGHTS = {
  bank: 3.0,
  office: 3.0,
  business_center: 3.0,
  atm: 2.5,
  restaurant: 2.0,
  store: 2.0,
  clinic: 2.0,
  hospital: 2.0,
  hotel: 2.0,
  cafe: 2.0,
  apartment: -1.5,
  school: -1.0,
  place_of_worship: -1.0,
  park: -0.5,
};

export const DENSITY_THRESHOLDS = {
  STRONG_COMMERCIAL: 0.75,
  MIXED_USE: 0.45,
  MOSTLY_RESIDENTIAL: 0.20,
};

// ─────────────────────────────────────────────
// Math Helpers
// ─────────────────────────────────────────────

export const toRadians = (degrees) => (degrees * Math.PI) / 180;
export const toDegrees = (radians) => (radians * 180) / Math.PI;

export const calculateBearing = (fromLat, fromLng, toLat, toLng) => {
  const phiOne = toRadians(fromLat);
  const phiTwo = toRadians(toLat);
  const deltaLambda = toRadians(toLng - fromLng);
  const y = Math.sin(deltaLambda) * Math.cos(phiTwo);
  const x =
      Math.cos(phiOne) * Math.sin(phiTwo) -
      Math.sin(phiOne) * Math.cos(phiTwo) * Math.cos(deltaLambda);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
};

export const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const normalizeSearchText = (value = "") =>
    String(value)
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const tokenizeName = (value = "") =>
    normalizeSearchText(value)
        .split(" ")
        .filter((token) => token.length > 2 && !COMPANY_WORDS.has(token));

const tokenizeAddress = (value = "") =>
    normalizeSearchText(value)
        .split(" ")
        .filter((token) => token.length > 2 && !ADDRESS_STOP_WORDS.has(token));

const tokenOverlapScore = (expectedTokens, actualTokens) => {
  if (!expectedTokens.length || !actualTokens.length) return 0;

  const actual = new Set(actualTokens);
  const overlap = expectedTokens.filter((token) => actual.has(token)).length;
  return overlap / expectedTokens.length;
};

const nameSimilarityScore = (expectedName, actualName) => {
  const expected = normalizeSearchText(expectedName);
  const actual = normalizeSearchText(actualName);

  if (!expected || !actual) return 0;
  if (expected === actual) return 1;
  if (expected.includes(actual) || actual.includes(expected)) return 0.9;

  return tokenOverlapScore(tokenizeName(expectedName), tokenizeName(actualName));
};

const addressSimilarityScore = (expectedAddress, actualAddress) => {
  const expectedTokens = tokenizeAddress(expectedAddress);
  const actualTokens = tokenizeAddress(actualAddress);
  return tokenOverlapScore(expectedTokens.slice(0, 10), actualTokens);
};

const isPlaceholderPostalCode = (code = "") => {
  const normalized = String(code).replace(/\D/g, "");
  return !normalized || /^0+$/.test(normalized) || /^9+$/.test(normalized);
};

const extractPostalCodes = (value = "") =>
    (String(value).match(/\b\d{5,6}(?:-\d{4})?\b/g) || [])
        .filter((code) => !isPlaceholderPostalCode(code));

const postalCodesConflict = (expectedAddress, actualAddress) => {
  const expectedCodes = extractPostalCodes(expectedAddress);
  const actualCodes = extractPostalCodes(actualAddress);

  if (!expectedCodes.length || !actualCodes.length) return false;
  return !expectedCodes.some((code) => actualCodes.includes(code));
};

const getCandidateLocation = (candidate) => candidate?.geometry?.location || null;

const getAddressScoreRank = (score) => {
  if (score >= PLACE_STRONG_ADDRESS_SCORE) return 0;
  if (score >= PLACE_MEDIUM_ADDRESS_SCORE) return 1;
  return 2;
};

const scorePlaceCandidate = (candidate, expectedName, expectedAddress, lat, lng) => {
  const location = getCandidateLocation(candidate);
  const distanceMeters = location
      ? haversineDistance(lat, lng, location.lat, location.lng)
      : Number.POSITIVE_INFINITY;
  const nameScore = nameSimilarityScore(expectedName, candidate?.name);
  const addressScore = addressSimilarityScore(expectedAddress, candidate?.formatted_address || candidate?.vicinity);
  const distanceScore = Number.isFinite(distanceMeters)
      ? Math.max(0, 1 - distanceMeters / PLACE_MAX_ACCEPTED_DISTANCE_METERS)
      : 0;
  const hasPostalConflict = postalCodesConflict(expectedAddress, candidate?.formatted_address || candidate?.vicinity);
  const hasPhotos = !!candidate?.photos?.length;
  const canOverridePostalConflict =
      hasPostalConflict &&
      nameScore >= PLACE_STRONG_NAME_SCORE &&
      addressScore >= PLACE_POSTAL_OVERRIDE_ADDRESS_SCORE;
  const isNearAddress = distanceMeters <= PLACE_MAX_ACCEPTED_DISTANCE_METERS;
  const isExtendedCampusMatch =
      distanceMeters <= PLACE_EXTENDED_ACCEPTED_DISTANCE_METERS &&
      nameScore >= PLACE_STRONG_NAME_SCORE &&
      addressScore >= PLACE_EXTENDED_MIN_ADDRESS_SCORE &&
      (!hasPostalConflict || canOverridePostalConflict);
  const isStrongTextMatch =
      distanceMeters <= PLACE_TEXT_MATCH_ACCEPTED_DISTANCE_METERS &&
      nameScore >= PLACE_STRONG_NAME_SCORE &&
      addressScore >= PLACE_STRONG_ADDRESS_SCORE &&
      (!hasPostalConflict || canOverridePostalConflict);
  const confidenceScore = isStrongTextMatch
      ? (nameScore * 0.55) + (addressScore * 0.4) + (distanceScore * 0.05) - (canOverridePostalConflict ? 0.05 : 0)
      : isExtendedCampusMatch
      ? (nameScore * 0.7) + (addressScore * 0.2) + (distanceScore * 0.1) - (canOverridePostalConflict ? 0.05 : 0)
      : (nameScore * 0.55) + (distanceScore * 0.3) + (addressScore * 0.15) - (canOverridePostalConflict ? 0.05 : 0);

  const rejectionReason = hasPostalConflict && !canOverridePostalConflict
      ? "POSTAL_CODE_MISMATCH"
      : !isNearAddress && !isExtendedCampusMatch && !isStrongTextMatch
          ? "TOO_FAR_FROM_GEOCODED_ADDRESS"
          : nameScore < PLACE_MIN_NAME_SCORE
              ? "NAME_MISMATCH"
              : confidenceScore < PLACE_MIN_CONFIDENCE_SCORE
                  ? "LOW_CONFIDENCE"
                  : null;

  return {
    placeId: candidate?.place_id,
    placeName: candidate?.name || null,
    placeAddress: candidate?.formatted_address || candidate?.vicinity || null,
    distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null,
    location: location ? { lat: location.lat, lng: location.lng } : null,
    nameScore: Number(nameScore.toFixed(3)),
    addressScore: Number(addressScore.toFixed(3)),
    confidenceScore: Number(confidenceScore.toFixed(3)),
    matchMode: isNearAddress
        ? "near_address"
        : isExtendedCampusMatch
            ? "extended_campus"
            : isStrongTextMatch
                ? "strong_text_match"
                : "rejected",
    hasPhotos,
    postalCodeMismatch: hasPostalConflict,
    postalCodeMismatchOverridden: canOverridePostalConflict,
    rejected: !!rejectionReason,
    rejectionReason,
  };
};

// ─────────────────────────────────────────────
// POI Helpers
// ─────────────────────────────────────────────

export const getPoiWeight = (types) => {
  for (const type of types) {
    if (POI_WEIGHTS[type] !== undefined) return POI_WEIGHTS[type];
  }
  return null;
};

export const getDistanceFactor = (distance) => 1 - distance / RADIUS;

export const classifyDensity = (densityIndex) => {
  if (densityIndex >= DENSITY_THRESHOLDS.STRONG_COMMERCIAL) return "Strong Commercial Area";
  if (densityIndex >= DENSITY_THRESHOLDS.MIXED_USE) return "Mixed Use";
  if (densityIndex >= DENSITY_THRESHOLDS.MOSTLY_RESIDENTIAL) return "Mostly Residential";
  return "Residential";
};

export const computeDensityScore = (pois, originLat, originLng) => {
  if (!pois?.length) return { totalScore: 0, breakdown: [] };

  const breakdown = [];
  let totalScore = 0;

  for (const poi of pois) {
    const poiLat = poi.geometry.location.lat;
    const poiLng = poi.geometry.location.lng;
    const distance = haversineDistance(originLat, originLng, poiLat, poiLng);
    if (distance > RADIUS) continue;

    const weight = getPoiWeight(poi.types);
    if (weight === null) continue;

    const distanceFactor = getDistanceFactor(distance);
    const score = weight * distanceFactor;
    totalScore += score;
    breakdown.push({
      name: poi.name,
      types: poi.types,
      distance: Math.round(distance),
      weight,
      distanceFactor: parseFloat(distanceFactor.toFixed(3)),
      score: parseFloat(score.toFixed(3)),
    });
  }

  return { totalScore, breakdown };
};

// ─────────────────────────────────────────────
// API Calls
// ─────────────────────────────────────────────

export const geocodeAddress = async (address) => {
  if (!address) throw new Error("Address is required for geocoding");
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      { params: { address, key: API_KEY } }
  );
  if (!response.data) throw new Error("Empty response from Geocoding API");
  return response.data;
};

export const getStreetViewMetadata = async (lat, lng) => {
  if (lat === undefined || lng === undefined)
    throw new Error("lat and lng are required for Street View metadata");
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/streetview/metadata`,
      { params: { location: `${lat},${lng}`, source: "outdoor", key: API_KEY } }
  );
  if (!response.data) throw new Error("Empty response from Street View Metadata API");
  return response.data;
};

export const fetchPlaceId = async (name, address) => {
  if (!name || !address) throw new Error("Name and address are required to fetch place ID");
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`,
      {
        params: {
          input: `${name} ${address}`,
          inputtype: "textquery",
          fields: "place_id",
          key: API_KEY,
        },
      }
  );
  if (!response.data) throw new Error("Empty response from Places FindPlace API");
  return response.data;
};

const fetchPlaceDetailsForImageMatch = async (placeId) => {
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/details/json`,
      {
        params: {
          place_id: placeId,
          fields: "place_id,name,formatted_address,geometry,photos,types",
          key: API_KEY,
        },
      }
  );

  if (!response.data) throw new Error("Empty response from Places Details API");
  if (response.data.status !== "OK") return null;

  return response.data.result;
};

const fetchNearbyBusinessCandidates = async (name, lat, lng) => {
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json`,
      {
        params: {
          location: `${lat},${lng}`,
          radius: PLACE_SEARCH_RADIUS_METERS,
          keyword: name,
          key: API_KEY,
        },
      }
  );

  if (!response.data) throw new Error("Empty response from Places Nearby Search API");
  return response.data.results || [];
};

const fetchFindPlaceCandidates = async (name, address, lat, lng) => {
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`,
      {
        params: {
          input: `${name} ${address}`,
          inputtype: "textquery",
          fields: "place_id,name,formatted_address,geometry,photos",
          locationbias: `circle:${PLACE_FIND_BIAS_RADIUS_METERS}@${lat},${lng}`,
          key: API_KEY,
        },
      }
  );

  if (!response.data) throw new Error("Empty response from Places FindPlace API");
  return response.data.candidates || [];
};

export const findValidatedPlacePhotoCandidate = async (name, address, lat, lng) => {
  if (!name || !address || lat === undefined || lng === undefined) {
    return {
      accepted: false,
      status: "MISSING_NAME_OR_ADDRESS",
      candidate: null,
      bestScore: null,
      evaluated: [],
    };
  }

  const [nearbyCandidates, findPlaceCandidates] = await Promise.all([
    fetchNearbyBusinessCandidates(name, lat, lng).catch((error) => {
      console.warn("[PlacesImages] Nearby search failed", { error: error?.message });
      return [];
    }),
    fetchFindPlaceCandidates(name, address, lat, lng).catch((error) => {
      console.warn("[PlacesImages] Find Place search failed", { error: error?.message });
      return [];
    }),
  ]);

  const byPlaceId = new Map();
  for (const candidate of [...nearbyCandidates, ...findPlaceCandidates]) {
    if (candidate?.place_id && !byPlaceId.has(candidate.place_id)) {
      byPlaceId.set(candidate.place_id, candidate);
    }
  }

  const candidates = [];
  for (const candidate of [...byPlaceId.values()].slice(0, 8)) {
    const details = await fetchPlaceDetailsForImageMatch(candidate.place_id).catch((error) => {
      console.warn("[PlacesImages] Place details failed", {
        placeId: candidate.place_id,
        error: error?.message,
      });
      return null;
    });

    candidates.push(details || candidate);
  }

  const evaluated = candidates
      .map((candidate) => ({
        candidate,
        score: scorePlaceCandidate(candidate, name, address, lat, lng),
      }))
      .sort((a, b) => {
        const modeRank = { near_address: 0, strong_text_match: 1, extended_campus: 2, rejected: 3 };
        const rejectionDiff = Number(a.score.rejected) - Number(b.score.rejected);
        if (rejectionDiff !== 0) return rejectionDiff;

        const addressRankDiff = getAddressScoreRank(a.score.addressScore) - getAddressScoreRank(b.score.addressScore);
        if (addressRankDiff !== 0) return addressRankDiff;

        const modeDiff = modeRank[a.score.matchMode] - modeRank[b.score.matchMode];
        if (modeDiff !== 0) return modeDiff;

        const addressDiff = b.score.addressScore - a.score.addressScore;
        if (addressDiff !== 0) return addressDiff;

        const distanceA = a.score.distanceMeters ?? Number.POSITIVE_INFINITY;
        const distanceB = b.score.distanceMeters ?? Number.POSITIVE_INFINITY;
        if (distanceA !== distanceB) return distanceA - distanceB;

        const nameDiff = b.score.nameScore - a.score.nameScore;
        if (nameDiff !== 0) return nameDiff;

        return b.score.confidenceScore - a.score.confidenceScore;
      });

  const bestAccepted = evaluated.find(({ score }) => !score.rejected);
  const bestRejected = evaluated[0];

  if (!bestAccepted) {
    return {
      accepted: false,
      status: bestRejected?.score.rejectionReason || "NO_PLACE_CANDIDATES",
      candidate: null,
      bestScore: bestRejected?.score || null,
      evaluated: evaluated.map(({ score }) => score),
    };
  }

  return {
    accepted: true,
    status: "OK",
    candidate: bestAccepted.candidate,
    bestScore: bestAccepted.score,
    evaluated: evaluated.map(({ score }) => score),
  };
};

export const getPlaceRatingAndReviews = async (placeId) => {
  if (!placeId) throw new Error("placeId is required to fetch place details");
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/details/json`,
      {
        params: {
          place_id: placeId,
          fields: "rating,user_ratings_total,reviews",  // 👈 added reviews
          key: API_KEY,
        },
      }
  );
  if (!response.data) throw new Error("Empty response from Places Details API");
  return response.data;
};

export const fetchNearbyPOIs = async (lat, lng) => {
  if (lat === undefined || lng === undefined)
    throw new Error("lat and lng are required to fetch nearby POIs");
  const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json`,
      {
        params: {
          location: `${lat},${lng}`,
          radius: RADIUS,
          key: API_KEY,
        },
      }
  );
  if (!response.data) throw new Error("Empty response from Nearby Search API");
  return response.data;
};

// ─────────────────────────────────────────────
// URL Builders
// ─────────────────────────────────────────────

export const fetchSatelliteImageUrl = (lat, lng) => {
  if (lat === undefined || lng === undefined)
    throw new Error("lat and lng are required to build satellite image URL");
  return (
      `https://maps.googleapis.com/maps/api/staticmap` +
      `?center=${lat},${lng}&zoom=18&size=640x640&maptype=satellite&key=${API_KEY}`
  );
};

export const fetchStreetViewImageUrls = (pano_id, location, lat, lng) => {
  if (!pano_id) throw new Error("pano_id is required to build Street View URLs");
  if (!location?.lat || !location?.lng)
    throw new Error("location is required to build Street View URLs");
  const buildingHeading = calculateBearing(location.lat, location.lng, lat, lng);
  return {
    building:
        `https://maps.googleapis.com/maps/api/streetview` +
        `?size=640x640&pano=${pano_id}&heading=${buildingHeading}&pitch=5&fov=70&source=outdoor&return_error_code=true&key=${API_KEY}`,
    carDirection:
        `https://maps.googleapis.com/maps/api/streetview` +
        `?size=640x640&pano=${pano_id}&source=outdoor&return_error_code=true&key=${API_KEY}`,
  };
};

export const fetchPlacePhotoUrl = (photoReference, maxwidth = PLACE_PHOTO_MAX_WIDTH) => {
  if (!photoReference) throw new Error("photoReference is required to build Places Photo URL");
  return (
      `https://maps.googleapis.com/maps/api/place/photo` +
      `?maxwidth=${maxwidth}&photo_reference=${encodeURIComponent(photoReference)}&key=${API_KEY}`
  );
};

// ─────────────────────────────────────────────
// R2 Client
// ─────────────────────────────────────────────

const r2Client = new S3Client({
  endpoint: process.env.R2_STORAGE__STORAGE_ACCOUNT_URL,
  credentials: {
    accessKeyId: process.env.R2_STORAGE__ACCESS_KEY,
    secretAccessKey: process.env.R2_STORAGE__SECREATE_ACCOUNT_KEY,
  },
  region: "auto",
  forcePathStyle: true,
});

// ─────────────────────────────────────────────
// Buffer Helper
// ─────────────────────────────────────────────

export const fetchImageBuffer = async (url) => {
  if (!url) throw new Error("URL is required to fetch image buffer");
  const response = await axios.get(url, { responseType: "arraybuffer" });
  if (!response.data) throw new Error(`Failed to fetch image from ${url}`);
  return Buffer.from(response.data);
};

// ─────────────────────────────────────────────
// Local Storage Helper
// ─────────────────────────────────────────────

const LOCAL_IMAGES_DIR = path.resolve(process.cwd(), "local_images");

export const saveImageLocally = (ens_id, fileName, buffer) => {
  fs.mkdirSync(LOCAL_IMAGES_DIR, { recursive: true });
  const filePath = path.join(LOCAL_IMAGES_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  console.log(`Saved locally: ${filePath}`);
  return filePath;
};

// ─────────────────────────────────────────────
// R2 Helpers
// ─────────────────────────────────────────────

export const uploadBufferToR2 = async (fileName, buffer, contentType = "image/jpeg") => {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_STORAGE__IMAGE_CONTAINER_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
  });
  await r2Client.send(command);
  return fileName;
};

export const checkEnsIdInR2 = async (ens_id) => {
  try {
    const bucket = process.env.R2_STORAGE__IMAGE_CONTAINER_NAME;

    const keys = {
      satellite: `${ens_id}_satellite.jpg`,
      building: `${ens_id}_building.jpg`,
      street: `${ens_id}_street.jpg`,
    };

    const [satelliteExists, buildingExists, streetExists] = await Promise.all([
      r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: keys.satellite }))
          .then(() => true).catch(() => false),
      r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: keys.building }))
          .then(() => true).catch(() => false),
      r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: keys.street }))
          .then(() => true).catch(() => false),
    ]);

    console.log(`R2 check for ens_id "${ens_id}":`, { satelliteExists, buildingExists, streetExists });

    if (!satelliteExists && !buildingExists && !streetExists) return null;

    return {
      ens_id,
      images: {
        satellite: satelliteExists ? { key: keys.satellite } : null,
        streetView: {
          building: buildingExists ? { key: keys.building } : null,
          carDirection: streetExists ? { key: keys.street } : null,
        },
      },
    };
  } catch (error) {
    console.error("Error checking ens_id in R2:", error.message);
    return null;
  }
};

// ─────────────────────────────────────────────
// Image Upload to R2 + Local
// ─────────────────���───────────────────────────

export const uploadSatelliteImageToAzure = async (lat, lng, ens_id) => {
  const url = fetchSatelliteImageUrl(lat, lng);
  const buffer = await fetchImageBuffer(url);
  const fileName = `${ens_id}_satellite.jpg`;

  // const [azureUpload, localPath] = await Promise.all([
  //   uploadImageBufferToAzure(fileName, buffer, "image/jpeg"),
  //   Promise.resolve(saveImageLocally(ens_id, fileName, buffer)),
  // ]);
  const [azureUpload] = await Promise.all([
    uploadImageBufferToAzure(fileName, buffer, "image/jpeg"),
  ]);

  return {
    key: azureUpload.blobName,
    url: azureUpload.url,
  };
};

export const uploadStreetViewImagesToAzure = async (pano_id, location, lat, lng, ens_id) => {
  const urls = fetchStreetViewImageUrls(pano_id, location, lat, lng);

  const [buildingBuffer, carBuffer] = await Promise.all([
    fetchImageBuffer(urls.building),
    fetchImageBuffer(urls.carDirection),
  ]);

  const buildingFileName = `${ens_id}_building.jpg`;
  const streetFileName = `${ens_id}_street.jpg`;

  const [buildingUpload, streetUpload] = await Promise.all([
    uploadImageBufferToAzure(buildingFileName, buildingBuffer, "image/jpeg"),
    uploadImageBufferToAzure(streetFileName, carBuffer, "image/jpeg"),
  ]);

  // const buildingLocalPath = saveImageLocally(ens_id, buildingFileName, buildingBuffer);
  // const streetLocalPath = saveImageLocally(ens_id, streetFileName, carBuffer);

  return {
    building: {
      key: buildingUpload.blobName,
      url: buildingUpload.url,
    },
    carDirection: {
      key: streetUpload.blobName,
      url: streetUpload.url,
    },
  };
};

export const uploadPlaceImagesToAzure = async (name, address, lat, lng, ens_id) => {
  const match = await findValidatedPlacePhotoCandidate(name, address, lat, lng);

  if (!match.accepted || !match.candidate?.photos?.length) {
    return {
      building: null,
      carDirection: null,
      source: "google_places",
      status: match.accepted ? "NO_PHOTOS" : match.status,
      placeId: match.candidate?.place_id || null,
      placeName: match.candidate?.name || null,
      placeAddress: match.candidate?.formatted_address || match.candidate?.vicinity || null,
      placeLocation: getCandidateLocation(match.candidate),
      match: match.bestScore,
      evaluated: match.evaluated,
    };
  }

  const [buildingPhoto, streetPhoto] = match.candidate.photos;
  const buildingBuffer = await fetchImageBuffer(fetchPlacePhotoUrl(buildingPhoto.photo_reference));
  const buildingFileName = `${ens_id}_building.jpg`;
  const buildingUpload = await uploadImageBufferToAzure(buildingFileName, buildingBuffer, "image/jpeg");

  let streetUpload = null;
  if (streetPhoto?.photo_reference) {
    const streetBuffer = await fetchImageBuffer(fetchPlacePhotoUrl(streetPhoto.photo_reference));
    const streetFileName = `${ens_id}_street.jpg`;
    streetUpload = await uploadImageBufferToAzure(streetFileName, streetBuffer, "image/jpeg");
  }

  return {
    building: {
      key: buildingUpload.blobName,
      url: buildingUpload.url,
      photoReference: buildingPhoto.photo_reference,
    },
    carDirection: streetUpload
        ? {
          key: streetUpload.blobName,
          url: streetUpload.url,
          photoReference: streetPhoto.photo_reference,
        }
        : null,
    source: "google_places",
    status: "OK",
    placeId: match.candidate.place_id,
    placeName: match.candidate.name,
    placeAddress: match.candidate.formatted_address || match.candidate.vicinity || null,
    placeLocation: getCandidateLocation(match.candidate),
    match: match.bestScore,
  };
};

export const uploadSatelliteImageToR2 = async (lat, lng, ens_id) => {
  const url = fetchSatelliteImageUrl(lat, lng);
  const buffer = await fetchImageBuffer(url);
  const fileName = `${ens_id}_satellite.jpg`;
  const [key, localPath] = await Promise.all([
    uploadBufferToR2(fileName, buffer, "image/jpeg"),
    Promise.resolve(saveImageLocally(ens_id, fileName, buffer)),
  ]);
  return { key, localPath };
};

export const uploadStreetViewImagesToR2 = async (pano_id, location, lat, lng, ens_id) => {
  const urls = fetchStreetViewImageUrls(pano_id, location, lat, lng);
  const [buildingBuffer, carBuffer] = await Promise.all([
    fetchImageBuffer(urls.building),
    fetchImageBuffer(urls.carDirection),
  ]);

  const buildingFileName = `${ens_id}_building.jpg`;
  const streetFileName = `${ens_id}_street.jpg`;

  const [buildingKey, carKey] = await Promise.all([
    uploadBufferToR2(buildingFileName, buildingBuffer, "image/jpeg"),
    uploadBufferToR2(streetFileName, carBuffer, "image/jpeg"),
  ]);

  const buildingLocalPath = saveImageLocally(ens_id, buildingFileName, buildingBuffer);
  const carLocalPath = saveImageLocally(ens_id, streetFileName, carBuffer);

  return {
    building: { key: buildingKey, localPath: buildingLocalPath },
    carDirection: { key: carKey, localPath: carLocalPath },
  };
};

// ─────────────────────────────────────────────
// Upload a raw file to Cloudflare R2
// ─────────────────────────────────────────────

const uploadToR2 = async (filePath, fileName) => {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
      Bucket: process.env.R2_STORAGE__STORAGE_CONTAINER_NAME,
      Key: fileName,
      Body: fileBuffer,
    });
    await r2Client.send(command);
    console.log(`Uploaded to R2: ${fileName}`);
    return `${process.env.R2_STORAGE__STORAGE_ACCOUNT_URL}/${process.env.R2_STORAGE__STORAGE_CONTAINER_NAME}/${fileName}`;
  } catch (error) {
    console.error(`Error uploading ${fileName} to R2:`, error);
    throw error;
  }
};

// ─────────────────────────────────────────────
// Upload Report (DOCX + PDF) to R2
// Path: {session_id}/{ens_id}/{fileName}.docx|pdf
// ─────────────────────────────────────────────

export const uploadReportToR2 = async (docxPath, pdfPath, session_id, ens_id, fileName) => {
  const bucket = process.env.R2_STORAGE__STORAGE_CONTAINER_NAME;

  const sessionPrefix = `${session_id}/`;
  const ensPrefix = `${session_id}/${ens_id}/`;

  // Ensure session_id folder exists
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${sessionPrefix}.keep` }));
    console.log(`Session folder already exists: ${sessionPrefix}`);
  } catch {
    await r2Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${sessionPrefix}.keep`,
      Body: Buffer.alloc(0),
    }));
    console.log(`Created session folder: ${sessionPrefix}`);
  }

  // Ensure ens_id folder exists
  try {
    await r2Client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${ensPrefix}.keep` }));
    console.log(`ENS folder already exists: ${ensPrefix}`);
  } catch {
    await r2Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${ensPrefix}.keep`,
      Body: Buffer.alloc(0),
    }));
    console.log(`Created ENS folder: ${ensPrefix}`);
  }

  const docxBuffer = fs.readFileSync(docxPath);
  const pdfBuffer = fs.readFileSync(pdfPath);

  const docxKey = `${ensPrefix}${fileName}.docx`;
  const pdfKey  = `${ensPrefix}${fileName}.pdf`;

  await Promise.all([
    r2Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: docxKey,
      Body: docxBuffer,
      ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })),
    r2Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: pdfKey,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    })),
  ]);

  console.log(`Uploaded DOCX: ${docxKey}`);
  console.log(`Uploaded PDF : ${pdfKey}`);

  return {
    docxKey,
    pdfKey,
    docxUrl: `${process.env.R2_STORAGE__STORAGE_ACCOUNT_URL}/${bucket}/${docxKey}`,
    pdfUrl:  `${process.env.R2_STORAGE__STORAGE_ACCOUNT_URL}/${bucket}/${pdfKey}`,
  };
};

export const checkEnsIdLocally = (ens_id) => {
  const satelliteFile = path.join(LOCAL_IMAGES_DIR, `${ens_id}_satellite.jpg`);
  const buildingFile  = path.join(LOCAL_IMAGES_DIR, `${ens_id}_building.jpg`);
  const streetFile    = path.join(LOCAL_IMAGES_DIR, `${ens_id}_street.jpg`);

  const satelliteExists = fs.existsSync(satelliteFile);
  const buildingExists  = fs.existsSync(buildingFile);
  const streetExists    = fs.existsSync(streetFile);

  if (!satelliteExists && !buildingExists && !streetExists) return null;

  return {
    ens_id,
    images: {
      satellite:  satelliteExists ? { localPath: satelliteFile } : null,
      streetView: {
        building:     buildingExists ? { localPath: buildingFile } : null,
        carDirection: streetExists   ? { localPath: streetFile }   : null,
      },
    },
  };
};

import pool from '../config/db.js';
const LAT_LNG_DELTA = 0.001; // ~100m

export async function getAddressZoneRowsByIdentifier(identifier) {
  if (!identifier) {
    throw new Error("identifier is required");
  }

  const query = `
    SELECT *
    FROM public.address_zone_master
    WHERE identifier = $1
      AND lat IS NOT NULL
      AND lng IS NOT NULL
      AND geocode_status = 'passed'
    ORDER BY updated_at DESC;
  `;

  const result = await pool.query(query, [identifier]);
  return result.rows || [];
}

export async function findMatchingAddressZone(identifier, lat, lng) {
  const rows = await getAddressZoneRowsByIdentifier(identifier);

  let fallback = null;

  for (const row of rows) {
    const latDiff = Math.abs(row.lat - lat);
    const lngDiff = Math.abs(row.lng - lng);

    if (latDiff <= LAT_LNG_DELTA && lngDiff <= LAT_LNG_DELTA) {
      // ✅ First preference: row WITH image_name
      if (row.image_name) {
        return row;
      }

      // ⚠️ Save as fallback if no image_name
      fallback = row;
    }
  }

  return fallback;
}

export async function updateByGeoId(tableName, data, geo_id) {
  if (!tableName || !geo_id || !data || Object.keys(data).length === 0) {
    throw new Error("Invalid input to updateByGeoId");
  }

  const columns = Object.keys(data);
  const values = Object.values(data);

  const setClause = columns
      .map((col, i) => `${col} = $${i + 1}`)
      .join(", ");

  const query = `
    UPDATE ${tableName}
    SET ${setClause}
    WHERE geo_id = $${columns.length + 1}
    RETURNING *;
  `;

  const result = await pool.query(query, [...values, geo_id]);
  return result.rows;
}

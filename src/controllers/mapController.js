import {
    geocodeAddress,
    getStreetViewMetadata,
    fetchPlaceId,
    getPlaceRatingAndReviews,
    fetchNearbyPOIs,
    uploadSatelliteImageToAzure,
    uploadPlaceImagesToAzure,
    uploadStreetViewImagesToAzure,
    computeDensityScore,
    classifyDensity,
    checkEnsIdLocally,
    RADIUS,
    NORMALIZATION_FACTOR,
    findMatchingAddressZone,
    updateByGeoId
} from "../utils/map_utils.js";
import { insertIntoTable, checkExistingRecord,updateTable } from "../utils/db_utils.js";
// ─────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────


import { v4 as uuidv4 } from "uuid";

/* ─────────────────────────────
   Helper: unique 6‑digit code
───────────────────────────── */
const generate6DigitCode = () =>
    Math.floor(100 + Math.random() * 900).toString();

/* ─────────────────────────────
   Controller
───────────────────────────── */
export const getAddressImages = async (req, res) => {
    const { address, identifier, sessionId, ensId } = req.query;
    const orgName = req.query.orgName || req.query.name || null;

    // Request-level context object so every log carries the same identifiers.
    // This makes debugging much easier when multiple requests happen together.
    const logContext = {
        identifier,
        ensId,
        sessionId,
        orgName,
        address,
    };

    console.info("[Images][START] Request received", logContext);

    try {
        /* ─────────────────────────────────────────────────────────────
           STEP 1: Validate incoming request parameters
           We fail early if critical fields are missing.
        ───────────────────────────────────────────────────────────── */
        if (!address || !identifier || !sessionId || !ensId) {
            console.warn("[Images][VALIDATION] Missing required query params", {
                ...logContext,
                missing: {
                    address: !address,
                    identifier: !identifier,
                    sessionId: !sessionId,
                    ensId: !ensId,
                },
            });

            return res.status(400).json({
                status: 400,
                message: "Missing required query parameters",
                details: {
                    address: !address ? "required" : null,
                    identifier: !identifier ? "required" : null,
                    sessionId: !sessionId ? "required" : null,
                    ensId: !ensId ? "required" : null,
                },
            });
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 2: Geocode the address
           Convert the input address into latitude and longitude.
           If geocoding fails, nothing after this can continue.
        ───────────────────────────────────────────────────────────── */
        console.info("[Images][STEP 2] Starting geocode", logContext);

        let geocodeData;
        try {
            geocodeData = await geocodeAddress(address);
            console.info("[Images][STEP 2] Geocode response received", {
                ...logContext,
                geocodeStatus: geocodeData?.status,
                resultCount: geocodeData?.results?.length || 0,
            });
        } catch (geocodeError) {
            console.error("[Images][STEP 2][ERROR] Geocode service failed", {
                ...logContext,
                error: geocodeError?.message,
                stack: geocodeError?.stack,
            });

            return res.status(500).json({
                status: 500,
                message: "Geocoding failed",
                details: geocodeError?.message,
            });
        }

        if (geocodeData?.status !== "OK" || !geocodeData?.results?.length) {
            console.warn("[Images][STEP 2][FAILED] Unable to geocode address", {
                ...logContext,
                geocodeStatus: geocodeData?.status,
                geocodeData,
            });

            return res.status(404).json({
                status: 404,
                message: "Unable to geocode address",
                details: geocodeData?.status || "No results found",
            });
        }

        const { lat, lng } = geocodeData.results[0].geometry.location;

        console.info("[Images][STEP 2][SUCCESS] Address geocoded successfully", {
            ...logContext,
            lat,
            lng,
        });

        /* ─────────────────────────────────────────────────────────────
           STEP 3: Try to find an existing DB row for nearby/same location
           If found and image_name exists, we can reuse cached images.
        ───────────────────────────────────────────────────────────── */
        console.info("[Images][STEP 3] Checking for matching address zone row", {
            ...logContext,
            lat,
            lng,
        });

        let matchedRow = null;
        try {
            matchedRow = await findMatchingAddressZone(identifier, lat, lng);

            console.info("[Images][STEP 3] Match lookup completed", {
                ...logContext,
                found: !!matchedRow,
                geo_id: matchedRow?.geo_id || null,
                image_name: matchedRow?.image_name || null,
            });
        } catch (matchError) {
            console.error("[Images][STEP 3][ERROR] Failed while finding matching address zone", {
                ...logContext,
                lat,
                lng,
                error: matchError?.message,
                stack: matchError?.stack,
            });

            return res.status(500).json({
                status: 500,
                message: "Failed while matching address zone",
                details: matchError?.message,
            });
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 4: If cached image exists, reuse it
           This is the fastest path. We also update external_supplier_data
           so the current ENS/session gets linked to the found image.
        ───────────────────────────────────────────────────────────── */
        if (matchedRow?.image_name) {
            console.info("[Images][STEP 4] Cached image found. Reusing existing image", {
                ...logContext,
                geo_id: matchedRow.geo_id,
                image_name: matchedRow.image_name,
            });

            try {
                await updateTable(
                    "external_supplier_data",
                    {
                        google_image_name: matchedRow.image_name,
                        identifier: identifier,
                    },
                    ensId,
                    sessionId
                );

                console.info("[Images][STEP 4][SUCCESS] external_supplier_data updated with cached image", {
                    ...logContext,
                    image_name: matchedRow.image_name,
                });
            } catch (updateError) {
                console.error("[Images][STEP 4][ERROR] Failed to update external_supplier_data with cached image", {
                    ...logContext,
                    image_name: matchedRow.image_name,
                    error: updateError?.message,
                    stack: updateError?.stack,
                });

                return res.status(500).json({
                    status: 500,
                    message: "Failed to save cached image reference",
                    details: updateError?.message,
                });
            }

            console.info("[Images][END] Request completed using cached DB image", {
                ...logContext,
                image_name: matchedRow.image_name,
                source: "DB",
            });

            return res.status(200).json({
                status: 200,
                data: {
                    identifier,
                    coordinates: { lat, lng },
                    image_name: matchedRow.image_name,
                    source: "DB",
                },
            });
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 5: No cached image found
           Generate a new image name/code for fresh uploads.
        ───────────────────────────────────────────────────────────── */
        const imageCode = generate6DigitCode();
        const imageName = `${identifier}_${imageCode}`;

        console.info("[Images][STEP 5] No cached image found. Generating new image assets", {
            ...logContext,
            imageCode,
            imageName,
        });

        /* ─────────────────────────────────────────────────────────────
           STEP 6: Upload satellite image
           This is considered a core step. If this fails, overall flow fails.
        ───────────────────────────────────────────────────────────── */
        let satellite = null;
        try {
            console.info("[Images][STEP 6] Uploading satellite image", {
                ...logContext,
                imageName,
                lat,
                lng,
            });

            satellite = await uploadSatelliteImageToAzure(lat, lng, imageName);

            console.info("[Images][STEP 6][SUCCESS] Satellite image uploaded", {
                ...logContext,
                imageName,
                satellite,
            });
        } catch (satelliteError) {
            console.error("[Images][STEP 6][ERROR] Satellite image upload failed", {
                ...logContext,
                imageName,
                lat,
                lng,
                error: satelliteError?.message,
                stack: satelliteError?.stack,
            });

            return res.status(500).json({
                status: 500,
                message: "Satellite image upload failed",
                details: satelliteError?.message,
            });
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 7: Try Street View metadata + upload
           This can be treated as optional/partial.
           If metadata is unavailable, we log and continue.
           If upload fails, we log and continue.
        ───────────────────────────────────────────────────────────── */
        let streetView = null;

        if (orgName) {
            try {
                console.info("[Images][STEP 7] Trying validated Google Places photos", {
                    ...logContext,
                    imageName,
                    lat,
                    lng,
                });

                streetView = await uploadPlaceImagesToAzure(orgName, address, lat, lng, imageName);

                console.info("[Images][STEP 7] Google Places photo result", {
                    ...logContext,
                    imageName,
                    source: streetView?.source,
                    status: streetView?.status,
                    placeId: streetView?.placeId || null,
                    placeName: streetView?.placeName || null,
                    match: streetView?.match || null,
                    hasBuilding: !!streetView?.building,
                    hasStreet: !!streetView?.carDirection,
                });
            } catch (placeImageError) {
                console.error("[Images][STEP 7][ERROR] Google Places photo flow failed", {
                    ...logContext,
                    imageName,
                    error: placeImageError?.message,
                    stack: placeImageError?.stack,
                });
            }
        } else {
            console.info("[Images][STEP 7] Skipping Google Places photos because orgName/name was not provided", {
                ...logContext,
                imageName,
            });
        }

        if (!streetView?.building) {
            let metadata = null;
            const placeLocation = streetView?.placeLocation || null;
            const fallbackLat = placeLocation?.lat ?? lat;
            const fallbackLng = placeLocation?.lng ?? lng;
            const fallbackCoordinateSource = placeLocation ? "google_place" : "geocoded_address";

            try {
                console.info("[Images][STEP 7][FALLBACK] Fetching Street View metadata", {
                    ...logContext,
                    imageName,
                    lat: fallbackLat,
                    lng: fallbackLng,
                    fallbackCoordinateSource,
                    placeId: streetView?.placeId || null,
                    placeName: streetView?.placeName || null,
                    placesStatus: streetView?.status || null,
                });

                metadata = await getStreetViewMetadata(fallbackLat, fallbackLng);

                console.info("[Images][STEP 7][FALLBACK] Street View metadata response received", {
                    ...logContext,
                    imageName,
                    metadataStatus: metadata?.status,
                    pano_id: metadata?.pano_id || null,
                });
            } catch (metadataError) {
                console.error("[Images][STEP 7][FALLBACK][ERROR] Street View metadata fetch failed", {
                    ...logContext,
                    imageName,
                    error: metadataError?.message,
                    stack: metadataError?.stack,
                });
            }

            if (metadata?.status === "OK") {
                try {
                    console.info("[Images][STEP 7][FALLBACK] Uploading Street View images", {
                        ...logContext,
                        imageName,
                        pano_id: metadata.pano_id,
                    });

                    streetView = {
                        ...(await uploadStreetViewImagesToAzure(
                            metadata.pano_id,
                            metadata.location,
                            fallbackLat,
                            fallbackLng,
                            imageName
                        )),
                        source: "google_street_view_fallback",
                        fallbackReason: streetView?.status || "PLACES_PHOTO_UNAVAILABLE",
                        fallbackCoordinateSource,
                        placeId: streetView?.placeId || null,
                        placeName: streetView?.placeName || null,
                        placeAddress: streetView?.placeAddress || null,
                        placeLocation,
                    };

                    console.info("[Images][STEP 7][FALLBACK][SUCCESS] Street View images uploaded", {
                        ...logContext,
                        imageName,
                        streetView,
                    });
                } catch (streetViewError) {
                    console.error("[Images][STEP 7][FALLBACK][ERROR] Street View upload failed", {
                        ...logContext,
                        imageName,
                        pano_id: metadata?.pano_id,
                        error: streetViewError?.message,
                        stack: streetViewError?.stack,
                    });
                }
            } else {
                console.warn("[Images][STEP 7][FALLBACK][SKIPPED] Street View not available for this location", {
                    ...logContext,
                    imageName,
                    metadataStatus: metadata?.status || "UNKNOWN",
                });
            }
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 8: Persist image name into address_zone_master
           - update existing row if matchedRow exists
           - insert new row otherwise
        ───────────────────────────────────────────────────────────── */
        try {
            if (matchedRow) {
                console.info("[Images][STEP 8] Updating existing address_zone_master row", {
                    ...logContext,
                    geo_id: matchedRow.geo_id,
                    image_name: imageName,
                });

                await updateByGeoId(
                    "address_zone_master",
                    {
                        image_name: imageName,
                        updated_at: new Date(),
                    },
                    matchedRow.geo_id
                );

                console.info("[Images][STEP 8][SUCCESS] Existing address_zone_master row updated", {
                    ...logContext,
                    geo_id: matchedRow.geo_id,
                    image_name: imageName,
                });
            } else {
                const newGeoId = uuidv4();

                console.info("[Images][STEP 8] Inserting new address_zone_master row", {
                    ...logContext,
                    geo_id: newGeoId,
                    image_name: imageName,
                    lat,
                    lng,
                });

                await insertIntoTable("address_zone_master", {
                    geo_id: newGeoId,
                    identifier,
                    address,
                    lat,
                    lng,
                    image_name: imageName,
                });

                console.info("[Images][STEP 8][SUCCESS] New address_zone_master row inserted", {
                    ...logContext,
                    geo_id: newGeoId,
                    image_name: imageName,
                });
            }
        } catch (persistAddressError) {
            console.error("[Images][STEP 8][ERROR] Failed to persist address_zone_master", {
                ...logContext,
                imageName,
                error: persistAddressError?.message,
                stack: persistAddressError?.stack,
            });

            return res.status(500).json({
                status: 500,
                message: "Failed to persist address zone data",
                details: persistAddressError?.message,
            });
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 9: Persist image name into external_supplier_data
           This links the generated image to the current ENS/session.
        ───────────────────────────────────────────────────────────── */
        try {
            console.info("[Images][STEP 9] Updating external_supplier_data with generated image", {
                ...logContext,
                imageName,
            });

            await updateTable(
                "external_supplier_data",
                {
                    google_image_name: imageName,
                    identifier: identifier
                },
                ensId,
                sessionId
            );

            console.info("[Images][STEP 9][SUCCESS] external_supplier_data updated", {
                ...logContext,
                imageName,
            });
        } catch (externalSupplierError) {
            console.error("[Images][STEP 9][ERROR] Failed to update external_supplier_data", {
                ...logContext,
                imageName,
                error: externalSupplierError?.message,
                stack: externalSupplierError?.stack,
            });

            return res.status(500).json({
                status: 500,
                message: "Failed to update supplier image reference",
                details: externalSupplierError?.message,
            });
        }

        /* ─────────────────────────────────────────────────────────────
           STEP 10: Final success response
           Flow completed successfully. Satellite is guaranteed here.
           Street View may be null if unavailable or failed.
        ───────────────────────────────────────────────────────────── */
        console.info("[Images][END][SUCCESS] Request completed successfully", {
            ...logContext,
            imageName,
            source: matchedRow ? "UPDATED" : "INSERTED",
            hasSatellite: !!satellite,
            hasStreetView: !!streetView,
        });

        return res.status(200).json({
            status: 200,
            data: {
                identifier,
                address,
                coordinates: { lat, lng },
                image_name: imageName,
                images: {
                    satellite,
                    streetView,
                },
                source: matchedRow ? "UPDATED" : "INSERTED",
            },
        });

    } catch (error) {
        console.error("[Images][FATAL] Unexpected failure in getAddressImages", {
            ...logContext,
            error: error?.message,
            stack: error?.stack,
        });

        return res.status(500).json({
            status: 500,
            message: "Internal server error",
            details: error?.message,
        });
    }
};

export const getPlaceDetails = async (req, res) => {
    const { name, address, identifier, identifier_type, entity_type } = req.query;
    console.info("[Places] Request received", { identifier, name });

    try {
        console.info("[Places] Checking DB cache");
        const existing = await checkExistingRecord("google_ratings", identifier);

        if (existing.exists) {
            console.info("[Places] Cache hit", { identifier });
            return res.status(200).json({
                success: true,
                source: "cache",
                data: existing.data,
            });
        }

        console.info("[Places] Fetching place ID from Google");
        const placeIdData = await fetchPlaceId(name, address);

        if (placeIdData.status !== "OK" || !placeIdData.candidates?.length) {
            console.warn("[Places] Place ID not found", { name, address });
            return res.status(404).json({
                status: 404,
                message: "Unable to find place",
            });
        }

        const placeId = placeIdData.candidates[0].place_id;
        console.info("[Places] Place ID found", { placeId });

        console.info("[Places] Fetching reviews and ratings");
        const placeData = await getPlaceRatingAndReviews(placeId);

        if (placeData.status !== "OK") {
            console.warn("[Places] Failed to fetch place details", { placeId });
            return res.status(404).json({
                status: 404,
                message: "Unable to fetch place details",
            });
        }

        console.info("[Places] Saving place details to DB");
        const { rating, user_ratings_total, reviews } = placeData.result;

        const safeReviews = Array.isArray(reviews) ? reviews : null;

        const dbResult = await insertIntoTable("google_ratings", {
            name,
            identifier,
            identifier_type,
            entity_type,
            rating: rating?.toString() ?? null,
            no_of_reviews: user_ratings_total?.toString() ?? null,
            reviews: safeReviews,
        });

        console.info("[Places] Completed successfully", { identifier });

        return res.status(200).json({
            success: true,
            source: "api",
            data: dbResult.data,
        });

    } catch (error) {
        console.error("[Places] Failed", {
            identifier,
            error: error.message,
        });

        return res.status(500).json({
            status: 500,
            message: "Internal server error",
        });
    }
};


export const getPoiDensity = async (req, res) => {
    try {
        const { name, address } = req.query;

        const geocodeData = await geocodeAddress(address);
        if (geocodeData.status !== "OK") {
            return res.status(404).json({
                status: 404,
                message: "Unable to geocode address",
                details: geocodeData.status,
            });
        }

        const { lat, lng } = geocodeData.results[0].geometry.location;

        const nearbyData = await fetchNearbyPOIs(lat, lng);
        if (nearbyData.status !== "OK" && nearbyData.status !== "ZERO_RESULTS") {
            return res.status(404).json({
                status: 404,
                message: "Unable to fetch nearby POIs",
                details: nearbyData.status,
            });
        }

        const pois = nearbyData.results ?? [];
        const { totalScore, breakdown } = computeDensityScore(pois, lat, lng);
        const densityIndex = parseFloat(Math.min(totalScore / NORMALIZATION_FACTOR, 1.0).toFixed(4));
        const classification = classifyDensity(densityIndex);

        return res.status(200).json({
            status: 200,
            data: {
                name,
                address,
                coordinates: { lat, lng },
                radius: RADIUS,
                totalPoisFound: pois.length,
                totalPoisScored: breakdown.length,
                totalScore: parseFloat(totalScore.toFixed(4)),
                densityIndex,
                classification,
                breakdown,
            },
        });
    } catch (error) {
        console.error("Error computing POI density:", error.message);
        return res.status(500).json({
            status: 500,
            message: "Internal server error",
            details: error.message,
        });
    }
};


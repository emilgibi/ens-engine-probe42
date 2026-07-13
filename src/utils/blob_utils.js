import { ContainerClient } from "@azure/storage-blob";
import * as fs from "fs";

const {
    AZURE_STORAGE_ACCOUNT_NAME,
    REPORTS_CONTAINER_NAME,
    REPORTS_SAS_TOKEN,
    IMAGES_CONTAINER_NAME,
    IMAGES_SAS_TOKEN,
} = process.env;

const normalizeSasToken = (token) => {
    if (!token) {
        throw new Error("Azure SAS token is missing");
    }
    return token.startsWith("?") ? token : `?${token}`;
};

const buildContainerUrl = (accountName, containerName, sasToken) => {
    if (!accountName || !containerName || !sasToken) {
        throw new Error("Missing Azure container configuration");
    }

    return `https://${accountName}.blob.core.windows.net/${containerName}${normalizeSasToken(sasToken)}`;
};

const reportsContainerClient = new ContainerClient(
    buildContainerUrl(
        AZURE_STORAGE_ACCOUNT_NAME,
        REPORTS_CONTAINER_NAME,
        REPORTS_SAS_TOKEN
    )
);

const imagesContainerClient = new ContainerClient(
    buildContainerUrl(
        AZURE_STORAGE_ACCOUNT_NAME,
        IMAGES_CONTAINER_NAME,
        IMAGES_SAS_TOKEN
    )
);

const streamToBuffer = async (readableStream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (data) => {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });
        readableStream.on("end", () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on("error", reject);
    });
};

/* -------------------------------------------------------------------------- */
/*                                REPORT UTILS                                */
/* -------------------------------------------------------------------------- */

export const uploadReportFileToAzure = async (filePath, blobName) => {
    try {
        const blobClient = reportsContainerClient.getBlockBlobClient(blobName);
        const fileBuffer = fs.readFileSync(filePath);

        await blobClient.uploadData(fileBuffer);
        return blobClient.url;
    } catch (error) {
        console.error(`Error uploading report file ${blobName} to Azure:`, error);
        throw error;
    }
};

export const uploadReportToAzure = async (
    docxPath,
    pdfPath,
    session_id,
    ens_id,
    fileName
) => {
    try {
        const docxBlobName = `${session_id}/${ens_id}/${fileName}.docx`;
        const pdfBlobName = `${session_id}/${ens_id}/${fileName}.pdf`;

        const [docxUrl, pdfUrl] = await Promise.all([
            uploadReportFileToAzure(docxPath, docxBlobName),
            uploadReportFileToAzure(pdfPath, pdfBlobName),
        ]);

        return {
            docxBlobName,
            pdfBlobName,
            docxUrl,
            pdfUrl,
        };
    } catch (error) {
        console.error("Error uploading report to Azure:", error);
        throw error;
    }
};

/* -------------------------------------------------------------------------- */
/*                                IMAGE UTILS                                 */
/* -------------------------------------------------------------------------- */

export const uploadImageBufferToAzure = async (
    blobName,
    buffer,
    contentType = "image/jpeg"
) => {
    try {
        const blobClient = imagesContainerClient.getBlockBlobClient(blobName);

        await blobClient.uploadData(buffer, {
            blobHTTPHeaders: {
                blobContentType: contentType,
            },
        });

        return {
            blobName,
            url: blobClient.url,
        };
    } catch (error) {
        console.error(`Error uploading image ${blobName} to Azure:`, error);
        throw error;
    }
};

export const uploadImageFileToAzure = async (
    filePath,
    blobName,
    contentType = "image/jpeg"
) => {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        return await uploadImageBufferToAzure(blobName, fileBuffer, contentType);
    } catch (error) {
        console.error(`Error uploading image file ${blobName} to Azure:`, error);
        throw error;
    }
};

export const downloadImageBufferFromAzure = async (blobName) => {
    try {
        const blobClient = imagesContainerClient.getBlockBlobClient(blobName);

        const downloadResponse = await blobClient.download();

        if (!downloadResponse.readableStreamBody) {
            throw new Error(`No stream returned for blob ${blobName}`);
        }

        return await streamToBuffer(downloadResponse.readableStreamBody);
    } catch (error) {
        console.error(`Error downloading image ${blobName} from Azure:`, error);
        throw error;
    }
};

export const getImageBlobClient = (blobName) => {
    return imagesContainerClient.getBlockBlobClient(blobName);
};

export const getImageUrlFromAzure = (blobName) => {
    return imagesContainerClient.getBlockBlobClient(blobName).url;
};

export const checkImageExistsInAzure = async (blobName) => {
    try {
        const blobClient = imagesContainerClient.getBlockBlobClient(blobName);
        return await blobClient.exists();
    } catch (error) {
        console.error(`Error checking image ${blobName} in Azure:`, error);
        throw error;
    }
};

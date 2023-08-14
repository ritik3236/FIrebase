import axios, { AxiosRequestConfig } from "axios";
import { https, logger } from "firebase-functions";
import * as admin from "firebase-admin";
import * as express from "express";

interface ZohoCredentials {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  AUTHORIZATION_CODE: string;
  ACCESS_TOKEN: string;
  REFRESH_TOKEN: string;
  ACCOUNTS_URL: string;
  API_DOMAIN: string;
  EXPIRY_TIME: number;
}

interface AccessTokenResponse {
  access_token: string;
  refresh_token: string;
  api_domain: string;
  token_type: string;
  expires_in: number;
}

interface ReqParams {
  phone: string
  tag: string,
  id: string,
  tagFilter: string,
}

const redirectUri = "https://www.zoho.com";
const apiUrl = "https://www.zohoapis.com/crm/v5";
const tokenUrl = "https://accounts.zoho.com/oauth/v2/token";

async function readDbData(): Promise<ZohoCredentials> {
  try {
    const snapshot = await dbRef.once("value");
    return snapshot.val();
  } catch (error) {
    logger.error("Error reading dbData from Firebase:", error);
    throw error;
  }
}

async function updateDbData(updates: Record<string, any>): Promise<void> {
  try {
    await dbRef.update(updates);
  } catch (error: any) {
    logger.error("Error updating database:", error.message);
    throw error;
  }
}

function generateApiRequestConfig(options: AxiosRequestConfig, token: string): AxiosRequestConfig {
  return {
    ...options,
    baseURL: apiUrl,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Zoho-oauthtoken ${token}`,
      ...(options.headers || {}),
    },
  };
}

async function getAccessToken(dbData: ZohoCredentials): Promise<void> {
  try {
    const payload = {
      client_id: dbData?.CLIENT_ID,
      client_secret: dbData?.CLIENT_ID,
      redirect_uri: redirectUri,
      code: dbData?.AUTHORIZATION_CODE,
      grant_type: "authorization_code",
    };
    const response = await axios.postForm<AccessTokenResponse>(tokenUrl, payload);

    const dbUpdates = {
      ACCESS_TOKEN: response.data.access_token,
      REFRESH_TOKEN: response.data.refresh_token,
      EXPIRY_TIME: Date.now() + response.data.expires_in * 1000,
    };

    await updateDbData(dbUpdates);
  } catch (error: any) {
    logger.error("Error fetching access token:", error.message);
    throw error;
  }
}

// Function to refresh the access token using the refresh token
async function refreshAccessToken(dbData: ZohoCredentials): Promise<void> {
  try {
    const payload = {
      client_id: dbData?.CLIENT_ID,
      client_secret: dbData?.CLIENT_SECRET,
      refresh_token: dbData?.REFRESH_TOKEN,
      grant_type: "refresh_token",
    };
    const response = await axios.postForm<AccessTokenResponse>(tokenUrl, payload);

    const dbUpdates: Record<string, any> = {
      ACCESS_TOKEN: response.data.access_token,
      EXPIRY_TIME: Date.now() + response.data.expires_in * 1000,
    };

    await updateDbData(dbUpdates);
  } catch (error: any) {
    logger.error("Error refreshing access token:", error.message);
    throw error;
  }
}

// Function to make a standard API request
async function makeApiRequest(options: AxiosRequestConfig): Promise<any> {
  const dbData = await readDbData();

  if (!dbData?.ACCESS_TOKEN || Date.now() >= (dbData.EXPIRY_TIME || 0)) {
    if (!dbData?.REFRESH_TOKEN) {
      await getAccessToken(dbData);
    } else {
      await refreshAccessToken(dbData);
    }
  }
  const latestDbData = await readDbData();
  const config = generateApiRequestConfig(options, latestDbData?.ACCESS_TOKEN);

  try {
    const response = await axios(config);
    return response.data;
  } catch (error: any) {
    logger.error("Error making API request:", error.message);
    throw error;
  }
}

async function findByLeadId(leadId: string): Promise<{ data: any }> {
  const options: AxiosRequestConfig = {
    method: "GET",
    url: `/Leads/${leadId}`,
  };
  const data = await makeApiRequest(options);
  logger.log("API Response | [findByLeadId]: ", data);

  return data;
}

async function findByPhone(phonePrefix: string): Promise<{ data: any }> {
  const options: AxiosRequestConfig = {
    method: "GET",
    url: "/Leads/search",
    params: {
      criteria: `Phone:starts_with:${phonePrefix}`,
      fields: "id,Phone,Full_Name,Tag",
    },
  };
  const data = await makeApiRequest(options);
  logger.log("API Response:[findByPhone]", data);

  return data;
}

async function updateLeadTag(leadId: string, tags: any): Promise<any> {
  const options: AxiosRequestConfig = {
    method: "PUT",
    url: `/Leads/${leadId}`,
    data: {
      data: [{ Tag: tags }],
    },
  };

  const data = await makeApiRequest(options);
  logger.log("API Response [updateLeadTag]: ", data);

  return data;
}

async function modifyLeadByLeadId(reqBody: ReqParams): Promise<number> {
  try {
    const { tag, tagFilter, id } = reqBody;
    const { data } = await findByLeadId(id);
    if (!data?.[0]) return 400;

    const tags = data[0].Tag || [];
    const updatedTags = tags.filter((tag: any) => !tag.name.startsWith(tagFilter));
    updatedTags.push({ name: tag });
    await updateLeadTag(data[0].id, updatedTags);
    return 200;
  } catch (error: any) {
    logger.error("Error modifying leads by id and tag:", error.message);
    throw error;
  }
}

async function modifyLeadsByPhoneAndTag(reqBody: ReqParams): Promise<number> {
  try {
    const { phone, tag, tagFilter } = reqBody;
    const { data } = await findByPhone(phone);
    if (!data) return 400;

    for (const lead of data) {
      const tags = lead.Tag || [];
      const updatedTags = tags.filter((tag: any) => !tag.name.startsWith(tagFilter));
      updatedTags.push({ name: tag });
      await updateLeadTag(lead.id, updatedTags);
    }

    return 200;
  } catch (error: any) {
    logger.error("Error modifying leads by phone and tag:", error.message);
    throw error;
  }
}

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.database();
const dbRef = db.ref("/configurations/zohoConfig");
const app = express();

app.use(express.json());

// Endpoint for modifying leads by phone number
app.post("/v5/", async (req, res) => {
  try {
    const { phone, tag, id } = req.body as ReqParams;
    let status = 400;

    if (phone && tag) {
      status = await modifyLeadsByPhoneAndTag(req.body);
    } else if (id && tag) {
      status = await modifyLeadByLeadId(req.body);
    } else {
      return res.status(400).send("Bad Request: Either Phone or Lead Id or tag is missing.");
    }

    if (status === 200) {
      return res.status(200).send("Leads modified successfully.");
    } else {
      return res.status(400).send("Error modifying leads.");
    }
  } catch (error) {
    logger.error(error);
    return res.status(500).send("Error modifying leads.");
  }
});

// noinspection JSUnusedGlobalSymbols
export const zohoApi = https.onRequest(app);

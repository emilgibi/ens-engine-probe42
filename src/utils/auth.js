import dotenv from "dotenv";
import axios from "axios";
dotenv.config();

export const OrbisGridLogin = () => {
  try {
    let data = JSON.stringify({
      "userId": process.env.GRID_USERNAME,
      "password": process.env.GRID_PASSWORD
    });
    let config = {
      method: 'post',
    maxBodyLength: Infinity,
      url: 'https://service.rdc.eu.com/oauth/login',
      headers: { 
        'Content-Type': 'application/json'
      },
      data : data
    };
    
    return axios(config)
    .then(function (response) {
      response = 
      global.access_token = response.data?.data?.access_token || null; // Store token
      console.log("global.access_token", global.access_token);
      return global.access_token;
    })
    .catch(function (error) {
      console.log("error__", error);
    });
  } catch (error) {
    console.error(" Error logging in:", error?.response?.data || error.message);
    return null;
  }
};

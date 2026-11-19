import { setCredentials, clearCredentials, setShoonyaCredentials, setShoonyaToken } from '../utilities/config-cache.js';
import { logger } from '../utilities/logger.js';
import { shoonyaLogin } from '../utilities/shoony-auth.js';
import { connectToDatabase } from '../db/mongodb.js';
export const setupConfig = async (req, res) => {
  try {
    const body = req.body;

    if (body.reset === true) {
      clearCredentials();
      return res.json({
        success: true,
        message: 'Credentials reset successfully - using environment variables',
      });
    }

    // Validate required fields
    const requiredFields = ['apiKey', 'clientId', 'secretKey', 'totpSecret', 'mpin'];
    const missingFields = requiredFields.filter((field) => !body[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        missingFields,
        requiredFields,
      });
    }

    setCredentials({
      apiKey: body.apiKey,
      clientId: body.clientId,
      secretKey: body.secretKey,
      totpSecret: body.totpSecret,
      mpin: body.mpin,
    });

    return res.json({
      success: true,
      message: 'Angel One credentials configured successfully (no expiration)',
    });
  } catch (error) {
    logger.error('[Config Setup] Error:', error.message);
    return res.status(500).json({
      error: 'Failed to configure credentials',
      message: error.message,
    });
  }
};


export const shoonyaSetupConfig = async (req, res) => {

  try {

    const {
      uid,
      password,
      totp,
      apiKey,
      clientId,
      secretCode
    } = req.body;

    // validations
    if (
      !uid ||
      !password ||
      !totp ||
      !apiKey ||
      !clientId
    ) {

      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const response = await shoonyaLogin({

      uid,

      password,

      totp,

      apiKey,

      clientId,


      imei: crypto.randomUUID(),

      userAgent: req.headers['user-agent'],
      secretCode
    });

    // shoonya failure
    if (
      !response ||
      response.tokenData.stat !== 'Ok'
    ) {

      logger.error('[Shoonya Config Setup] Login Failed', response);

      return res.status(400).json({
        success: false,
        message: response?.emsg || 'Shoonya login failed',
        data: response
      });
    }

    logger.info(
      `[Shoonya Config Setup] Credentials configured successfully for ${uid}`
    );

    // Cache Shoonya credentials and session token
    setShoonyaCredentials({
      uid,
      password,
      totp,
      apiKey,
      clientId,
      secretCode
    });
    setShoonyaToken(response.tokenData.susertoken);

    console.log("step 1-response", response)
    return res.status(200).json({
      success: true,
      message: 'Shoonya credentials configured successfully',
      data: {
        userToken: response.tokenData.susertoken,
        accessToken: response.tokenData.access_token,
        expresIn: response.tokenData.expires_in,
        refereshToken: response.tokenData.refresh_token,
        accountId: response.tokenData.actid,
        broker: 'SHOONYA'
      }
    });

  } catch (error) {

    logger.error(
      '[Shoonya Config Setup] Error:',
      error.message
    );

    return res.status(500).json({
      success: false,
      error: 'Failed to configure Shoonya credentials',
      message: error.message
    });
  }
};

export const updateConfig = async (req, res) => {
  console.log("UPDATE API HIT");
  const db = await connectToDatabase();
  const result = await db.collection('system_config').updateOne(
    { _id: 'oms_config' },
    {
      $set: req.body
    }
  );

  console.log(result)
  res.json({
    success: true
  });
};

export const getConfig = async (req, res) => {
  try {
    const db = await connectToDatabase();

    const config = await db.collection('system_config').findOne({
      _id: 'oms_config'
    });

    return res.json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: 'Internal Server Error'
    });
  }
};
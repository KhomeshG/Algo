import { fyersModel } from "fyers-api-v3";
import { alertAccessTokenFailed } from "../../../services/alert-service.js";

export class FyersAuth {

    constructor() {

        this.appId =
            process.env.FYERS_APP_ID;

        this.secretKey =
            process.env.FYERS_SECRET_KEY;

        this.redirectUrl =
            process.env.FYERS_REDIRECT_URL;

        this.accessToken =
            process.env.FYERS_ACCESS_TOKEN || null;
    }

    getAuthUrl() {

        const fyers =
            new fyersModel();

        fyers.setAppId(
            this.appId
        );

        fyers.setRedirectUrl(
            this.redirectUrl
        );

        return fyers.generateAuthCode();
    }

    async generateAccessToken(
        authCode
    ) {

        try {
            const fyers =
                new fyersModel();

            fyers.setAppId(
                this.appId
            );

            fyers.setRedirectUrl(
                this.redirectUrl
            );

            const response =
                await fyers.generate_access_token({

                    secret_key:
                        this.secretKey,

                    auth_code:
                        authCode
                });

            if (
                response?.s !== 'ok'
            ) {

                throw new Error(
                    response?.message ||
                    'Failed to generate Fyers token'
                );
            }

            this.accessToken =
                response.access_token;

            console.log("[FyersAuth] Generated new access token", response.access_token);
            return response;
        } catch (err) {
            alertAccessTokenFailed('Fyers', err);
            throw err;
        }
    }

    getAccessToken() {

        if (!this.accessToken) {

            throw new Error(
                'Fyers access token not available'
            );
        }

        return this.accessToken;
    }

    getAuthenticatedClient() {

        const token =
            this.getAccessToken();

        const fyers =
            new fyersModel();

        fyers.setAppId(
            this.appId
        );

        fyers.setAccessToken(
            token
        );

        return fyers;
    }
}
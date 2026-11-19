import { FyersAuth }
    from './fyers-auth.js';

const fyersAuth =
    new FyersAuth();
console.log(
    '[Fyers Client] Initialized Fyers client'
);
console.log(
    '[Fyers Client] App ID:',
    fyersAuth.appId
);
console.log(
    '[Fyers Client] Redirect URL:',
    fyersAuth.redirectUrl
);
console.log(
    '[Fyers Client] Access Token:',
    fyersAuth.accessToken ? `${fyersAuth.accessToken.slice(0, 8)}...(hidden)` : 'MISSING'
);
export default fyersAuth;
import { delay, getTodayDate } from '../../workers/worker-helpers.js';
import { connectToDatabase } from "../../db/mongodb.js";
import fnoMasterLoader from '../../utilities/fno-master-loader.js';
import fyersAuth from '../brokers/fyers/fyers-client.js';
import { getFyersSymbol } from '../../utilities/symbol-mapper.js';

const COLLECTION_CANDLES = 'fno_one_candles';

const RESOLUTION = '3';
function formatFyersDate(date) {

    return new Date(date)
        .toISOString()
        .split('T')[0];
}
async function fetchCandles(
    symbol,
    fromDate,
    toDate,
    retryCount = 0
) {

    try {

        const fyers =
            fyersAuth.getAuthenticatedClient();

        const payload = {

            symbol,

            resolution:
                RESOLUTION,

            date_format:
                '1',

            range_from:
                formatFyersDate(fromDate),

            range_to:
                formatFyersDate(toDate),

            cont_flag:
                1
        };

        // console.log(
        //     `[Fyers Candle Fetcher] Requesting`, payload
        // );
        console.log(
            `[Fyers Candle Fetcher] Requesting ${symbol}`
        );

        const response =
            await fyers.getHistory(
                payload
            );

        if (
            !response ||
            !response.candles
        ) {

            return [];
        }

        return response.candles.map(
            candle => ({

                time:
                    new Date(
                        candle[0] * 1000
                    ).toISOString(),

                open:
                    candle[1],

                high:
                    candle[2],

                low:
                    candle[3],

                close:
                    candle[4],

                volume:
                    candle[5]
            })
        );

    } catch (err) {

        console.error(
            `[Fyers Candle Fetcher] Error for ${symbol}:`,
            err.message
        );

        if (retryCount >= 5) {

            return [];
        }

        const backoffTime =
            Math.pow(
                2,
                retryCount
            ) * 3000;

        await delay(
            backoffTime
        );

        return fetchCandles(
            symbol,
            fromDate,
            toDate,
            retryCount + 1
        );
    }
}

async function syncStockCandles(
    db,
    stock
) {

    const {
        symbol
    } = stock;

    // const today =
    //     "2026-07-13";
    const today =
        getTodayDate();

    const existing =
        await db.collection(
            COLLECTION_CANDLES)
            .findOne({

                symbol,

                date:
                    today
            });

    let existingCandles =
        [];

    let fromTime =
        `${today} 09:15`;

    if (
        existing &&
        existing.lastCandleTime
    ) {

        fromTime =
            existing.lastCandleTime;

        existingCandles =
            existing.candles || [];
    }

    const toTime =
        `${today} 15:12`;

    const fyersSymbol =
        getFyersSymbol(stock);
    const newCandles =
        await fetchCandles(

            fyersSymbol,

            fromTime,

            toTime
        );

    if (
        !newCandles.length
    ) {

        return;
    }

    const lastTime =
        existingCandles.length
            ? existingCandles[
                existingCandles.length - 1
            ].time
            : '';

    const filtered =
        newCandles.filter(
            c => c.time > lastTime
        );

    if (
        !filtered.length
    ) {

        return;
    }

    const updatedCandles = [

        ...existingCandles,

        ...filtered
    ];

    const latestTime =
        updatedCandles[
            updatedCandles.length - 1
        ].time;

    await db
        .collection(COLLECTION_CANDLES).updateOne(

            {
                symbol,

                date:
                    today
            },

            {
                $set: {

                    exchange:
                        'NSE',

                    candles:
                        updatedCandles,

                    lastCandleTime:
                        latestTime,

                    totalCandles:
                        updatedCandles.length,

                    updatedAt:
                        new Date()
                            .toISOString()
                }
            },

            {
                upsert: true
            }
        );

    console.log(
        `[Fyers Candle Fetcher] Updated ${symbol}: +${filtered.length}`
    );
}

async function main() {

    console.log(
        '[Fyers Candle Fetcher] Starting...'
    );

    const db =
        await connectToDatabase();

    try {

        const stocks =
            fnoMasterLoader
                .getFNOStocks();

        console.log(
            `[Fyers Candle Fetcher] Found ${stocks.length} stocks`
        );

        for (
            const stock
            of stocks
        ) {

            try {

                await syncStockCandles(
                    db,
                    stock
                );

                await delay(
                    1000
                );

            } catch (err) {

                console.error(
                    `[Fyers Candle Fetcher] ${stock.symbol}`,
                    err.message
                );
            }
        }

        console.log(
            '[Fyers Candle Fetcher] Completed'
        );

    } catch (err) {

        console.error(
            err
        );

    } finally {

        process.exit(0);
    }
}

main();
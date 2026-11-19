// services/config.service.js

import { OMS_CONFIG } from '../src/config/oms-config.js';
console.log('Using Config:', OMS_CONFIG);
import { connectToDatabase } from '../db/mongodb.js';

export const loadOMSConfig = async () => {
    try {

        const db = await connectToDatabase();
        const config = await db
            .collection('system_config')
            .findOne({ _id: 'oms_config' });

        if (!config) return;

        Object.assign(OMS_CONFIG, config);

        console.log('Mongo Config:', config);
        console.log('Updated OMS_CONFIG:', OMS_CONFIG);

        delete OMS_CONFIG._id;

        console.log('OMS Config Refreshed');
    } catch (err) {
        console.error('Config Refresh Error', err);
    }
};
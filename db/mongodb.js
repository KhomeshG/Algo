import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import dns from "dns";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

// Fix for querySrv ECONNREFUSED issues on certain Windows networks/ISPs
if (process.env.MONGODB_URL && process.env.MONGODB_URL.startsWith("mongodb+srv://")) {
  try {
    dns.setServers(["8.8.8.8", "8.8.4.4"]);
  } catch (err) {
    console.warn("Failed to set DNS servers:", err.message);
  }
}

const MONGODB_URL = process.env.MONGODB_URL;
const DB_NAME = process.env.DB_NAME || "tradebot";

let client = null;
let db = null;
let connectingPromise = null; // in-flight connection attempt, shared by concurrent callers

export const connectToDatabase = async () => {
  if (db) {
    return db;
  }

  // If another concurrent call already started connecting (e.g. several
  // report-range requests firing at once on a fresh server), wait for
  // THAT attempt instead of also opening a second MongoClient.
  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    console.log("Mongo URL:", process.env.MONGODB_URL);
    if (!client) {
      client = new MongoClient(MONGODB_URL);
      await client.connect();
      console.log("Connected to MongoDB successfully");
    }
    db = client.db(DB_NAME);
    return db;
  })();

  try {
    return await connectingPromise;
  } catch (err) {
    // Lazy import to avoid a circular dependency (alert-service doesn't
    // import mongodb.js, but keeping this import local/lazy is defensive
    // in case that ever changes).
    const { alertMongoError } = await import("../services/alert-service.js");
    alertMongoError("connectToDatabase()", err);
    throw err;
  } finally {
    connectingPromise = null;
  }
};

export const getCollection = async (collectionName) => {
  const database = await connectToDatabase();
  return database.collection(collectionName);
};

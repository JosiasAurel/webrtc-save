import express from "express";
import * as Y from "yjs";
import admin from "firebase-admin";
import { WebrtcProvider } from "./y-webrtc.js";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { config } from "dotenv";
import { StatsD } from "node-statsd";
import { configDotenv } from "dotenv";
config();

const app = express();
app.use(express.json());

let roomsListening = [];
let firebaseApp = null;
if (admin.apps.length === 0) {
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(
        Buffer.from(process.env.FIREBASE_CREDENTIAL, "base64").toString()
      )
    ),
  });
} else {
  firebaseApp = admin.apps[0];
}

const firestore = getFirestore(firebaseApp);
try {
  firestore.settings({ preferRest: true });
} catch (e) {
  console.log(e);
}

const environment = process.env.NODE_ENV;
const graphite = process.env.GRAPHITE_HOST;

if (graphite === null) throw new Error("Graphite host is not configured");

const options = {
  host: graphite,
  port: 8125,
  prefix: `${environment}.sprig.`,
};

const metrics = new StatsD(options);

export default metrics;

const timedOperation = async (metricKey, callback) => {
  const startTime = new Date().getTime();
  const result = await callback();
  const endTime = new Date().getTime() - startTime;

  metrics.timing(metricKey, endTime);
  return result;
};
function getGame(id) {
  return firestore.collection("games").doc(id).get();
}
app.post("/listen", async (req, res) => {
  let ydoc = null;
  let provider = null;
  const body = req.body;
  const apiKey = body.apiKey;
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).send("Unauthorized");
  }
  const room = body.room;
  if (!room) {
    return res.status(400).send("Room is required");
  }
  if (!(await getGame(room)).exists) {
    return res.status(400).send("Game does not exist");
  }
  const tutorialName = body.tutorialName;
  const trackingId = body.trackingId;
  if (!trackingId) {
    return res.status(400).send("Tracking ID is required");
  }
  if (!room) {
    return res.status(400).send("Room is required");
  }
  if (roomsListening.indexOf(room) !== -1) {
    return res.status(200).send("Already listening");
  }
  ydoc = new Y.Doc();
  provider = new WebrtcProvider(room, ydoc, {
    signaling: ["wss://yjs-signaling-server-5fb6d64b3314.herokuapp.com"],
  });

  let code = ydoc.getText("codemirror").toString();
  let firstUpdated = true;
  ydoc.on("update", () => {
    if (!firstUpdated) {
      provider.awareness.setLocalState({ saved: "saving" });
      return;
    }
    firstUpdated = false;
    setInterval(async () => {
      if (provider.awareness.getStates().size <= 1) {
        provider.awareness.setLocalStateField("saved", "error");
        return;
      }
      const metricKey = "database.update";
      code = ydoc.getText("codemirror").toString();

      await timedOperation(metricKey, async () => {
        firestore
          .collection("games")
          .doc(room)
          .update({
            code,
            modifiedAt: Timestamp.now(),
            tutorialName: tutorialName ?? null,
          });
      });

      await timedOperation(metricKey, async () => {
        firestore
          .collection("daily-edits")
          .doc(`${room}-${new Date().toDateString()}`)
          .set({
            type: "game",
            date: Timestamp.now(),
            id: room,
          });
      });
      provider.awareness.setLocalStateField("saved", "saved");
    }, 2000);
  });
  roomsListening =
    roomsListening + [{ room: room, provider: provider, ydoc: ydoc }];
  res.status(200).send("Listening to room " + room);
});

app.post("/stop", (req, res) => {
  const body = req.body;
  const apiKey = body.apiKey;
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).send("Unauthorized");
  }
  const room = body.room;
  if (!room) {
    return res.status(400).send("Room is required");
  }
  const roomData = roomsListening.find((r) => r.room === room);
  if (!roomData) {
    return res.status(400).send("Room not found");
  }
  roomData.provider.destroy();
  roomData.ydoc.destroy();
  roomsListening = roomsListening.filter((r) => r.room !== room);

  clearInterval();
  res.status(200).send("Stopped listening");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Listening on port", PORT));

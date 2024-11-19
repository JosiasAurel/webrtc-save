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
setInterval(() => {
  metrics.set("collab.Rooms_Active", roomsListening.length);
}, 10*1000) //update every 10 seconds

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

console.log(options.prefix)

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

firestore.collection("games").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach((change) => {
    let firstUpdated = true;
    const doc = change.doc;
    const data = change.doc.data();
    const lastModified = data.modifiedAt.toDate()
    const now = new Date()
    const diff = now - lastModified
    if(diff < 5 * 1000 * 60){
      if(roomsListening.find((r) => r.room === doc.id) === undefined){
        console.log("Started listening " + doc.id)
        let ydoc = new Y.Doc();
        let provider = new WebrtcProvider(doc.id, ydoc, {
          signaling: ["https://eu-yjs-signaling-d4f6d38b9dc8.herokuapp.com/"],
        });
        roomsListening.push({
          room: doc.id,
          provider: provider,
          ydoc: ydoc,
        });
        let code = ydoc.getText("codemirror").toString();
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
            code = ydoc.getText("codemirror").toString();

            try{
              await timedOperation('database.update', async () => {
                await firestore
                  .collection("games")
                  .doc(doc.id)
                  .update({
                    code,
                    modifiedAt: Timestamp.now(),
                    tutorialName: data.tutorialName ?? null,
                  });
              });
              metrics.increment("database.update.success", 1)
            } catch(e){
              console.error(e);
              metrics.increment("database.update.error", 1)
            }

            try{
              await timedOperation('database.update', async () => {
                await firestore
                  .collection("daily-edits")
                  .doc(`${doc.id}-${new Date().toDateString()}`)
                  .set({
                    type: "game",
                    date: Timestamp.now(),
                    id: doc.id,
                  });
              });
              metrics.increment("database.update.success", 1)
            } catch(e){
              console.error(e);
              metrics.increment("database.update.error", 1)
            }
            provider.awareness.setLocalStateField("saved", "saved");
          }, 2000);
        });
      }
    }
  })
})

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

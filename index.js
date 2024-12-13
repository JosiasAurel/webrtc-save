import express from "express";
import * as Y from "yjs";
import admin from "firebase-admin";
import { WebrtcProvider } from "./y-webrtc.js";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { config } from "dotenv";
import { StatsD } from "node-statsd";
import { configDotenv } from "dotenv";
import { writeFileSync } from "node:fs";
import { stringify } from "csv";
config();

const app = express();
app.use(express.json());

const SIGNALING_SERVERS = [
    "wss://yjs-signaling-server-5fb6d64b3314.herokuapp.com/",
];

const MAX_LISTENERS = 200;
process.setMaxListeners(MAX_LISTENERS);

let roomsListening = [];
setInterval(
    () => {
        metrics.set("collab.Rooms_Active", roomsListening.length);
    },
    10 * 60 * 1000,
); //update every 10 minutes

let firebaseApp = null;
if (admin.apps.length === 0) {
    firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(
            JSON.parse(
                Buffer.from(
                    process.env.FIREBASE_CREDENTIAL,
                    "base64",
                ).toString(),
            ),
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

console.log(options.prefix);

const metrics = new StatsD(options);

export default metrics;

let records = {};
/**
 * The records will look something like this
 * Record<RoomCount, Record<ClientCount, Array<Latency>>>
 *
 * Example:
 * 2 : {
 *    2 : [ time1, time2, time3 ] <- we will use this to compute the average time elapsed
 *    3 : [ time1, time2, time3 ]
 * },
 * 3 : {
 *    2 : [ time1, time2, time3 ] <- we will use this to compute the average time elapsed
 *    3 : [ time1, time2, time3 ]
 * }
 */

function buildAndWriteLatencyData() {
    const processedLatencies = [];
    Object.entries(records).map(([roomCount, children]) => {
        Object.entries(children).map(([clientCount, latencies]) => {
            const averageLatency =
                latencies.reduce((acc, curr) => acc + curr, 0) /
                latencies.length;

            processedLatencies.push({
                roomCount,
                clientCount,
                latency: averageLatency,
            });
        });
    });

    stringify(
        processedLatencies,
        {
            header: true,
            columns: {
                clientCount: "clientCount",
                latency: "latency",
                roomCount: "roomCount",
            },
        },
        (err, out) => {
            if (err) {
                console.error("Failed to write latencies");
                process.exit(1);
            }
            writeFileSync("processed.csv", out);
        },
    );
}

const failures = [];
let startedWriting = false;
const writeOperations = [];

const timedOperation = async (metricKey, callback) => {
    const startTime = new Date().getTime();
    let result;
    try {
        writeOperations.push(1); // add this as a write operation
        if (!startedWriting) startedWriting = true;
        result = await callback();
    } catch (error) {
        failures.push(error.toString());
        // write the errors to a file
        writeFileSync("errors.json", JSON.stringify(failures));
    } finally {
        const endTime = new Date().getTime() - startTime;
        metrics.timing(metricKey, endTime);

        writeOperations.pop();
    }
    return result;
};

function getGame(id) {
    return firestore.collection("games").doc(id).get();
}

app.get("/done", (req, res) => {
    if (startedWriting && writeOperations.length === 0) {
        // exit if and only if we have finished writing everything to firestore
        res.end();
        process.exit(0);
    }
});

app.get("/add-room/:roomId", (req, res) => {
    res.send({ ok: true }); // tell the sender we're going to take care of this thing

    const roomId = req.params.roomId;
    console.log("Creating new room");

    // start listening to updates from this room
    let ydoc = new Y.Doc();
    let provider = new WebrtcProvider(roomId, ydoc, {
        signaling: SIGNALING_SERVERS,
    });

    // add this room to the list of rooms we're listening to
    roomsListening.push({
        room: roomId,
        provider,
        ydoc,
    });

    ydoc.on("update", async (update, origin) => {
        // receive update
        const startTime = new Date().getTime();
        // if (!firstUpdated) {
        // provider.awareness.setLocalState({ saved: "saving" });
        // return;
        // }
        // firstUpdated = false;
        // setInterval(async () => {
        // if (provider.awareness.getStates().size <= 1) {
        //   provider.awareness.setLocalStateField("saved", "error");
        //   return;
        // }
        // let code = ydoc.getText("codemirror").toString();
        let ymap = ydoc.getMap("codemirror");
        let code = ymap.get("code");

        const details = JSON.parse(code);

        if (!Object.hasOwn(records, details.roomCount)) {
            records = {
                ...records,
                [details.roomCount]: { [details.clientCount]: [] },
            };
        }

        if (!Object.hasOwn(records[details.roomCount], details.clientCount)) {
            // easy on the eyes :D
            records = {
                ...records,
                [details.roomCount]: {
                    ...records[details.roomCount],
                    [details.clientCount]: [],
                },
            };
        }

        try {
            // console.log("about to write an update to room", roomId);
            await timedOperation("database.update", async () => {
                return await firestore.collection("rooms").doc(roomId).update({
                    content: "hello world",
                });
            });
            // save update
            const timeElapsed = new Date().getTime() - startTime;
            records[details.roomCount][details.clientCount].push(timeElapsed);

            ymap.set("response", "ack");

            // write the updated latency data to csv
            buildAndWriteLatencyData();

            metrics.increment("database.update.success", 1);
        } catch (e) {
            console.error(e);
            metrics.increment("database.update.error", 1);
        }

        provider.awareness.setLocalStateField("saved", "saved");
        // }, 2000);
    });
});

// firestore.collection("rooms").onSnapshot((snapshot) => {
//   snapshot.docChanges().forEach((change) => {
//     let firstUpdated = true;
//     const doc = change.doc;
//     const data = change.doc.data();
//     const lastModified = data.modifiedAt.toDate()
//     const now = new Date()
//     const diff = now - lastModified
//     if (diff < 5 * 1000 * 60) { // if the document was modified 5 minutes ago
//       if (roomsListening.find((r) => r.room === doc.id) === undefined) { // start listening to this document if it's not one of the rooms we're listening to
//         console.log("Started listening " + doc.id)
//         let ydoc = new Y.Doc();
//         let provider = new WebrtcProvider(doc.id, ydoc, {
//           signaling: ["wss://yjs-signaling-server-5fb6d64b3314.herokuapp.com"],
//         });
//         roomsListening.push({
//           room: doc.id,
//           provider: provider,
//           ydoc: ydoc,
//         });
//         let code = ydoc.getText("codemirror").toString();
//         ydoc.on("update", (update, origin) => {
//           // receive update
//           const startTime = new Date().getTime();
//           if (!firstUpdated) {
//             provider.awareness.setLocalState({ saved: "saving" });
//             return;
//           }
//           firstUpdated = false;
//           setInterval(async () => {
//             if (provider.awareness.getStates().size <= 1) {
//               provider.awareness.setLocalStateField("saved", "error");
//               return;
//             }
//             code = ydoc.getText("codemirror").toString();

//             const details = JSON.parse(code);

//             if (!Object.hasOwn(records, details.roomCount)) {
//               records = { ...records, [details.roomCount]: { [details.clientCount]: [] }}
//             }

//             try {
//               await timedOperation('database.update', async () => {
//                 await firestore
//                   .collection("rooms")
//                   .doc(doc.id)
//                   .update({
//                     content: code,
//                   });
//                   console.timeEnd();
//               });
//               // save update
//               const timeElapsed = new Date().getTime() - startTime;
//             records[details.roomCount][details.clientCount].push(timeElapsed);
//               metrics.increment("database.update.success", 1)
//             } catch(e){
//               console.error(e);
//               metrics.increment("database.update.error", 1)
//             }

//             provider.awareness.setLocalStateField("saved", "saved");
//           }, 2000);
//         });
//       }
//     }
//   })
// })

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

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log("Listening on port", PORT));

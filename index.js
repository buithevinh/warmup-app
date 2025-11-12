const express = require("express"); // giữ container sống
const pLimit = require("p-limit").default;
const _ = require("lodash");
const Redis = require("ioredis");
const client = new Redis(process.env.REDIS_TELEGRAM);
const { createClient: createClientTurso } = require("@libsql/client");
const { default: axios } = require("axios");

const clientTurso = createClientTurso({
  url: process.env.TURSO_DB_URL_DOUYIN,
  authToken: process.env.TURSO_AUTH_TOKEN_DOUYIN,
});

const BATCH_SIZE = 50;

async function runWarmUpLoop() {
  while (true) {
    try {
      const controller = new AbortController();
      const lock = await client.set("warm:lock", "1", "NX", "EX", 50);
      if (!lock) {
        console.log("Already running, waiting 5s...");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const lastId = parseInt(await client.get("warm:last_id") || "0", 10);
      const rows = await clientTurso.execute({
        sql: `SELECT id, images FROM video_images WHERE id > ? ORDER BY id ASC LIMIT ?`,
        args: [lastId, BATCH_SIZE],
      });

      if (rows.rows.length === 0) {
        await client.set("warm:last_id", "0"); // restart
        console.log("Restart cycle");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const limit = pLimit(20);
      const urls = _.flatten(
        rows.rows.map(row => {
          if (!row.images) return [];
          try {
            return JSON.parse(row.images.replace(/\\"/g, '"')) || [];
          } catch {
            return [];
          }
        })
      );

      const promises = urls.map(url =>
        limit(async () => {
          try {
            const start = Date.now();
            const resp = await axios.get(url, {
              responseType: "stream",
              signal: controller.signal,
            });

            let downloaded = 0;
            const limit = 16 * 1024;

            resp.data.on("data", chunk => {
              downloaded += chunk.length;
              if (downloaded >= limit) controller.abort();
            });

            resp.data.on("end", () => {
              console.log(`Warmed: ${url} (${Date.now() - start}ms)`);
            });
          } catch (e) {
            console.error(`Error warming ${url}`, e.message);
          }
        })
      );

      await Promise.all(promises);

      const newLastId = rows.rows[rows.rows.length - 1].id;
      await client.set("warm:last_id", newLastId);
      console.log(`Batch done, last_id=${newLastId}`);
      
    } catch (err) {
      console.error("Warm-up loop error:", err);
    }
  }
}

// ---- SERVER GIỮ CONTAINER SỐNG ----
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.send("App is running!");
});

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  // Chạy warm-up ngay khi container start
  try {
    runWarmUpLoop();
  } catch (err) {
    console.error("Warm-up error:", err);
  }
});

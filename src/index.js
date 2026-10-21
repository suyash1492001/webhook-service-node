let config;
try {
  config = require("./config");
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const app = require("./app");
const { pool, init } = require("./db");
const worker = require("./worker");

async function main() {
  await init();
  worker.start();
  const server = app.listen(config.port, () => console.log(`listening on ${config.port}`));

  const shutdown = async () => {
    worker.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("startup failed:", err.message);
  process.exit(1);
});

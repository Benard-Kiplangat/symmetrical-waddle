const fs = require("fs");
const path = require("path");
const http = require("http");

function loadEnvFile(fileName) {
  const envPath = path.join(__dirname, "servers", fileName);
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    const [key, ...valueParts] = line.split("=");
    const value = valueParts.join("=").trim();

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env.mpesa");
loadEnvFile(".env.kra");

const SERVER_PORT = Number(process.env.PORT) || 3000;
const app = require("./servers/kra-etims");

const server = http.createServer(app);
server.listen(SERVER_PORT, () => {
  console.log(`Server started on port ${SERVER_PORT}`);
});

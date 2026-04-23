const https = require("https");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const apiKey = process.env.GEMINI_API_KEY;
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

https.get(url, (res) => {
  let data = "";
  res.on("data", (chunk) => {
    data += chunk;
  });
  res.on("end", () => {
    try {
      const json = JSON.parse(data);
      if (json.models) {
        console.log("Available Models:");
        json.models.forEach((m) => {
          console.log(`- ${m.name}`);
        });
      } else {
        console.log("Response:", JSON.stringify(json, null, 2));
      }
    } catch (e) {
      console.error("Failed to parse response:", e.message);
      console.log("Raw data:", data);
    }
  });
}).on("error", (err) => {
  console.error("Error:", err.message);
});

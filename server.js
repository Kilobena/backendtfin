import express from "express";
import cors from "cors";

const app = express();

// Render/reverse-proxy: makes req.protocol correct ("https")
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
    })
);

/**
 * HARD-CODED CONFIG FOR TESTING ONLY
 * Replace the API key string and deploy.
 */
const TFIN_API_KEY = "PASTE_YOUR_API_KEY_HERE"; // <-- paste your key here (testing only)
const INITIATE_URL = "https://p2-back.onrender.com/transaction/payment/initiate";

// Use your Render backend domain (hard-coded). You gave:
const BASE_URL = "https://backendtfin.onrender.com";
const WEBHOOK_URL = `${BASE_URL}/api/webhook/payment`;

let latestWebhooks = []; // store last 20 webhooks (memory only)

app.get("/", (req, res) => {
    res.json({ ok: true, service: "tfin-backend" });
});

app.post("/api/initiate", async (req, res) => {
    try {
        const { amount, userEmail, userId } = req.body || {};

        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ error: "Invalid amount (must be > 0)" });
        }
        if (!userEmail || typeof userEmail !== "string") {
            return res.status(400).json({ error: "userEmail is required" });
        }
        if (!userId || typeof userId !== "string") {
            return res.status(400).json({ error: "userId is required" });
        }

        if (!TFIN_API_KEY || TFIN_API_KEY === "bdb03c89-150a-4734-ad70-0ae4836431db") {
            return res.status(500).json({
                error: "TFIN_API_KEY is not set in server.js (paste your key).",
            });
        }

        const payload = {
            amount: Number,
            userEmail: userEmail.trim(),
            userId: userId.trim(),
            webhookReturnURL: WEBHOOK_URL,
        };

        const r = await fetch(INITIATE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": TFIN_API_KEY,
            },
            body: JSON.stringify(payload),
        });

        const text = await r.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }

        if (!r.ok) {
            return res.status(r.status).json({
                error: data?.message || data?.error || "Initiate failed",
                details: data,
                sentPayload: payload,
            });
        }

        res.json({
            ok: true,
            sentPayload: payload,
            providerResponse: data,
        });
    } catch (e) {
        res.status(500).json({ error: "Server error", message: String(e?.message || e) });
    }
});

app.post("/api/webhook/payment", (req, res) => {
    console.log("✅ Webhook received:", JSON.stringify(req.body, null, 2));

    latestWebhooks.unshift({
        receivedAt: new Date().toISOString(),
        payload: req.body,
    });
    latestWebhooks = latestWebhooks.slice(0, 20);

    res.status(200).json({ received: true });
});

app.get("/api/webhook/latest", (req, res) => {
    res.json({ items: latestWebhooks });
});

const PORT = process.env.PORT || 3001; // Render sets PORT automatically
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

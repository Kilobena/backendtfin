import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Allow your frontend to call your backend
app.use(
    cors({
        origin: process.env.FRONTEND_ORIGIN || "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
    })
);

// Simple in-memory storage (OK for testing; use DB for production)
let latestWebhooks = []; // store last ~20

app.get("/", (req, res) => res.json({ ok: true, service: "tfin-backend" }));

/**
 * Proxy initiate so x-api-key stays server-side
 * Frontend -> POST /api/initiate
 * Backend -> POST https://p2-back.onrender.com/transaction/payment/initiate
 */
app.post("/api/initiate", async (req, res) => {
    try {
        const { amount, userEmail, userId } = req.body;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }
        if (!userEmail || !userId) {
            return res.status(400).json({ error: "userEmail and userId are required" });
        }

        const apiKey = process.env.TFIN_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "Missing TFIN_API_KEY env var" });
        }

        // Render URL is known at runtime; set WEBHOOK_URL env var on Render
        const webhookReturnURL = process.env.WEBHOOK_URL;
        if (!webhookReturnURL) {
            return res.status(500).json({ error: "Missing WEBHOOK_URL env var" });
        }

        const payload = {
            amount: Number(Number(amount).toFixed(2)),
            userEmail,
            userId,
            webhookReturnURL,
        };

        const r = await fetch("https://p2-back.onrender.com/transaction/payment/initiate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
            },
            body: JSON.stringify(payload),
        });

        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        if (!r.ok) {
            return res.status(r.status).json({
                error: data?.message || data?.error || "Initiate failed",
                details: data,
            });
        }

        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Server error", message: String(e?.message || e) });
    }
});

/**
 * Webhook receiver: TFin will call this
 */
app.post("/api/webhook/payment", (req, res) => {
    const payload = req.body;

    console.log("✅ Webhook received:", JSON.stringify(payload, null, 2));

    // store latest
    latestWebhooks.unshift({ receivedAt: new Date().toISOString(), payload });
    latestWebhooks = latestWebhooks.slice(0, 20);

    // quick ACK
    res.status(200).json({ received: true });
});

// Helper to see latest webhook from browser
app.get("/api/webhook/latest", (req, res) => {
    res.json({ items: latestWebhooks });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

import express from "express";
import cors from "cors";
import crypto from "crypto";

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
const TFIN_API_KEY = "bdb03c89-150a-4734-ad70-0ae4836431db"; // <-- testing only
const INITIATE_URL = "https://p2-back.onrender.com/transaction/payment/initiate";

// Use your Render backend domain (hard-coded). You gave:
const BASE_URL = "https://backendtfin.onrender.com";
const WEBHOOK_URL = `${BASE_URL}/api/webhook/payment`;

let latestWebhooks = []; // store last 20 webhooks (memory only)

/**
 * ================================
 * PARTNER PAYMENT API CONFIG
 * ================================
 * Set these in Render environment variables:
 * PARTNER_HOST, PARTNER_RESOURCE, PARTNER_SID, PARTNER_SECRETKEY
 */
const PARTNER_HOST = "https://payments1.betconstruct.com"; // e.g. "https://provider.example.com"
const PARTNER_RESOURCE = "TerminalCallbackPG"; // e.g. "MyResource"
const PARTNER_SID = "18756444"; // provider sid
const PARTNER_SECRETKEY = "P3kyCMTph4JJ8gECK20EbByh"; // provider secret key (keep secret)

function md5Hex(str) {
    return crypto.createHash("md5").update(str, "utf8").digest("hex");
}

function providerBaseUrl() {
    if (!PARTNER_HOST || !PARTNER_RESOURCE) {
        throw new Error("Missing PARTNER_HOST or PARTNER_RESOURCE env vars");
    }
    // Doc format: <HOST>/Bets/PaymentsCallback/<RESOURCE>/?...
    return `${PARTNER_HOST.replace(/\/$/, "")}/Bets/PaymentsCallback/${encodeURIComponent(
        PARTNER_RESOURCE
    )}/`;
}

app.get("/api/partner/check-direct", async (req, res) => {
    try {
        const url =
"https://payments1.betconstruct.com/Bets/PaymentsCallback/TerminalCallbackPG/?command=check&account=381389613&currency=TND&paymentID=3799&sid=18756444&hashcode=e1f6f98a6f03553a53c696a427f86d12"
            
        const r = await fetch(url, { method: "GET" });
        const text = await r.text();

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }

        return res.status(r.ok ? 200 : r.status).json({
            ok: r.ok,
            status: r.status,
            url,
            data,
        });
    } catch (e) {
        return res.status(500).json({
            ok: false,
            error: "Server error",
            message: String(e?.message || e),
        });
    }
});




async function callPartnerApi({ command, params, hashcode, extraQuery = {} }) {
    if (!PARTNER_SID || !PARTNER_SECRETKEY) {
        throw new Error("Missing PARTNER_SID or PARTNER_SECRETKEY env vars");
    }

    const url = new URL(providerBaseUrl());

    // Base required params
    const sp = new URLSearchParams({
        command,
        sid: PARTNER_SID,
        ...params,
        hashcode,
    });

    // ✅ Add static GET parameter paymentID=3799
    sp.append("paymentID", "3799");

    // ✅ If extraQuery is passed, append those too
    if (extraQuery && typeof extraQuery === "object") {
        for (const [key, value] of Object.entries(extraQuery)) {
            if (value !== undefined && value !== null) {
                sp.append(key, String(value));
            }
        }
    }

    url.search = sp.toString();

    const r = await fetch(url.toString(), { method: "GET" });
    const text = await r.text();

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { raw: text };
    }

    if (!r.ok) {
        return { ok: false, status: r.status, data, url: url.toString() };
    }

    return { ok: true, status: r.status, data, url: url.toString() };
}


function isProviderSuccess(resp) { // expected: { response: { code: 0, message: "OK" } }
    return resp?.data?.response?.code === 0; }
/**
 * ================================
 * ROUTES
 * ================================
 */

app.get("/", (req, res) => {
    res.json({ ok: true, service: "tfin-backend" });
});

/**
 * Your existing initiate endpoint (unchanged)
 */
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

        const payload = {
            amount: amount,
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

/**
 * Webhook endpoints (unchanged)
 */
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

/**
 * ================================
 * NEW: One endpoint that does:
 * 1) check (user check)
 * 2) pay (deposit)
 * ================================
 *
 * POST /api/deposit
 * Body:
 * {
 *   "userId": "12345",
 *   "amount": 50,
 *   "currency": "EUR",
 *   "txnId": "optional-custom-id"
 * }
 */
app.post("/api/deposit", async (req, res) => {
    try {
        const { userId, amount, currency, txnId } = req.body || {};

        const userIdStr = String(userId);
        const amt = Number(amount);

        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ error: "Invalid amount (must be > 0)" });
        }

        // ✅ Take currency from request body
        if (!currency || typeof currency !== "string") {
            return res.status(400).json({ error: "currency is required" });
        }

        const curr = currency.trim().toUpperCase();

        const finalTxnId = (txnId && String(txnId)) || crypto.randomUUID();

        // 1) CHECK
        const checkCommand = "check";

        const checkHash = md5Hex(
            checkCommand +
            userIdStr +
            curr +
            PARTNER_SID +
            PARTNER_SECRETKEY
        );

        const checkResp = await callPartnerApi({
            command: checkCommand,
            params: {
                account: userIdStr,
                currency: curr,
            },
            hashcode: checkHash,
            // ✅ Static GET parameter
            extraQuery: {
                paymentID: "3799",
            },
        });

        if (!checkResp.ok) {
            return res.status(502).json({
                error: "Provider check call failed",
                provider: checkResp,
            });
        }

        if (!isProviderSuccess(checkResp)) {
            return res.status(400).json({
                error: "User check failed (deposit not allowed or user not found)",
                provider: checkResp,
            });
        }

        // 2) PAY (DEPOSIT)
        const payCommand = "pay";

        const payHash = md5Hex(
            payCommand +
            finalTxnId +
            userIdStr +
            String(amt) +
            curr +
            PARTNER_SID +
            PARTNER_SECRETKEY
        );

        const payResp = await callPartnerApi({
            command: payCommand,
            params: {
                account: userIdStr,
                amount: String(amt),
                currency: curr,
                txn_id: finalTxnId,
            },
            hashcode: payHash,
            // ✅ Static GET parameter
            extraQuery: {
                paymentID: "3799",
            },
        });

        if (!payResp.ok) {
            return res.status(502).json({
                error: "Provider deposit call failed",
                provider: payResp,
            });
        }

        if (!isProviderSuccess(payResp)) {
            return res.status(400).json({
                error: "Deposit rejected by provider",
                txnId: finalTxnId,
                provider: payResp,
            });
        }

        return res.json({
            ok: true,
            userId: userIdStr,
            amount: amt,
            currency: curr,
            txnId: finalTxnId,
            check: checkResp.data,
            deposit: payResp.data,
        });

    } catch (e) {
        return res.status(500).json({
            error: "Server error",
            message: String(e?.message || e),
        });
    }
});


/**
 * OPTIONAL: status + cancel
 */
app.post("/api/deposit/status", async (req, res) => {
    try {
        const { txnId } = req.body || {};
        if (!txnId) return res.status(400).json({ error: "txnId is required" });

        const command = "status";
        const hashcode = md5Hex(command + String(txnId) + PARTNER_SID + PARTNER_SECRETKEY);

        const resp = await callPartnerApi({
            command,
            params: { txn_id: String(txnId) },
            hashcode,
        });

        return res.status(resp.ok ? 200 : 502).json(resp);
    } catch (e) {
        return res.status(500).json({ error: "Server error", message: String(e?.message || e) });
    }
});


app.get("/api/partner/list-errors", async (req, res) => {
    try {
        if (!PARTNER_SID) throw new Error("Missing PARTNER_SID");

        const url = new URL(providerBaseUrl());
        url.search = new URLSearchParams({
            command: "list_errors",
            sid: PARTNER_SID,
        }).toString();

        const r = await fetch(url.toString(), { method: "GET" });
        const text = await r.text();

        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        res.status(r.status).json({ status: r.status, ok: r.ok, url: url.toString(), data });
    } catch (e) {
        res.status(500).json({ error: "Server error", message: String(e?.message || e) });
    }
});


app.post("/api/deposit/cancel", async (req, res) => {
    try {
        const { txnId } = req.body || {};
        if (!txnId) return res.status(400).json({ error: "txnId is required" });

        const command = "cancel";
        const hashcode = md5Hex(command + String(txnId) + PARTNER_SID + PARTNER_SECRETKEY);

        const resp = await callPartnerApi({
            command,
            params: { txn_id: String(txnId) },
            hashcode,
        });

        return res.status(resp.ok ? 200 : 502).json(resp);
    } catch (e) {
        return res.status(500).json({ error: "Server error", message: String(e?.message || e) });
    }
});

const PORT = process.env.PORT || 3001; // Render sets PORT automatically
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

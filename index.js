// index.js
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Store active payment sessions (use Redis/DB in production)
const paymentSessions = new Map();

// Webhook endpoint for HashPay callbacks
app.post("/api/webhook/hashpay", (req, res) => {
  console.log("Webhook received:", new Date().toISOString());
  console.log("Webhook payload:", JSON.stringify(req.body, null, 2));

  const {
    ResponseCode,
    ResponseDescription,
    CheckoutRequestID,
    TransactionID,
    TransactionAmount,
    Msisdn,
    TransactionReference,
  } = req.body;

  // Check if payment was successful (ResponseCode should be "0" as string)
  const isSuccessful = ResponseCode === "0" || ResponseCode === 0;

  console.log(
    `Payment ${isSuccessful ? "successful" : "failed"} for checkout: ${CheckoutRequestID}`,
  );

  if (isSuccessful && CheckoutRequestID) {
    // Find the payment session
    const session = paymentSessions.get(CheckoutRequestID);

    if (session) {
      // Update session with transaction details
      session.status = "completed";
      session.transactionId = TransactionID;
      session.amount = TransactionAmount;
      session.phone = Msisdn;
      session.reference = TransactionReference;
      session.completedAt = new Date();

      console.log(`✅ Payment completed for checkout: ${CheckoutRequestID}`);
      console.log(
        `💰 Amount: ${TransactionAmount}, Transaction ID: ${TransactionID}`,
      );

      // Emit real-time notification to the client
      if (
        session.wsConnection &&
        session.wsConnection.readyState === WebSocket.OPEN
      ) {
        session.wsConnection.send(
          JSON.stringify({
            type: "payment_completed",
            data: {
              checkoutId: CheckoutRequestID,
              transactionId: TransactionID,
              amount: TransactionAmount,
              phone: Msisdn,
              reference: TransactionReference,
            },
          }),
        );
        console.log(
          `📡 WebSocket notification sent for checkout: ${CheckoutRequestID}`,
        );
      } else {
        console.log(
          `⚠️ No active WebSocket connection for checkout: ${CheckoutRequestID}`,
        );
      }

      // Clean up old sessions after 1 hour
      setTimeout(() => {
        paymentSessions.delete(CheckoutRequestID);
        console.log(`🧹 Cleaned up session for checkout: ${CheckoutRequestID}`);
      }, 3600000);
    } else {
      console.log(`⚠️ Session not found for checkout: ${CheckoutRequestID}`);
    }
  } else if (!isSuccessful && CheckoutRequestID) {
    const session = paymentSessions.get(CheckoutRequestID);
    if (session) {
      session.status = "failed";
      session.errorCode = ResponseCode;
      console.log(
        `❌ Payment failed for checkout: ${CheckoutRequestID}, Code: ${ResponseCode}`,
      );
    }
  }

  // Always respond with 200 to acknowledge receipt
  res.status(200).json({ received: true });
});

// Endpoint to check payment status
app.post("/api/check-payment-status", (req, res) => {
  const { checkoutId } = req.body;

  console.log(`Checking status for checkout: ${checkoutId}`);

  if (!checkoutId) {
    return res.status(400).json({
      success: false,
      error: "checkoutId is required",
    });
  }

  const session = paymentSessions.get(checkoutId);

  if (!session) {
    return res.json({
      success: false,
      status: "not_found",
      message: "Payment session not found",
    });
  }

  res.json({
    success: true,
    status: session.status,
    transactionId: session.transactionId,
    amount: session.amount,
    phone: session.phone,
    reference: session.reference,
    completedAt: session.completedAt,
  });
});

// Endpoint to initiate payment
app.post("/api/initiate-payment", async (req, res) => {
  const { amount, phone, reference, userId } = req.body;

  const HASHPAY_API_KEY = "h265272vstks7";
  const HASHPAY_ACCOUNT_ID = "HP672201";
  const HASHPAY_INITIATE_URL = "https://api.hashback.co.ke/initiatestk";

  try {
    console.log("📱 Initiating payment:", { amount, phone, reference });

    const response = await fetch(HASHPAY_INITIATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: HASHPAY_API_KEY,
        account_id: HASHPAY_ACCOUNT_ID,
        amount: amount.toString(),
        msisdn: phone,
        reference: reference,
      }),
    });

    const data = await response.json();
    console.log("HashPay response:", JSON.stringify(data, null, 2));

    // Check for successful response based on actual HashPay response structure
    // HashPay returns ResponseCode: "0" on success and CheckoutRequestID
    if (data.ResponseCode === "0" && data.CheckoutRequestID) {
      // Store session with CheckoutRequestID
      paymentSessions.set(data.CheckoutRequestID, {
        userId,
        amount,
        phone,
        reference,
        status: "pending",
        createdAt: Date.now(),
        merchantRequestId: data.MerchantRequestID,
      });

      console.log(
        `✅ Payment initiated successfully. Checkout ID: ${data.CheckoutRequestID}`,
      );

      res.json({
        success: true,
        checkoutId: data.CheckoutRequestID, // Return CheckoutRequestID
        merchantRequestId: data.MerchantRequestID,
        message: data.ResponseDescription || "STK push sent successfully",
      });
    } else {
      // Payment initiation failed
      console.log(
        `❌ Payment initiation failed: ${data.ResponseDescription || "Unknown error"}`,
      );
      res.status(400).json({
        success: false,
        error: data.ResponseDescription || "Initiation failed",
        responseCode: data.ResponseCode,
        details: data,
      });
    }
  } catch (error) {
    console.error("Payment initiation error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    activeSessions: paymentSessions.size,
  });
});

// WebSocket connection handling
wss.on("connection", (ws) => {
  console.log("🔌 Client connected to WebSocket");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      console.log("WebSocket message:", data);

      if (data.type === "register" && data.checkoutId) {
        // Register this connection with a checkout ID
        const session = paymentSessions.get(data.checkoutId);
        if (session) {
          session.wsConnection = ws;
          console.log(
            `✅ Registered WebSocket for checkout: ${data.checkoutId}`,
          );

          // Send confirmation
          ws.send(
            JSON.stringify({
              type: "registered",
              checkoutId: data.checkoutId,
            }),
          );

          // If payment is already completed, send success immediately
          if (session.status === "completed") {
            ws.send(
              JSON.stringify({
                type: "payment_completed",
                data: {
                  checkoutId: data.checkoutId,
                  transactionId: session.transactionId,
                  amount: session.amount,
                  phone: session.phone,
                  reference: session.reference,
                },
              }),
            );
            console.log(
              `📡 Sent cached payment completion for: ${data.checkoutId}`,
            );
          }
        } else {
          console.log(`⚠️ No session found for checkout: ${data.checkoutId}`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Session not found",
              checkoutId: data.checkoutId,
            }),
          );
        }
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected from WebSocket");
    // Clean up any sessions associated with this WebSocket
    for (const [checkoutId, session] of paymentSessions.entries()) {
      if (session.wsConnection === ws) {
        delete session.wsConnection;
        console.log(`🧹 Cleaned up WebSocket for checkout: ${checkoutId}`);
      }
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

const PORT = process.env.PORT || 3000;

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 Server is running!`);
  console.log(`📡 HTTP server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server: ws://localhost:${PORT}`);
  console.log(
    `💰 Payment initiation: POST http://localhost:${PORT}/api/initiate-payment`,
  );
  console.log(
    `✅ Payment status: POST http://localhost:${PORT}/api/check-payment-status`,
  );
  console.log(
    `🔄 Webhook endpoint: POST http://localhost:${PORT}/api/webhook/hashpay`,
  );
  console.log(`❤️ Health check: GET http://localhost:${PORT}/api/health\n`);
});

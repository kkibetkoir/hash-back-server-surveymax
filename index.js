index.js;
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
  console.log("Webhook received:", req.body);

  const {
    ResponseCode,
    ResponseDescription,
    CheckoutRequestID,
    TransactionID,
    TransactionAmount,
    Msisdn,
    TransactionReference,
  } = req.body;

  // Check if payment was successful
  const isSuccessful = ResponseCode === 0;

  if (isSuccessful) {
    // Find the payment session
    const session = paymentSessions.get(CheckoutRequestID);

    if (session) {
      // Update session with transaction details
      session.status = "completed";
      session.transactionId = TransactionID;
      session.amount = TransactionAmount;

      console.log(`Payment completed for checkout: ${CheckoutRequestID}`);

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
      }

      // Clean up old sessions after 1 hour
      setTimeout(() => {
        paymentSessions.delete(CheckoutRequestID);
      }, 3600000);
    }
  }

  // Always respond with 200 to acknowledge receipt
  res.status(200).json({ received: true });
});

// Endpoint to initiate payment
app.post("/api/initiate-payment", async (req, res) => {
  const { amount, phone, reference, userId } = req.body;

  const HASHPAY_API_KEY = "h265272vstks7";
  const HASHPAY_ACCOUNT_ID = "HW3262722341";
  const HASHPAY_INITIATE_URL = "https://api.hashback.co.ke/initiatestk";

  try {
    console.log("Initiating payment:", { amount, phone, reference });

    const response = await fetch(HASHPAY_INITIATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: HASHPAY_API_KEY,
        account_id: HASHPAY_ACCOUNT_ID,
        amount: amount,
        msisdn: phone,
        reference: reference,
      }),
    });

    const data = await response.json();
    console.log("HashPay response:", data);

    if (data.success && data.checkout_id) {
      // Store session with checkout_id
      paymentSessions.set(data.checkout_id, {
        userId,
        amount,
        phone,
        reference,
        status: "pending",
        createdAt: Date.now(),
      });

      res.json({
        success: true,
        checkoutId: data.checkout_id,
        message: "Payment initiated successfully",
      });
    } else {
      res.status(400).json({
        success: false,
        error: data.message || "Initiation failed",
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

// WebSocket connection handling
wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      console.log("WebSocket message:", data);

      if (data.type === "register" && data.checkoutId) {
        // Register this connection with a checkout ID
        const session = paymentSessions.get(data.checkoutId);
        if (session) {
          session.wsConnection = ws;
          console.log(`Registered WebSocket for checkout: ${data.checkoutId}`);

          // Send confirmation
          ws.send(
            JSON.stringify({
              type: "registered",
              checkoutId: data.checkoutId,
            }),
          );
        } else {
          console.log(`No session found for checkout: ${data.checkoutId}`);
        }
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    // Clean up any sessions associated with this WebSocket
    for (const [checkoutId, session] of paymentSessions.entries()) {
      if (session.wsConnection === ws) {
        delete session.wsConnection;
        console.log(`Cleaned up WebSocket for checkout: ${checkoutId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 8080;

// Start server on port 3000
server.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log(`WebSocket server running on port ${PORT} (same as HTTP)`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/api/webhook/hashpay`);
});

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { Pool } from "pg";
import Joi from "joi";
import cors from "cors";

dotenv.config();

const app = express();

// Security middlewares
app.use(helmet());
app.use(express.json());

// Allowed frontend URL (Vercel)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

// Strict CORS policy: only allow Vercel frontend
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-key"],
}));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
}));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Joi validation schema for bookings
const bookingSchema = Joi.object({
  homestay_id: Joi.string().required(),
  date: Joi.date().iso().required(),
  time_slot: Joi.string().required(),
  guest_name: Joi.string().min(2).max(200).required(),
  phone: Joi.string().min(7).max(20).required(),
  email: Joi.string().email().allow("", null),
  address: Joi.string().max(1000).allow("", null),
  guests: Joi.number().integer().min(1).max(20).optional(),
  special_requests: Joi.string().max(1000).allow("", null)
});

// ================================
// 📌 CREATE BOOKING
// ================================
app.post("/api/bookings", async (req, res) => {
  const { error, value } = bookingSchema.validate(req.body);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  const {
    homestay_id,
    date,
    time_slot,
    guest_name,
    phone,
    email,
    address,
    guests = 1,
    special_requests = ""
  } = value;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check if date already booked
    const existing = await client.query(
      "SELECT id FROM bookings WHERE homestay_id = $1 AND date = $2 FOR UPDATE",
      [homestay_id, date]
    );

    if (existing.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Selected date already booked for this homestay" });
    }

    // Insert new booking
    const result = await client.query(
      `INSERT INTO bookings
      (homestay_id, date, time_slot, guest_name, phone, email, address, guests, special_requests)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, created_at`,
      [
        homestay_id,
        date,
        time_slot,
        guest_name,
        phone,
        email || null,
        address || null,
        guests,
        special_requests || null
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      id: result.rows[0].id,
      createdAt: result.rows[0].created_at
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Booking error:", err);
    res.status(500).json({ error: "Internal server error" });

  } finally {
    client.release();
  }
});

// ================================
// 📌 ADMIN — VIEW ALL BOOKINGS
// ================================
const ADMIN_KEY = process.env.ADMIN_API_KEY;

app.get("/api/bookings", async (req, res) => {
  if (req.header("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const data = await pool.query("SELECT * FROM bookings ORDER BY created_at DESC");
    return res.json(data.rows);

  } catch (err) {
    console.error("Admin fetch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ================================
// 📌 Health Check (for Render keep-alive)
// ================================
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ================================
// 📌 Start Server on Render
// ================================
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API running on port ${port}`);
});

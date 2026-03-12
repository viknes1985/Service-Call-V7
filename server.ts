import express from "express";
import { createServer as createViteServer } from "vite";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import axios from "axios";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Configuration ---
const MONGODB_URI = process.env.MONGODB_URI || "";
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const resend = new Resend(process.env.RESEND_API_KEY);

// --- MongoDB Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected successfully"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// --- Mongoose Schemas ---
const UserSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // Keeping your custom string IDs
  firstName: String,
  lastName: String,
  mobileNumber: String,
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  resetCode: String,
  resetCodeExpires: Number
}, { _id: false });
const User = mongoose.model("User", UserSchema);

const ServiceSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  state: String,
  town: String,
  category: String,
  providerName: String,
  description: String,
  contactNumber: String,
  operatingHours: String,
  photoUrls: [String], 
  createdBy: { type: String, ref: 'User' }, // Store as String to match User._id
  createdAt: { type: Number, default: Date.now },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  rejectionReason: String,
  nudgeCount: { type: Number, default: 0 },
  lastNudgeAt: { type: Number, default: 0 }
}, { _id: false });
const Service = mongoose.model("Service", ServiceSchema);

const RatingSchema = new mongoose.Schema({
  serviceId: { type: String, ref: 'Service' },
  userId: { type: String, ref: 'User' },
  rating: Number,
  createdAt: { type: Number, default: Date.now }
});
RatingSchema.index({ serviceId: 1, userId: 1 }, { unique: true });
const Rating = mongoose.model("Rating", RatingSchema);

// --- Helper: ImgBB Upload ---
const saveToImgBB = async (base64Str: string): Promise<string> => {
  if (!base64Str || !base64Str.startsWith('data:image')) return base64Str;
  try {
    const base64Data = base64Str.split(',')[1];
    const formData = new URLSearchParams();
    formData.append("image", base64Data);
    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, formData);
    return response.data.data.url;
  } catch (error: any) {
    console.error("ImgBB Upload Error:", error.message);
    return "";
  }
};

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  app.use(express.json({ limit: '10mb' }));

  // --- Auth Routes ---
  app.post("/api/auth/signup", async (req, res) => {
    const id = Math.random().toString(36).substring(2, 15);
    try {
      const newUser = new User({ ...req.body, _id: id });
      await newUser.save();
      res.json({ id, ...req.body });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    try {
      const user = await User.findOne({ email, password });
      if (user) {
        // FIX: Ensure the ID is explicitly returned as 'id' for frontend consistency
        const userData = user.toObject();
        res.json({
          ...userData,
          id: user._id 
        });
      } else {
        res.status(401).json({ error: "Invalid credentials" });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
      const user = await User.findOne({ email });
      if (!user) return res.status(404).json({ error: "Email not found" });

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      user.resetCode = code;
      user.resetCodeExpires = Date.now() + 600000;
      await user.save();

      await resend.emails.send({
        from: 'Service Call <onboarding@resend.dev>',
        to: [email],
        subject: 'Password Reset Code',
        html: `<p>Your reset code is: <strong>${code}</strong></p>`
      });
      res.json({ message: "Code sent" });
    } catch (err) {
      res.status(500).json({ error: "Failed to process reset" });
    }
  });

  app.post("/api/auth/verify-reset-code", async (req, res) => {
    const { email, code } = req.body;
    try {
      const user = await User.findOne({ email, resetCode: code });
      if (user && user.resetCodeExpires && user.resetCodeExpires > Date.now()) {
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid or expired code" });
      }
    } catch (err) {
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    const { email, code, newPassword } = req.body;
    try {
      const user = await User.findOne({ email, resetCode: code });
      if (user && user.resetCodeExpires && user.resetCodeExpires > Date.now()) {
        user.password = newPassword;
        user.resetCode = "";
        user.resetCodeExpires = 0;
        await user.save();
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid or expired code" });
      }
    } catch (err) {
      res.status(500).json({ error: "Reset failed" });
    }
  });

  app.post("/api/auth/change-password", async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    try {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      
      if (user.password !== oldPassword) {
        return res.status(401).json({ error: "Incorrect old password" });
      }

      user.password = newPassword;
      await user.save();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Service Routes ---
  app.get("/api/services", async (req, res) => {
    const { state, town, category, search, createdBy, status, isAdmin, minRating, maxRating } = req.query;
    let filter: any = {};
    if (state) filter.state = state;
    if (town) filter.town = town;
    if (category) filter.category = category;
    
    // If not admin and not looking at own services, only show approved
    if (isAdmin !== 'true' && !createdBy) {
      filter.status = 'approved';
    } else if (status) {
      filter.status = status;
    }

    if (createdBy) filter.createdBy = createdBy;
    
    if (search) {
      filter.$or = [
        { providerName: new RegExp(search as string, 'i') },
        { description: new RegExp(search as string, 'i') }
      ];
    }

    try {
      const services = await Service.find(filter).sort({ createdAt: -1 });
      const enriched = await Promise.all(services.map(async (s: any) => {
        const ratings = await Rating.find({ serviceId: s._id });
        const userObj = await User.findById(s.createdBy);
        
        // FIX: Ensure createdBy and id are strings so frontend comparison works
        return {
          ...s.toObject(),
          id: String(s._id),
          createdBy: String(s.createdBy),
          creatorName: userObj ? `${userObj.firstName} ${userObj.lastName}` : "Unknown",
          avgRating: ratings.length ? ratings.reduce((a, b) => a + b.rating, 0) / ratings.length : 0,
          ratingCount: ratings.length
        };
      }));

      // Filter by rating if provided
      let filtered = enriched;
      if (minRating !== undefined || maxRating !== undefined) {
        const min = parseFloat(minRating as string) || 0;
        const max = parseFloat(maxRating as string) || 5;
        filtered = enriched.filter(s => s.avgRating >= min && s.avgRating <= max);
      }

      res.json(filtered);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/services", async (req, res) => {
    const id = Math.random().toString(36).substring(2, 15);
    try {
      const processedUrls = await Promise.all((req.body.photoUrls || []).map((url: string) => saveToImgBB(url)));
      const newService = new Service({
        ...req.body,
        _id: id,
        photoUrls: processedUrls.filter(u => u !== ""),
        status: 'pending'
      });
      await newService.save();

      // Notify Admin
      try {
        const adminEmail = 'servicecalladmin@gmail.com';
        const emailResponse = await resend.emails.send({
          from: 'Service Call <onboarding@resend.dev>',
          to: [adminEmail],
          subject: 'New Service Submission for Verification',
          html: `
            <h3>New Service Submission</h3>
            <p><strong>Provider:</strong> ${req.body.providerName}</p>
            <p><strong>Category:</strong> ${req.body.category}</p>
            <p><strong>Location:</strong> ${req.body.town}, ${req.body.state}</p>
            <p>Please log in to the admin panel to verify this submission.</p>
          `
        });
        console.log("Admin notification email sent:", emailResponse);
      } catch (emailErr: any) {
        console.error("Admin notification email failed:", emailErr.message);
      }

      res.json({ id, photoUrls: processedUrls });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/services/:id/status", async (req, res) => {
    const { id } = req.params;
    const { status, adminEmail, rejectionReason } = req.body;

    if (adminEmail !== 'servicecalladmin@gmail.com') {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const service = await Service.findById(id);
      if (!service) return res.status(404).json({ error: "Service not found" });

      service.status = status;
      if (status === 'rejected' && rejectionReason) {
        service.rejectionReason = rejectionReason;
      } else if (status === 'approved') {
        service.rejectionReason = "";
      }
      
      await service.save();

      // Notify User
      const user = await User.findById(service.createdBy);
      if (user && user.email) {
        try {
          await resend.emails.send({
            from: 'Service Call <onboarding@resend.dev>',
            to: [user.email],
            subject: `Service Submission ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            html: `
              <h3>Service Submission Status Update</h3>
              <p>Your service submission for <strong>${service.providerName}</strong> has been <strong>${status}</strong>.</p>
              ${status === 'approved' ? '<p>It is now visible to all users.</p>' : `<p><strong>Reason for rejection:</strong> ${rejectionReason || 'No reason provided.'}</p><p>Please log in to your profile to make changes and resubmit.</p>`}
            `
          });
        } catch (emailErr) {
          console.error("User notification email failed:", emailErr);
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/services/:id/nudge", async (req, res) => {
    const { id } = req.params;
    try {
      const service = await Service.findById(id);
      if (!service) return res.status(404).json({ error: "Service not found" });

      const now = Date.now();
      const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
      
      // Reset nudge count if last nudge was more than a week ago
      if (service.lastNudgeAt < oneWeekAgo) {
        service.nudgeCount = 0;
      }

      if (service.nudgeCount >= 3) {
        return res.status(400).json({ error: "Max nudges (3) reached for this week." });
      }

      service.nudgeCount += 1;
      service.lastNudgeAt = now;
      await service.save();

      // Notify Admin
      try {
        const adminEmail = 'servicecalladmin@gmail.com';
        const emailResponse = await resend.emails.send({
          from: 'Service Call <onboarding@resend.dev>',
          to: [adminEmail],
          subject: 'Service Approval Nudge',
          html: `
            <h3>Service Approval Nudge</h3>
            <p>User is nudging for approval of: <strong>${service.providerName}</strong></p>
            <p>This is nudge #${service.nudgeCount} for this week.</p>
          `
        });
        console.log("Admin nudge email sent:", emailResponse);
      } catch (emailErr: any) {
        console.error("Admin nudge email failed:", emailErr.message);
      }

      res.json({ success: true, nudgeCount: service.nudgeCount });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/services/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const processedUrls = await Promise.all((req.body.photoUrls || []).map((url: string) => saveToImgBB(url)));
      const updated = await Service.findByIdAndUpdate(id, {
        ...req.body,
        photoUrls: processedUrls.filter(u => u !== ""),
        status: 'pending', // Reset to pending on edit/resubmission
        rejectionReason: "" // Clear rejection reason
      }, { new: true });
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/services/:id", async (req, res) => {
    await Service.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  });

  // --- Rating Route ---
  app.post("/api/services/:id/rate", async (req, res) => {
    const { id } = req.params;
    const { userId, rating } = req.body;
    
    if (!userId || !rating) return res.status(400).json({ error: "Missing userId or rating" });
    
    try {
      await Rating.findOneAndUpdate(
        { serviceId: id, userId: userId },
        { rating, createdAt: Date.now() },
        { upsert: true, new: true }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Top Categories Route ---
  app.get("/api/top-categories", async (req, res) => {
    try {
      const topCategories = await Service.aggregate([
        { $match: { status: 'approved' } },
        {
          $group: {
            _id: "$category",
            count: { $sum: 1 },
            thumbnails: { $push: { $arrayElemAt: ["$photoUrls", 0] } }
          }
        },
        {
          $project: {
            category: "$_id",
            count: 1,
            thumbnails: {
              $filter: {
                input: "$thumbnails",
                as: "thumb",
                cond: { $and: [ { $ne: ["$$thumb", null] }, { $ne: ["$$thumb", ""] } ] }
              }
            }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 6 },
        {
          $project: {
            _id: 0,
            category: 1,
            count: 1,
            thumbnails: { $slice: ["$thumbnails", 4] }
          }
        }
      ]);
      res.json(topCategories);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Production Build Handling ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
}

startServer();

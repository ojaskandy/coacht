import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth } from "./auth";
import { 
  insertTrackingSettingsSchema, 
  insertUserProfileSchema, 
  insertRecordingSchema, 
  type InsertRecording,
  insertEarlyAccessSchema,
  type InsertEarlyAccess 
} from "@shared/schema";
import { z } from "zod";
import * as fs from 'fs';
import * as path from 'path';

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication routes
  setupAuth(app);
  
  // Early Access Signup - no authentication required
  app.post("/api/early-access", async (req, res) => {
    try {
      // Validate the request body
      const result = insertEarlyAccessSchema.safeParse(req.body);
      
      if (!result.success) {
        return res.status(400).json({ 
          error: "Invalid data", 
          details: result.error.format() 
        });
      }
      
      const signupData: InsertEarlyAccess = result.data;
      
      // Check if email is already registered
      const existingSignup = await storage.getEarlyAccessByEmail(signupData.email);
      if (existingSignup) {
        return res.status(409).json({ 
          message: "This email is already on our waitlist!"
        });
      }
      
      // Save the signup
      const signup = await storage.saveEarlyAccess(signupData);
      
      // Return success
      res.status(201).json({
        success: true,
        message: "You've successfully joined our early access list!",
        timestamp: signup.createdAt
      });
      
    } catch (error) {
      console.error("Error processing early access signup:", error);
      res.status(500).json({ 
        error: "Server error",
        message: "Something went wrong. Please try again later."
      });
    }
  });

  // API endpoints for user settings (protected by auth)
  app.get('/api/settings/:userId', async (req, res) => {
    try {
      // Check if user is authenticated
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const userId = parseInt(req.params.userId);
      
      // Check if user is requesting their own settings
      if (req.user && req.user.id !== userId) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      
      const settings = await storage.getTrackingSettings(userId);
      
      if (settings) {
        res.json(settings);
      } else {
        res.status(404).json({ message: 'Settings not found' });
      }
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      // Check if user is authenticated
      if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // Ensure the settings belong to the authenticated user
      if (req.user && req.body.userId !== req.user.id) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const settings = await storage.saveTrackingSettings(req.body);
      res.status(201).json(settings);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Profile routes
  app.get("/api/profile", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const profile = await storage.getUserProfile(req.user.id);
      const user = await storage.getUser(req.user.id);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Combine user and profile data
      const userData = {
        userId: req.user.id,
        username: user.username,
        lastPracticeDate: user.lastPracticeDate || null,
        recordingsCount: user.recordingsCount || 0,
        goal: profile?.goal || "",
        goalDueDate: profile?.goalDueDate || null,
        galleryImages: profile?.galleryImages || [],
        profileImageUrl: profile?.profileImageUrl || null
      };
      
      res.json(userData);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  app.post("/api/profile", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      // Update the profile
      const profileSchema = insertUserProfileSchema.partial().extend({
        userId: z.number().optional()
      });
      
      const data = profileSchema.parse({
        ...req.body,
        userId: req.user.id
      });
      
      const updatedProfile = await storage.updateUserProfile(req.user.id, data);
      res.json(updatedProfile);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Goal routes
  app.post("/api/goal", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const goalSchema = z.object({
        goal: z.string(),
        goalDueDate: z.string().optional().nullable()
      });
      
      const { goal, goalDueDate } = goalSchema.parse(req.body);
      const updatedProfile = await storage.updateUserGoal(
        req.user.id, 
        goal, 
        goalDueDate ? new Date(goalDueDate) : undefined
      );
      res.json(updatedProfile);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Recording routes
  app.get("/api/recordings", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const recordings = await storage.getRecordings(req.user.id);
      res.json(recordings);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  app.post("/api/recordings", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      // Create a schema that requires fileUrl but makes userId optional
      // (we'll fill it in with the authenticated user's ID)
      const recordingSchema = z.object({
        fileUrl: z.string(),
        title: z.string().optional().nullable(),
        notes: z.string().optional().nullable()
      });
      
      // Parse the incoming request body
      const parsedData = recordingSchema.parse(req.body);
      
      // Now create the actual recording data with the required userId
      const recordingData: InsertRecording = {
        userId: req.user.id,
        fileUrl: parsedData.fileUrl,
        title: parsedData.title || null,
        notes: parsedData.notes || null
      };
      
      const recording = await storage.saveRecording(recordingData);
      
      // Update last practice date
      await storage.updateUserLastPractice(req.user.id);
      
      res.json(recording);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  app.delete("/api/recordings/:id", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid recording ID" });
      }
      
      const success = await storage.deleteRecording(id, req.user.id);
      if (!success) {
        return res.status(404).json({ error: "Recording not found" });
      }
      
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Gallery routes
  app.post("/api/gallery", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const schema = z.object({
        imageUrl: z.string()
      });
      
      const { imageUrl } = schema.parse(req.body);
      const updatedGallery = await storage.addGalleryImage(req.user.id, imageUrl);
      res.json({ galleryImages: updatedGallery });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  app.delete("/api/gallery", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const schema = z.object({
        imageUrl: z.string()
      });
      
      const { imageUrl } = schema.parse(req.body);
      const updatedGallery = await storage.removeGalleryImage(req.user.id, imageUrl);
      res.json({ galleryImages: updatedGallery });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Practice session update route
  app.post("/api/practice", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      // Update the user's last practice date
      const user = await storage.updateUserLastPractice(req.user.id);
      res.json({ lastPracticeDate: user.lastPracticeDate });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // User stats and activity endpoint
  app.get("/api/user-stats", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const recordings = await storage.getRecordings(req.user.id);
      const user = await storage.getUser(req.user.id);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Calculate stats based on recordings
      const totalSessions = recordings.length;
      
      // Calculate total hours (assume average 30 minutes per session if not tracked)
      const totalMinutes = recordings.reduce((total, recording) => {
        // In a real implementation, recording duration would be stored
        return total + 30; // Assuming 30 minutes per recording for now
      }, 0);
      const totalHours = Math.round(totalMinutes / 60);
      
      // Create activity heatmap data
      const activityData = [];
      const today = new Date();
      const startDate = new Date(today);
      startDate.setFullYear(today.getFullYear() - 1);
      
      // Group recordings by date for activity data
      const recordingsByDate = recordings.reduce((acc, recording) => {
        const date = new Date(recording.createdAt);
        const dateString = date.toISOString().split('T')[0];
        
        if (!acc[dateString]) {
          acc[dateString] = { count: 0, minutes: 0 };
        }
        
        acc[dateString].count += 1;
        acc[dateString].minutes += 30; // Assuming 30 minutes per recording
        
        return acc;
      }, {} as Record<string, { count: number, minutes: number }>);
      
      // Fill in the activity data for the past year
      let date = new Date(startDate);
      while (date <= today) {
        const dateString = date.toISOString().split('T')[0];
        const dateActivity = recordingsByDate[dateString];
        
        // Activity level (0-4): 0 = no activity, 4 = high activity
        let level = 0;
        let minutes = 0;
        
        if (dateActivity) {
          minutes = dateActivity.minutes;
          // Convert activity count to level (0-4)
          if (dateActivity.count === 1) level = 1;
          else if (dateActivity.count === 2) level = 2;
          else if (dateActivity.count === 3) level = 3;
          else if (dateActivity.count > 3) level = 4;
        }
        
        activityData.push({
          date: new Date(date),
          level,
          minutes
        });
        
        // Move to next day
        date.setDate(date.getDate() + 1);
      }
      
      // Calculate current and longest streak
      let currentStreak = 0;
      let longestStreak = 0;
      let tempStreak = 0;
      
      // Sort recordings by date (newest first)
      const sortedRecordings = [...recordings].sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      
      // Calculate current streak
      if (sortedRecordings.length > 0) {
        const mostRecentDate = new Date(sortedRecordings[0].createdAt);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        mostRecentDate.setHours(0, 0, 0, 0);
        
        // Calculate days difference
        const diffTime = Math.abs(today.getTime() - mostRecentDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        // If practiced today or yesterday, check for streak
        if (diffDays <= 1) {
          currentStreak = 1; // At least 1 day
          
          // Check for more streak days
          let checkDate = new Date(mostRecentDate);
          checkDate.setDate(checkDate.getDate() - 1); // Start checking from previous day
          
          for (let i = 1; i < sortedRecordings.length; i++) {
            const recordingDate = new Date(sortedRecordings[i].createdAt);
            recordingDate.setHours(0, 0, 0, 0);
            
            // If dates match, increase streak
            if (recordingDate.getTime() === checkDate.getTime()) {
              currentStreak++;
              checkDate.setDate(checkDate.getDate() - 1);
            } else if (recordingDate.getTime() < checkDate.getTime()) {
              // Skip ahead to this date
              checkDate = new Date(recordingDate);
              checkDate.setDate(checkDate.getDate() - 1);
              currentStreak++;
            } else {
              // Streak broken
              break;
            }
          }
        }
      }
      
      // Calculate longest streak (analyze all recordings)
      sortedRecordings.forEach((recording, index) => {
        if (index === 0) {
          tempStreak = 1;
          longestStreak = 1;
          return;
        }
        
        const currentDate = new Date(recording.createdAt);
        const prevDate = new Date(sortedRecordings[index - 1].createdAt);
        
        currentDate.setHours(0, 0, 0, 0);
        prevDate.setHours(0, 0, 0, 0);
        
        // Calculate days difference
        const diffTime = Math.abs(prevDate.getTime() - currentDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays === 1) {
          // Consecutive day
          tempStreak++;
          longestStreak = Math.max(longestStreak, tempStreak);
        } else {
          // Streak broken
          tempStreak = 1;
        }
      });
      
      // Format the response
      const stats = {
        totalSessions,
        totalHours,
        averageSessionLength: totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0,
        currentStreak,
        longestStreak,
        lastSession: sortedRecordings.length > 0 ? sortedRecordings[0].createdAt.toISOString() : null,
        createdAt: user.createdAt ? user.createdAt.toISOString() : new Date().toISOString(),
        activityData,
        beltHistory: [
          { belt: "white", achievedAt: user.createdAt ? user.createdAt.toISOString() : new Date().toISOString() }
          // In a real implementation, belt history would be fetched from a belt_history table
        ]
      };
      
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Landing page image update route
  app.post("/api/landing-images", async (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).send("Unauthorized");
    }
    try {
      const schema = z.object({
        section: z.string(),
        imageUrl: z.string()
      });
      
      const { section, imageUrl } = schema.parse(req.body);
      
      // Write the base64 image to the public folder
      
      // Extract base64 data
      const base64Data = imageUrl.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      
      // Determine file extension from the data URL
      const fileExtension = imageUrl.match(/^data:image\/(\w+);/)?.[1] || 'png';
      
      // Create a unique filename
      const filename = `${section}-${Date.now()}.${fileExtension}`;
      const filepath = path.join(process.cwd(), 'public', 'LandingPageImages', filename);
      
      // Ensure the directory exists
      const dir = path.join(process.cwd(), 'public', 'LandingPageImages');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Write the file
      fs.writeFileSync(filepath, buffer);
      
      res.json({ imageUrl: `/LandingPageImages/${filename}` });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Reference move API routes - for saving and retrieving reference poses
  app.post("/api/reference-moves", async (req, res) => {
    // Anyone can access reference moves, no authentication required
    try {
      const schema = z.object({
        moveId: z.number(),
        name: z.string(),
        category: z.string(),
        imageUrl: z.string(),
        jointAngles: z.record(z.string(), z.number()).optional(),
      });
      
      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error.message });
      }
      
      const move = await storage.saveReferenceMove(result.data);
      res.json(move);
    } catch (error) {
      console.error("Error saving reference move:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Get all reference moves
  app.get("/api/reference-moves", async (req, res) => {
    try {
      const moves = await storage.getAllReferenceMoves();
      res.json(moves);
    } catch (error) {
      console.error("Error getting reference moves:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Get a specific reference move
  app.get("/api/reference-moves/:moveId", async (req, res) => {
    try {
      const moveId = parseInt(req.params.moveId);
      if (isNaN(moveId)) {
        return res.status(400).json({ error: "Invalid move ID" });
      }
      
      const move = await storage.getReferenceMove(moveId);
      if (!move) {
        return res.status(404).json({ error: "Reference move not found" });
      }
      
      res.json(move);
    } catch (error) {
      console.error("Error getting reference move:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

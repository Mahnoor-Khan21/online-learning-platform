// ─────────────────────────────────────────────────────────
// config.js  —  Database models for the Learning Platform
// ─────────────────────────────────────────────────────────

const mongoose = require('mongoose');

// Connect to MongoDB
// Locally this falls back to a local Mongo instance; on Vercel you MUST set
// the MONGODB_URI environment variable to a MongoDB Atlas connection string,
// since Vercel's serverless functions cannot reach "localhost".
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/learning-platform";

mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.log("❌ MongoDB Connection Failed:", err.message));

// ─── USER MODEL ─────────────────────────────────────────
// Each user has a name, email, password, and role
const userSchema = new mongoose.Schema({
    name:     { type: String, required: true, unique: true },
    email:    { type: String, required: true, unique: true },
    password: { type: String, required: true },
    // role decides what the user can do on the platform
    role: {
        type: String,
        enum: ['admin', 'teacher', 'student'], // only these 3 values allowed
        default: 'student'
    }
}, { timestamps: true }); // adds createdAt and updatedAt automatically

const User = mongoose.model("users", userSchema);

// ─── COURSE MODEL ────────────────────────────────────────
// Each course has a title, description, who made it, and who enrolled
const courseSchema = new mongoose.Schema({
    title:       { type: String, required: true },
    description: { type: String, required: true },
    category:    { type: String, default: 'General' },  // e.g. Web Dev, Design
    duration:    { type: String, default: '4 weeks' },  // e.g. "4 weeks"
    level:       { type: String, default: 'Beginner' }, // Beginner / Intermediate / Advanced

    // Teacher who created this course
    // mongoose.Schema.Types.ObjectId links to another document (_id of a User)
    teacherId:   { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    teacherName: { type: String, required: true }, // stored for easy display

    // List of student IDs who enrolled in this course
    enrolledStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }]

}, { timestamps: true });

const Course = mongoose.model("courses", courseSchema);

// Export both models so index.js can use them
module.exports = { User, Course };

// ─────────────────────────────────────────────────────────
// config.js  —  Database models for the Learning Platform
// ─────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const isProduction = process.env.NODE_ENV === 'production';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    if (isProduction) {
        throw new Error('MONGODB_URI is required in production. Add your MongoDB Atlas connection string in Vercel.');
    }

    console.warn('MONGODB_URI is not set. Local development requires MongoDB at 127.0.0.1:27017.');
}

const databaseConnection = mongoose.connect(MONGODB_URI || 'mongodb://127.0.0.1:27017/learning-platform');
databaseConnection
    .then(() => console.log('✅ MongoDB Connected'))
    .catch((err) => console.error('❌ MongoDB Connection Failed:', err.message));

// ─── USER MODEL ─────────────────────────────────────────
// Each user has a name, email, password, and role
const userSchema = new mongoose.Schema({
    name:     { type: String, required: true, unique: true },
    email:    { type: String, required: true, unique: true },
    password: { type: String, required: true },

    // Email verification fields
    emailVerified: { type: Boolean, default: false },
    verificationToken: { type: String, default: null },
    verificationTokenExpires: { type: Date, default: null },

    // Password reset fields
    resetPasswordToken: { type: String, default: null },
    resetPasswordTokenExpires: { type: Date, default: null },

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
module.exports = { User, Course, databaseConnection };

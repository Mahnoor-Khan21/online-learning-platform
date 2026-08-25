// ─────────────────────────────────────────────────────────
// config.js  —  Database models for the Learning Platform
// ─────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const isProduction = process.env.NODE_ENV === 'production';

// Local development may use a local MongoDB instance, but Vercel must use an
// environment variable. We log a clear warning instead of silently assuming
// localhost in production.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/learning-platform';

if (isProduction && !process.env.MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI is not set. Vercel requires a hosted MongoDB connection string. Falling back to local MongoDB for development only.');
}

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch((err) => console.log('❌ MongoDB Connection Failed:', err.message));

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

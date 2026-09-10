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

    // Profile fields
    bio: { type: String, default: '', maxlength: 500 },
    profilePicture: { type: String, default: null },

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
    title:       { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    thumbnail:   { type: String, default: '' },
    category:    { type: String, default: 'General' },
    duration:    { type: String, default: '4 weeks' },
    level:       { type: String, enum: ['Beginner','Intermediate','Advanced'], default: 'Beginner' },
    learningOutcomes: [{ type: String, trim: true }],
    lessons: [{
        title: { type: String, required: true, trim: true },
        description: { type: String, default: '', trim: true },
        duration: { type: String, default: '10 min' },
        videoUrl: { type: String, default: '' },
        content: { type: String, default: '' },
        resources: [{ name: String, type: String, url: String }]
    }],
    price: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0, max: 100 },
    teacherId:   { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    teacherName: { type: String, required: true },
    enrolledStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }],
    completedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }],
    progress: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
        completedLessons: [{ type: Number }],
        currentLesson: { type: Number, default: 0 },
        updatedAt: { type: Date, default: Date.now }
    }],
    reviews: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
        userName: { type: String, required: true },
        profilePicture: { type: String, default: '' },
        rating: { type: Number, min: 1, max: 5, required: true },
        comment: { type: String, default: '', maxlength: 500 },
        createdAt: { type: Date, default: Date.now }
    }],
    rating: { type: Number, min: 0, max: 5, default: 0 },
    quizzes: [{
        name: { type: String, default: 'Course Quiz', trim: true },
        questions: [{
            question: { type: String, required: true, trim: true },
            options: [{ type: String, required: true, trim: true }],
            correctAnswer: { type: Number, min: 0, max: 3, required: true }
        }]
    }]
}, { timestamps: true });

const Course = mongoose.model("courses", courseSchema);

const quizAttemptSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    userName: { type: String, required: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true },
    courseName: { type: String, required: true },
    quizName: { type: String, required: true },
    totalQuestions: { type: Number, required: true },
    correctAnswers: { type: Number, required: true },
    wrongAnswers: { type: Number, required: true },
    score: { type: Number, required: true },
    percentage: { type: Number, required: true },
    passed: { type: Boolean, required: true },
    attemptedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const QuizAttempt = mongoose.model("quiz_attempts", quizAttemptSchema);

// ─── CERTIFICATE MODEL ───────────────────────────────────
// One certificate per student/course, created only after all required
// lessons are complete and the required quiz/quiz(es) are passed.
const certificateSchema = new mongoose.Schema({
    certificateId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    studentName: { type: String, required: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true },
    courseName: { type: String, required: true },
    instructorName: { type: String, required: true },
    platformName: { type: String, default: 'LearnHub' },
    completionDate: { type: Date, default: Date.now }
}, { timestamps: true });
certificateSchema.index({ userId: 1, courseId: 1 }, { unique: true });
const Certificate = mongoose.model("certificates", certificateSchema);

// ─── NOTIFICATION MODEL ─────────────────────────────────
const notificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    type: {
        type: String,
        enum: ['course', 'enrollment', 'quiz', 'completion', 'certificate', 'announcement', 'system'],
        default: 'system'
    },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    link: { type: String, default: '' },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}, { timestamps: false });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
const Notification = mongoose.model("notifications", notificationSchema);

// ─── CATEGORY MODEL ─────────────────────────────────────
const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    createdAt: { type: Date, default: Date.now }
});
const Category = mongoose.model('categories', categorySchema);


// ─── LMS FEATURE MODELS ──────────────────────────────────
const attendanceSchema = new mongoose.Schema({
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true, index: true },
    lessonIndex: { type: Number, default: null },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    status: { type: String, enum: ['present','absent'], required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    date: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
attendanceSchema.index({ courseId: 1, studentId: 1, date: 1 });
const Attendance = mongoose.model('attendances', attendanceSchema);

const liveClassSchema = new mongoose.Schema({
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true, index: true },
    title: { type: String, required: true, maxlength: 160 },
    description: { type: String, default: '', maxlength: 1000 },
    date: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 60 },
    meetingLink: { type: String, default: '' },
    status: { type: String, enum: ['upcoming','past','cancelled'], default: 'upcoming' },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true }
}, { timestamps: true });
const LiveClass = mongoose.model('live_classes', liveClassSchema);

const assignmentSchema = new mongoose.Schema({
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true, index: true },
    title: { type: String, required: true, maxlength: 160 },
    description: { type: String, default: '', maxlength: 5000 },
    dueDate: { type: Date, required: true },
    maxMarks: { type: Number, default: 100 },
    attachmentName: { type: String, default: '' },
    attachmentUrl: { type: String, default: '' },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true }
}, { timestamps: true });
const Assignment = mongoose.model('assignments', assignmentSchema);

const assignmentSubmissionSchema = new mongoose.Schema({
    assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'assignments', required: true, index: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    text: { type: String, default: '', maxlength: 10000 },
    fileName: { type: String, default: '' },
    fileUrl: { type: String, default: '' },
    submittedAt: { type: Date, default: Date.now },
    marks: { type: Number, default: null },
    feedback: { type: String, default: '', maxlength: 3000 },
    gradedAt: { type: Date, default: null }
}, { timestamps: true });
assignmentSubmissionSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });
const AssignmentSubmission = mongoose.model('assignment_submissions', assignmentSubmissionSchema);

const discussionPostSchema = new mongoose.Schema({
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    userName: { type: String, required: true },
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, required: true, maxlength: 5000 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }],
    answerId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, { timestamps: true });
const DiscussionPost = mongoose.model('discussion_posts', discussionPostSchema);

const noteSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true },
    lessonIndex: { type: Number, required: true },
    content: { type: String, required: true, maxlength: 5000 }
}, { timestamps: true });
const Note = mongoose.model('notes', noteSchema);

const bookmarkSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true },
    lessonIndex: { type: Number, required: true }
}, { timestamps: true });
bookmarkSchema.index({ userId: 1, courseId: 1, lessonIndex: 1 }, { unique: true });
const Bookmark = mongoose.model('bookmarks', bookmarkSchema);

const wishlistSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true }
}, { timestamps: true });
wishlistSchema.index({ userId: 1, courseId: 1 }, { unique: true });
const Wishlist = mongoose.model('wishlists', wishlistSchema);

const learningLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', required: true },
    minutes: { type: Number, min: 1, max: 1440, required: true },
    date: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
const LearningLog = mongoose.model('learning_logs', learningLogSchema);

const messageSchema = new mongoose.Schema({
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    body: { type: String, required: true, maxlength: 5000 },
    readAt: { type: Date, default: null }
}, { timestamps: true });
const Message = mongoose.model('messages', messageSchema);

const reportSchema = new mongoose.Schema({
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'courses', default: null },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
    reason: { type: String, required: true, maxlength: 160 },
    details: { type: String, default: '', maxlength: 3000 },
    status: { type: String, enum: ['open','resolved'], default: 'open' }
}, { timestamps: true });
const Report = mongoose.model('reports', reportSchema);

const badgeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    icon: { type: String, required: true },
    earnedAt: { type: Date, default: Date.now }
});
badgeSchema.index({ userId: 1, key: 1 }, { unique: true });
const Badge = mongoose.model('badges', badgeSchema);

// Export all models so index.js can use them
module.exports = { User, Course, QuizAttempt, Certificate, Notification, Category, Attendance, LiveClass, Assignment, AssignmentSubmission, DiscussionPost, Note, Bookmark, Wishlist, LearningLog, Message, Report, Badge, databaseConnection };

require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local' });

// ─────────────────────────────────────────────────────────
// index.js  —  Online Learning Platform Server
// ─────────────────────────────────────────────────────────

// ── IMPORTS ──────────────────────────────────────────────
const path       = require('path');
const express    = require('express');
const bcrypt     = require('bcrypt');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const { User, Course, QuizAttempt, Certificate, Notification, Category, Attendance, LiveClass, Assignment, AssignmentSubmission, DiscussionPost, Note, Bookmark, Wishlist, LearningLog, Message, Report, Badge, databaseConnection } = require('./config');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./email');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/learning-platform';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (process.env.NODE_ENV === 'production' && !SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production. Add it in Vercel Environment Variables.');
}

databaseConnection.then(() => Course.updateMany({ status: { $exists: false } }, { $set: { status: 'published' } }).catch(() => {}));

// ── APP SETUP ────────────────────────────────────────────
const app = express();

// Profile-picture uploads are kept in memory and stored as a validated data URL
// on the user document. This works on serverless deployments without relying on
// an ephemeral local uploads directory.
const profileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowed.includes(file.mimetype)) {
            return cb(new Error('Only JPG, PNG, WEBP, and GIF images are allowed.'));
        }
        cb(null, true);
    }
});

const courseUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowed.includes(file.mimetype)) return cb(new Error('Only JPG, PNG, WEBP, and GIF course thumbnails are allowed.'));
        cb(null, true);
    }
});

const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, true)
});
function dataUrlFromFile(file) {
    return file ? `data:${file.mimetype};base64,${file.buffer.toString('base64')}` : '';
}
function escapeRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function awardBadge(userId, key, name, icon) {
    try { await Badge.updateOne({userId, key}, {$setOnInsert:{userId,key,name,icon}}, {upsert:true}); } catch(e) {}
}
async function updateLearningStreak(userId) {
    const u=await User.findById(userId); if(!u) return;
    const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const last=u.lastLearningDate ? new Date(u.lastLearningDate) : null;
    if (!last) u.streak=1;
    else {
        const prev=new Date(last.getFullYear(),last.getMonth(),last.getDate());
        const diff=Math.round((today-prev)/86400000);
        if(diff===1) u.streak=(u.streak||0)+1;
        else if(diff>1) u.streak=1;
    }
    u.lastLearningDate=now; await u.save();
    if((u.streak||0)>=7) await awardBadge(userId,'streak7','7 Day Learning Streak','🔥');
}
function handleCourseUpload(req, res, next) {
    courseUpload.single('thumbnailFile')(req, res, err => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'Course thumbnail must be 2 MB or smaller.' : (err.message || 'Could not upload course thumbnail.');
        return res.status(400).send(message);
    });
}


// Convert upload errors into a normal profile-page message instead of a generic 500.
function handleProfileUpload(req, res, next) {
    profileUpload.single('profilePicture')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'Profile picture must be 2 MB or smaller.'
            : (err.message || 'Could not upload the profile picture.');
        return res.redirect('/profile?error=' + encodeURIComponent(message));
    });
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Use absolute paths (based on this file's location) so static/view
// lookups work regardless of the working directory Vercel runs from.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.set('views', path.join(__dirname, '..', 'views'));

const sessionStore = process.env.MONGODB_URI
    ? MongoStore.create({ mongoUrl: MONGODB_URI })
    : undefined;

if (!process.env.MONGODB_URI && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ SESSION store is using the default in-memory fallback because MONGODB_URI is missing. Set MONGODB_URI in Vercel for persistent sessions.');
}

// ── SESSIONS ─────────────────────────────────────────────
app.use(session({
    secret: SESSION_SECRET || 'learnSecret123',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 3,
        secure: process.env.NODE_ENV === 'production'
    },
    proxy: true
}));

app.set('view engine', 'ejs');

// ── NOTIFICATIONS ────────────────────────────────────────
async function createNotification(userId, type, title, message, link = '') {
    if (!userId) return null;
    try { return await Notification.create({ userId, type, title, message, link }); }
    catch (err) { console.error('Notification create error:', err.message); return null; }
}
async function notifyUsers(userIds, type, title, message, link = '') {
    const ids = [...new Set((userIds || []).map(id => String(id)).filter(Boolean))];
    if (!ids.length) return;
    try { await Notification.insertMany(ids.map(userId => ({ userId, type, title, message, link })), { ordered: false }); }
    catch (err) { console.error('Notification bulk create error:', err.message); }
}
app.use(async (req, res, next) => {
    res.locals.notificationUnreadCount = 0; res.locals.notificationItems = []; res.locals.currentUser = null;
    if (!req.session.userId) return next();
    try {
        const [unread, items, currentUser] = await Promise.all([
            Notification.countDocuments({ userId: req.session.userId, readAt: null }),
            Notification.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(8).lean(),
            User.findById(req.session.userId).select('name email role profilePicture').lean()
        ]);
        res.locals.currentUser = currentUser;
        res.locals.notificationUnreadCount = unread; res.locals.notificationItems = items;
    } catch (err) { console.error('Notification navbar error:', err.message); }
    next();
});

// ─────────────────────────────────────────────────────────
//  MIDDLEWARE HELPERS
// ─────────────────────────────────────────────────────────

// Only logged-in users can access the page
async function requireLogin(req, res, next) {
    if (!req.session.userId) return res.redirect('/login');
    try { const u=await User.findById(req.session.userId,{sessionVersion:1,active:1}); if(!u||u.active===false||(u.sessionVersion||0)!==(req.session.sessionVersion||0)){req.session.destroy(()=>{});return res.redirect('/login');} next(); } catch(e){ return res.redirect('/login'); }
}

// Only users with the right role can access the page
// Usage: requireRole('admin') or requireRole('admin', 'teacher')
function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.session.userRole)) {
            return res.render('access-denied', {
                name: req.session.userName,
                role: req.session.userRole
            });
        }
        next();
    };
}

// ─────────────────────────────────────────────────────────
//  PUBLIC ROUTES
// ─────────────────────────────────────────────────────────

// Landing page
app.get('/', (req, res) => {
    res.render('home');
});

// Show login form
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.render('login');
});

// Handle login form submission
app.post('/login', async (req, res) => {
    try {
        await databaseConnection;
        const { email, password } = req.body;

        if (!email || !password)
            return res.render('login', { error: 'Please fill in all fields.' });

        const user = await User.findOne({ email });
        if (!user)
            return res.render('login', { error: 'Invalid email or password.' });
        if (user.active === false) return res.render('login', { error: 'Your account is inactive. Please contact an administrator.' });

        const match = await bcrypt.compare(password, user.password);
        if (!match)
            return res.render('login', { error: 'Invalid email or password.' });

        // New accounts must verify their email before they can log in.
        // Existing users created before this feature (without emailVerified)
        // are still allowed to log in.
        if (user.emailVerified === false) {
            // Try to send a fresh verification email automatically when login
            // is attempted. If SMTP fails, the user can use the Resend button.
            let verificationSendError = false;
            try {
                const verificationToken = crypto.randomBytes(32).toString('hex');
                user.verificationToken = verificationToken;
                user.verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
                await user.save();

                await sendVerificationEmail({
                    to: user.email,
                    name: user.name,
                    token: verificationToken
                });
            } catch (emailError) {
                verificationSendError = true;
                console.error('Automatic verification email error:', emailError);
            }

            return res.render('login', {
                error: 'Please verify your email before logging in. Check your inbox for the verification link.',
                showResendVerification: true,
                verificationEmail: user.email,
                verificationSendError
            });
        }

        // Save user info in session
        req.session.userId   = user._id;
        req.session.userName = user.name;
        req.session.userRole = user.role;
        req.session.sessionVersion = user.sessionVersion || 0;
        user.loginActivity = [{at:new Date(),ip:req.ip,userAgent:req.get('user-agent')||''},...(user.loginActivity||[])].slice(0,10); await user.save();

        res.redirect('/dashboard');

    } catch (err) {
        console.error('Login error:', err);
        res.render('login', { error: 'Something went wrong. Please try again.' });
    }
});

// ── PASSWORD RESET ───────────────────────────────────────
// Show forgot-password form
app.get('/forgot-password', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.render('forgot-password');
});

// Send a password reset link to the user's email
app.post('/forgot-password', async (req, res) => {
    try {
        await databaseConnection;
        const email = String(req.body.email || '').trim().toLowerCase();

        if (!email) {
            return res.render('forgot-password', { error: 'Please enter your email address.' });
        }

        const user = await User.findOne({ email });

        // Use the same response for existing and non-existing emails.
        // This avoids revealing which emails have accounts.
        if (!user) {
            return res.render('forgot-password', {
                success: 'If an account exists for this email, a password reset link has been sent.'
            });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

        user.resetPasswordToken = resetTokenHash;
        user.resetPasswordTokenExpires = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        try {
            await sendPasswordResetEmail({
                to: user.email,
                name: user.name,
                token: resetToken
            });
        } catch (emailError) {
            // Do not leave an active reset token if email delivery failed.
            user.resetPasswordToken = null;
            user.resetPasswordTokenExpires = null;
            await user.save();
            console.error('Password reset email error:', emailError);
            return res.render('forgot-password', {
                error: 'The reset email could not be sent. Please try again.'
            });
        }

        res.render('forgot-password', {
            success: 'If an account exists for this email, a password reset link has been sent.'
        });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.render('forgot-password', { error: 'Something went wrong. Please try again.' });
    }
});

// Show reset-password form after the user opens the email link
app.get('/reset-password/:token', async (req, res) => {
    try {
        const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
        const user = await User.findOne({
            resetPasswordToken: tokenHash,
            resetPasswordTokenExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.render('reset-result', {
                success: false,
                message: 'This password reset link is invalid or has expired. Please request a new one.'
            });
        }

        res.render('reset-password', { token: req.params.token });
    } catch (err) {
        console.error('Reset password page error:', err);
        res.render('reset-result', {
            success: false,
            message: 'Something went wrong. Please request a new password reset link.'
        });
    }
});

// Save the new password
app.post('/reset-password/:token', async (req, res) => {
    try {
        await databaseConnection;
        const { password, confirmPassword } = req.body;

        if (!password || !confirmPassword) {
            return res.render('reset-password', {
                token: req.params.token,
                error: 'Please fill in both password fields.'
            });
        }

        if (password.length < 6) {
            return res.render('reset-password', {
                token: req.params.token,
                error: 'Password must be at least 6 characters long.'
            });
        }

        if (password !== confirmPassword) {
            return res.render('reset-password', {
                token: req.params.token,
                error: 'Passwords do not match.'
            });
        }

        const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
        const user = await User.findOne({
            resetPasswordToken: tokenHash,
            resetPasswordTokenExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.render('reset-result', {
                success: false,
                message: 'This password reset link is invalid or has expired. Please request a new one.'
            });
        }

        user.password = await bcrypt.hash(password, 10);
        user.resetPasswordToken = null;
        user.resetPasswordTokenExpires = null;
        await user.save();

        res.render('reset-result', {
            success: true,
            message: 'Your password has been reset successfully. You can now log in with your new password.'
        });
    } catch (err) {
        console.error('Reset password error:', err);
        res.render('reset-result', {
            success: false,
            message: 'Something went wrong while resetting your password. Please try again.'
        });
    }
});

// Show signup form
app.get('/signup', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.render('signup');
});

// Handle signup form submission
app.post('/signup', async (req, res) => {
    try {
        await databaseConnection;
        const { username, email, password } = req.body;

        if (!username || !email || !password)
            return res.render('signup', { error: 'All fields are required.' });

        // Public signup can only create student accounts. Admin assigns instructor/admin roles.
        const userRole = 'student';

        // Check if email or name already exists
        const existing = await User.findOne({ $or: [{ email }, { name: username }] });
        if (existing)
            return res.render('signup', { error: 'Email or username is already taken. Try a different one.' });

        // Hash the password before saving
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create a secure, single-use verification token that expires in 24 hours.
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const user = await User.create({
            name: username,
            email,
            password: hashedPassword,
            role: userRole,
            emailVerified: false,
            verificationToken,
            verificationTokenExpires
        });

        try {
            await sendVerificationEmail({
                to: user.email,
                name: user.name,
                token: verificationToken
            });
        } catch (emailError) {
            // Do not leave an account that cannot be verified if email delivery fails.
            await User.findByIdAndDelete(user._id);
            console.error('Verification email error:', emailError);
            return res.render('signup', {
                error: 'Account could not be created because the verification email could not be sent. Please try again.'
            });
        }

        res.render('verify-pending', { email: user.email });

    } catch (err) {
        console.error('Signup error:', err);
        // Handle MongoDB duplicate key error (code 11000)
        if (err.code === 11000) {
            return res.render('signup', { error: 'Username or email already exists. Please choose another.' });
        }
        res.render('signup', { error: 'Something went wrong. Please try again.' });
    }
});

// Resend verification email manually from the login page
app.post('/resend-verification', async (req, res) => {
    try {
        await databaseConnection;
        const email = String(req.body.email || '').trim().toLowerCase();

        if (!email) {
            return res.render('login', { error: 'Please enter your email address.' });
        }

        const user = await User.findOne({ email });

        // Do not reveal whether an email is registered.
        if (!user) {
            return res.render('login', {
                success: 'If this email belongs to an account, a verification email has been sent.'
            });
        }

        if (user.emailVerified !== false) {
            return res.render('login', {
                success: 'This email is already verified. You can log in.'
            });
        }

        // Create a fresh verification token that expires in 24 hours.
        const verificationToken = crypto.randomBytes(32).toString('hex');
        user.verificationToken = verificationToken;
        user.verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await user.save();

        try {
            await sendVerificationEmail({
                to: user.email,
                name: user.name,
                token: verificationToken
            });
        } catch (emailError) {
            console.error('Resend verification email error:', emailError);
            return res.render('login', {
                error: 'The verification email could not be sent. Please try again.',
                showResendVerification: true,
                verificationEmail: user.email
            });
        }

        res.render('login', {
            success: 'A new verification email has been sent. Please check your inbox.',
            showResendVerification: true,
            verificationEmail: user.email
        });
    } catch (err) {
        console.error('Resend verification error:', err);
        res.render('login', { error: 'Something went wrong. Please try again.' });
    }
});

// Verify email address from the link sent after signup
app.get('/verify-email', async (req, res) => {
    try {
        const { token } = req.query;

        if (!token) {
            return res.render('verify-result', {
                success: false,
                message: 'Verification link is missing or invalid.'
            });
        }

        const user = await User.findOne({
            verificationToken: token,
            verificationTokenExpires: { $gt: new Date() }
        });

        if (!user) {
            return res.render('verify-result', {
                success: false,
                message: 'This verification link is invalid or has expired. Please sign up again to receive a new link.'
            });
        }

        user.emailVerified = true;
        user.verificationToken = null;
        user.verificationTokenExpires = null;
        await user.save();

        res.render('verify-result', {
            success: true,
            message: 'Your email has been verified successfully. You can now log in.'
        });

    } catch (err) {
        console.error('Email verification error:', err);
        res.render('verify-result', {
            success: false,
            message: 'Something went wrong while verifying your email. Please try again.'
        });
    }
});

// Logout — destroy session
app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Logout confirmation page
app.get('/logout-confirm', requireLogin, (req, res) => {
    res.render('logout-confirm', { name: req.session.userName });
});

// ─────────────────────────────────────────────────────────
//  NOTIFICATIONS
// ─────────────────────────────────────────────────────────
app.get('/notifications', requireLogin, async (req, res) => {
    try { const notifications = await Notification.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(100).lean(); res.render('notifications', { name: req.session.userName, role: req.session.userRole, notifications }); }
    catch (err) { console.error('Notifications page error:', err); res.redirect('/dashboard'); }
});
app.post('/notifications/:id/read', requireLogin, async (req, res) => {
    try { await Notification.updateOne({ _id: req.params.id, userId: req.session.userId }, { $set: { readAt: new Date() } }); } catch (err) { console.error('Mark notification read error:', err); }
    if (req.headers.accept && req.headers.accept.includes('application/json')) return res.json({ ok: true });
    res.redirect(req.get('referer') || '/notifications');
});
app.post('/notifications/read-all', requireLogin, async (req, res) => {
    try { await Notification.updateMany({ userId: req.session.userId, readAt: null }, { $set: { readAt: new Date() } }); } catch (err) { console.error('Mark all notifications read error:', err); }
    if (req.headers.accept && req.headers.accept.includes('application/json')) return res.json({ ok: true });
    res.redirect('/notifications');
});
app.post('/admin/announcements', requireLogin, requireRole('admin', 'teacher'), async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 160), message = String(req.body.message || '').trim().slice(0, 500), link = String(req.body.link || '/notifications').trim().slice(0, 300);
    if (!title || !message) return res.status(400).send('Announcement title and message are required.');
    try { const students = await User.find({ role: 'student' }).select('_id').lean(); await notifyUsers(students.map(s => s._id), 'announcement', title, message, link); res.redirect('/dashboard'); }
    catch (err) { console.error('Announcement error:', err); res.status(500).send('Could not publish announcement.'); }
});

// ─────────────────────────────────────────────────────────
//  DASHBOARD  (role-based)
// ─────────────────────────────────────────────────────────

app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        const { userName, userRole, userId } = req.session;
        let data = { name: userName, role: userRole, userId };

        if (userRole === 'admin') {
            const [totalStudents, totalInstructors, totalCourses, users, allCourses] = await Promise.all([
                User.countDocuments({ role: 'student' }), User.countDocuments({ role: 'teacher' }), Course.countDocuments(),
                User.find({}, { password: 0, resetPasswordToken: 0, verificationToken: 0 }).sort({ createdAt: -1 }).limit(8).lean(), Course.find().lean()
            ]);
            const totalEnrollments = allCourses.reduce((n, c) => n + (c.enrolledStudents || []).length, 0);
            const completedCourses = allCourses.reduce((n, c) => n + (c.completedStudents || []).length, 0);
            const reviewCount = allCourses.reduce((n, c) => n + (c.reviews || []).length, 0);
            const ratingSum = allCourses.reduce((n, c) => n + (c.reviews || []).reduce((a, r) => a + Number(r.rating || 0), 0), 0);
            data.totalUsers = await User.countDocuments(); data.totalStudents = totalStudents; data.totalInstructors = totalInstructors; data.totalCourses = totalCourses;
            data.totalEnrollments = totalEnrollments; data.completedCourses = completedCourses; data.averageRating = reviewCount ? Math.round((ratingSum / reviewCount) * 10) / 10 : 0;
            data.recentUsers = users; data.recentCourses = allCourses.sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,8);

        } else if (userRole === 'teacher') {
            const myCourses = await Course.find({ teacherId: userId }).lean();
            const courseIds = myCourses.map(c => c._id);
            const enrollments = myCourses.reduce((n, c) => n + (c.enrolledStudents || []).length, 0);
            const studentIds = [...new Set(myCourses.flatMap(c => (c.enrolledStudents || []).map(id => String(id))))];
            const totalRatingCount = myCourses.reduce((n, c) => n + (c.reviews || []).length, 0);
            const ratingSum = myCourses.reduce((n, c) => n + (c.reviews || []).reduce((a, r) => a + Number(r.rating || 0), 0), 0);
            data.myCourses = myCourses;
            data.totalCourses = myCourses.length;
            data.totalStudents = studentIds.length;
            data.totalEnrollments = enrollments;
            data.averageRating = totalRatingCount ? Math.round((ratingSum / totalRatingCount) * 10) / 10 : 0;
            data.coursePerformance = myCourses.map(c => {
                const total = (c.lessons || []).length;
                const completed = (c.completedStudents || []).length;
                return { ...c, enrollmentCount: (c.enrolledStudents || []).length, completedCount: completed, completionRate: (c.enrolledStudents || []).length ? Math.round(completed / c.enrolledStudents.length * 100) : 0, reviewCount: (c.reviews || []).length };
            });

        } else {
            // student dashboard
            const enrolled = await Course.find({ enrolledStudents: userId }).sort({ updatedAt: -1 }).lean();
            const allCourses = await Course.find().sort({ createdAt: -1 }).lean();
            const uid = userId.toString();

            const withProgress = enrolled.map(c => {
                const p = (c.progress || []).find(x => x.userId && x.userId.toString() === uid);
                const total = (c.lessons || []).length;
                const completed = p ? (p.completedLessons || []).length : 0;
                const progressPercent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
                const currentLesson = p && Number.isInteger(p.currentLesson) ? p.currentLesson : 0;
                return {
                    ...c,
                    lessonCount: total,
                    completedLessons: completed,
                    progressPercent,
                    currentLesson,
                    currentLessonTitle: c.lessons?.[currentLesson]?.title || '',
                    lastWatchedAt: p?.updatedAt || null,
                    isCompleted: total > 0 && completed >= total
                };
            });

            const completed = withProgress.filter(c => c.isCompleted);
            const inProgress = withProgress.filter(c => !c.isCompleted && c.progressPercent > 0);
            const recentlyWatched = withProgress
                .filter(c => c.lastWatchedAt)
                .sort((a,b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt))
                .slice(0, 4);
            const continueLearning = withProgress
                .filter(c => !c.isCompleted)
                .sort((a,b) => new Date(b.lastWatchedAt || 0) - new Date(a.lastWatchedAt || 0))[0] || null;
            const recommended = allCourses
                .filter(c => !(c.enrolledStudents || []).some(id => id.toString() === uid))
                .slice(0, 4)
                .map(c => ({ ...c, lessonCount: (c.lessons || []).length }));
            const overallProgress = withProgress.length
                ? Math.round(withProgress.reduce((sum, c) => sum + c.progressPercent, 0) / withProgress.length)
                : 0;

            data.enrolledCourses = withProgress;
            data.completedCourses = completed.length;
            data.inProgressCourses = inProgress.length;
            data.overallProgress = overallProgress;
            data.continueLearning = continueLearning;
            data.recentlyWatched = recentlyWatched;
            data.completedCourseList = completed;
            data.recommendedCourses = recommended;
            const [studentUser, studentAttendance, studentLogs] = await Promise.all([User.findById(userId,{streak:1}).lean(), Attendance.find({studentId:userId}).lean(), LearningLog.find({userId:userId}).lean()]);
            data.streak = studentUser?.streak || 0; data.attendancePercent = studentAttendance.length ? Math.round(studentAttendance.filter(x=>x.status==='present').length/studentAttendance.length*100) : 0; data.learningMinutes = studentLogs.reduce((n,x)=>n+x.minutes,0);
        }

        res.render('dashboard', data);

    } catch (err) {
        console.error('Dashboard error:', err);
        res.redirect('/login');
    }
});

// ─────────────────────────────────────────────────────────
//  COURSES
// ─────────────────────────────────────────────────────────
async function getCategories() {
    let categories = await Category.find().sort({ name: 1 }).lean();
    if (!categories.length) {
        const defaults = ['General','Web Development','Data Science','Design','Business','Marketing','Programming','Mathematics','Science','Language'];
        try { await Category.insertMany(defaults.map(name => ({ name })), { ordered: false }); } catch (e) {}
        categories = await Category.find().sort({ name: 1 }).lean();
    }
    return categories;
}


function normalizeList(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
}

function parseQuizzes(value) {
    return normalizeList(value).map((line, index) => {
        const parts = line.split('|').map(v => v.trim());
        const options = parts.slice(1, 5).filter(Boolean);
        const correctAnswer = Number(parts[5]);
        if (!parts[0] || options.length !== 4 || !Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) return null;
        return { question: parts[0], options, correctAnswer };
    }).filter(Boolean);
}

function parseLessons(value) {
    return normalizeList(value).map((line, index) => {
        const parts = line.split('|').map(v => v.trim());
        return {
            title: parts[0] || `Lesson ${index + 1}`,
            description: parts[1] || '',
            duration: parts[2] || '10 min',
            videoUrl: parts[3] || '',
            content: parts.slice(4).join(' | ') || ''
        };
    });
}

// Browse and discover courses with search, filters, sorting, and pagination
app.get('/courses', requireLogin, async (req, res) => {
    try {
        const { userId, userName, userRole } = req.session;
        const search = String(req.query.search || '').trim();
        const category = String(req.query.category || '').trim();
        const level = String(req.query.level || '').trim();
        const sort = ['newest', 'popular', 'rating'].includes(String(req.query.sort || 'newest')) ? String(req.query.sort || 'newest') : 'newest';
        const requestedRating = Number(req.query.rating || 0);
        const rating = [0, 1, 2, 3, 4, 4.5].includes(requestedRating) ? requestedRating : 0;
        const requestedPage = Number.parseInt(req.query.page, 10);
        const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
        const pageSize = 9;

        const filter = {};
        const andConditions = [];
        if (search) andConditions.push({ $or: [
            { title: { $regex: search, $options: 'i' } },
            { teacherName: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
            { 'lessons.title': { $regex: search, $options: 'i' } },
            { 'lessons.description': { $regex: search, $options: 'i' } },
            { 'lessons.content': { $regex: search, $options: 'i' } }
        ] });
        if (category) filter.category = category;
        if (level) filter.level = level;
        if (rating) filter.rating = { $gte: rating };
        if (userRole === 'student') andConditions.push({ $or: [{ status: 'published' }, { status: { $exists: false } }] });
        if (andConditions.length) filter.$and = andConditions;

        let sortSpec = { createdAt: -1 };
        if (sort === 'popular') sortSpec = { enrolledStudentsCount: -1, createdAt: -1 };
        if (sort === 'rating') sortSpec = { rating: -1, createdAt: -1 };

        // Keep the enrolled-student count available for popular sorting without changing the Course schema.
        const pipeline = [
            { $match: filter },
            { $addFields: { enrolledStudentsCount: { $size: { $ifNull: ['$enrolledStudents', []] } } } },
            { $sort: sortSpec },
            { $facet: {
                items: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
                total: [{ $count: 'count' }]
            } }
        ];
        const [result] = await Course.aggregate(pipeline);
        const totalCourses = result?.total?.[0]?.count || 0;
        const totalPages = Math.max(1, Math.ceil(totalCourses / pageSize));
        const safePage = Math.min(page, totalPages);
        let courses = result?.items || [];

        // If a requested page is past the last page, fetch the last page rather than showing an empty result.
        if (page !== safePage && totalCourses > 0) {
            const [lastPageResult] = await Course.aggregate([
                { $match: filter },
                { $addFields: { enrolledStudentsCount: { $size: { $ifNull: ['$enrolledStudents', []] } } } },
                { $sort: sortSpec },
                { $skip: (safePage - 1) * pageSize },
                { $limit: pageSize }
            ]);
            courses = lastPageResult ? [lastPageResult] : [];
        }

        const categories = await Course.distinct('category');
        const coursesWithStatus = courses.map(c => {
            const enrollment = (c.enrolledStudents || []).map(id => id.toString()).includes(userId.toString());
            const completed = (c.completedStudents || []).map(id => id.toString()).includes(userId.toString());
            const progress = (c.progress || []).find(p => p.userId && p.userId.toString() === userId.toString());
            const total = (c.lessons || []).length;
            const done = progress ? (progress.completedLessons || []).length : (completed ? total : 0);
            return {
                ...c,
                isEnrolled: enrollment,
                isCompleted: completed,
                progressPercent: total ? Math.round(done / total * 100) : (completed ? 100 : 0),
                lessonCount: total,
                enrolledCount: (c.enrolledStudents || []).length,
                reviewCount: (c.reviews || []).length
            };
        });

        const hasFilters = Boolean(search || category || level || rating || sort !== 'newest');
        res.render('courses', {
            name: userName,
            role: userRole,
            courses: coursesWithStatus,
            search,
            category,
            level,
            rating,
            sort,
            categories,
            page: safePage,
            pageSize,
            totalCourses,
            totalPages,
            hasFilters
        });
    } catch (err) {
        console.error('Courses error:', err);
        res.redirect('/dashboard');
    }
});

// Student's enrolled courses
app.get('/my-courses', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const courses = await Course.find({ enrolledStudents: req.session.userId }).sort({ updatedAt: -1 }).lean();
        const data = courses.map(c => {
            const p = (c.progress || []).find(x => x.userId && x.userId.toString() === req.session.userId.toString());
            const total = (c.lessons || []).length;
            const done = p ? (p.completedLessons || []).length : ((c.completedStudents || []).some(x => x.toString() === req.session.userId.toString()) ? total : 0);
            return { ...c, progressPercent: total ? Math.round(done / total * 100) : 0, lessonCount: total, isCompleted: done === total && total > 0 };
        });
        res.render('my-courses', { name: req.session.userName, role: req.session.userRole, courses: data });
    } catch (err) {
        console.error('My courses error:', err);
        res.redirect('/courses');
    }
});

// Show add course form
app.get('/courses/add', requireLogin, requireRole('teacher', 'admin'), async (req, res) => {
    const categories = await getCategories();
    res.render('add-course', { name: req.session.userName, role: req.session.userRole, categories });
});

// Handle add course form
app.post('/courses/add', requireLogin, requireRole('teacher', 'admin'), handleCourseUpload, async (req, res) => {
    try {
        const { title, description, category, duration, level, thumbnail, learningOutcomes, lessons, quizName, quizQuestions } = req.body;
        if (!title || title.trim().length < 3 || !description || description.trim().length < 10) {
            return res.render('add-course', { name: req.session.userName, role: req.session.userRole, error: 'Title must be at least 3 characters and description at least 10 characters.' });
        }
        const parsedLessons = parseLessons(lessons);
        const newCourse = await Course.create({
            title: title.trim(), description: description.trim(), thumbnail: req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : String(thumbnail || '').trim(),
            category: category || 'General', duration: duration || '4 weeks', level: level || 'Beginner',
            status: req.session.userRole === 'admin' ? 'published' : 'pending',
            learningOutcomes: normalizeList(learningOutcomes), lessons: parsedLessons, quizzes: quizQuestions ? [{ name: String(quizName || 'Course Quiz').trim() || 'Course Quiz', questions: parseQuizzes(quizQuestions) }] : [],
            teacherId: req.session.userId, teacherName: req.session.userName
        });
        if (newCourse.status === 'published') { const students = await User.find({ role: 'student' }).select('_id').lean(); await notifyUsers(students.map(s => s._id), 'course', 'New course available', `${newCourse.title} is now available on LearnHub.`, `/courses/${newCourse._id}`); }
        res.redirect('/courses');
    } catch (err) {
        console.error('Add course error:', err);
        res.render('add-course', { name: req.session.userName, role: req.session.userRole, error: 'Could not create course. Please try again.' });
    }
});

// Course details
app.get('/courses/:id', requireLogin, async (req, res) => {
    try {
        const { userId, userName, userRole } = req.session;
        const course = await Course.findById(req.params.id).lean();
        if (!course) return res.redirect('/courses');
        if (userRole === 'student' && course.status !== 'published') return res.redirect('/courses');
        const isEnrolled = (course.enrolledStudents || []).some(id => id.toString() === userId.toString());
        const isCompleted = (course.completedStudents || []).some(id => id.toString() === userId.toString());
        const isOwner = course.teacherId.toString() === userId.toString();
        const progress = (course.progress || []).find(p => p.userId && p.userId.toString() === userId.toString());
        const completedLessons = progress ? (progress.completedLessons || []) : [];
        const lessonCount = (course.lessons || []).length;
        const progressPercent = lessonCount ? Math.round(completedLessons.length / lessonCount * 100) : (isCompleted ? 100 : 0);
        const instructor = await User.findById(course.teacherId).select('name bio profilePicture').lean();
        const certificate = isEnrolled && userRole === 'student' ? await ensureCertificate(course, userId, userName) : null;
        const certificateEligibility = isEnrolled && userRole === 'student' ? await getCertificateEligibility(course, userId) : null;
        res.render('course-detail', { name: userName, role: userRole, userId, course, isEnrolled, isCompleted, isOwner, completedLessons, progressPercent, certificate, certificateEligibility, instructor: instructor || { name: course.teacherName, bio: '', profilePicture: null } });
    } catch (err) {
        console.error('Course detail error:', err);
        res.redirect('/courses');
    }
});

// Learning page
app.get('/courses/:id/learn', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id).lean();
        if (!course) return res.redirect('/courses');
        const isEnrolled = (course.enrolledStudents || []).some(id => id.toString() === req.session.userId.toString());
        if (!isEnrolled) return res.redirect(`/courses/${req.params.id}`);
        const p = (course.progress || []).find(x => x.userId && x.userId.toString() === req.session.userId.toString());
        const completedLessons = p ? (p.completedLessons || []) : [];
        const requestedLesson = Number.isInteger(Number(req.query.lesson)) ? Number(req.query.lesson) : null;
        const lastLesson = p && Number.isInteger(p.currentLesson) ? p.currentLesson : 0;
        const lessonIndex = course.lessons.length ? Math.max(0, Math.min(requestedLesson === null ? lastLesson : requestedLesson, course.lessons.length - 1)) : 0;
        const currentLesson = course.lessons[lessonIndex] || null;
        const progressPercent = course.lessons.length ? Math.round(completedLessons.length / course.lessons.length * 100) : 0;
        // Remember the lesson the student is viewing so Continue Learning opens here next time.
        if (p && requestedLesson !== null && requestedLesson !== p.currentLesson) {
            await Course.updateOne({ _id: course._id, 'progress.userId': req.session.userId }, { $set: { 'progress.$.currentLesson': lessonIndex, 'progress.$.updatedAt': new Date() } });
        } else if (!p && course.lessons.length) {
            await Course.updateOne({ _id: course._id }, { $push: { progress: { userId: req.session.userId, completedLessons: [], currentLesson: lessonIndex, updatedAt: new Date() } } });
        }
        res.render('course-learn', { name: req.session.userName, role: req.session.userRole, course, completedLessons, progressPercent, lessonIndex, currentLesson });
    } catch (err) { console.error('Learning page error:', err); res.redirect('/courses'); }
});

// Mark/unmark an individual lesson and update progress
app.post('/courses/:id/lessons/:lessonIndex/toggle', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const index = Number(req.params.lessonIndex);
        const course = await Course.findById(req.params.id);
        if (!course || !Number.isInteger(index) || index < 0 || index >= course.lessons.length) return res.redirect('/courses');
        const enrolled = course.enrolledStudents.some(id => id.toString() === req.session.userId.toString());
        if (!enrolled) return res.redirect(`/courses/${req.params.id}`);
        let progress = course.progress.find(p => p.userId && p.userId.toString() === req.session.userId.toString());
        if (!progress) { progress = { userId: req.session.userId, completedLessons: [], updatedAt: new Date() }; course.progress.push(progress); progress = course.progress[course.progress.length - 1]; }
        const pos = progress.completedLessons.indexOf(index);
        if (pos >= 0) progress.completedLessons.splice(pos, 1); else progress.completedLessons.push(index);
        progress.currentLesson = index;
        progress.updatedAt = new Date();
        progress.completedLessons.sort((a,b) => a-b);
        if (progress.completedLessons.length === course.lessons.length && course.lessons.length) course.completedStudents.addToSet(req.session.userId);
        else course.completedStudents.pull(req.session.userId);
        await course.save();
        await updateLearningStreak(req.session.userId);
        await LearningLog.create({ userId: req.session.userId, courseId: course._id, minutes: Number(req.body.minutes) > 0 ? Math.min(120, Number(req.body.minutes)) : 10 });
        if (progress.completedLessons.length === course.lessons.length && course.lessons.length > 0 && !(await Notification.exists({ userId: req.session.userId, type: 'completion', link: `/courses/${course._id}` }))) {
            await createNotification(req.session.userId, 'completion', 'Course completed', `Congratulations! You completed ${course.title}.`, `/courses/${course._id}`);
        }
        const certificate = await ensureCertificate(course.toObject(), req.session.userId, req.session.userName);
        if (certificate && progress.completedLessons.length === course.lessons.length) return res.redirect(`/courses/${req.params.id}/certificate`);
        res.redirect(`/courses/${req.params.id}/learn?lesson=${index}`);
    } catch (err) { console.error('Lesson progress error:', err); res.redirect(`/courses/${req.params.id}/learn`); }
});

// Enroll
app.post('/courses/:id/enroll', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.redirect('/courses');
        const alreadyEnrolled = course.enrolledStudents.some(id => id.toString() === req.session.userId.toString());
        if (!alreadyEnrolled) { course.enrolledStudents.addToSet(req.session.userId); await course.save(); await createNotification(req.session.userId, 'enrollment', 'Course enrollment confirmed', `You are now enrolled in ${course.title}.`, `/courses/${course._id}/learn`); }
        res.redirect(`/courses/${course._id}`);
    } catch (err) { console.error('Enroll error:', err); res.redirect('/courses'); }
});

// Leave course
app.post('/courses/:id/unenroll', requireLogin, requireRole('student'), async (req, res) => {
    try { await Course.findByIdAndUpdate(req.params.id, { $pull: { enrolledStudents: req.session.userId } }); res.redirect('/my-courses'); }
    catch (err) { console.error('Unenroll error:', err); res.redirect('/courses'); }
});

// Create or update a review. One review per student per course is enforced server-side.
app.post('/courses/:id/review', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const rating = Number(req.body.rating);
        const comment = String(req.body.comment || '').trim().slice(0, 500);
        const course = await Course.findById(req.params.id);
        const user = await User.findById(req.session.userId).select('name profilePicture').lean();
        if (!course || !course.enrolledStudents.some(id => id.toString() === req.session.userId.toString()) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
            return res.redirect(`/courses/${req.params.id}#reviews`);
        }
        const existing = course.reviews.find(r => r.userId && r.userId.toString() === req.session.userId.toString());
        if (existing) {
            existing.rating = rating;
            existing.comment = comment;
            existing.userName = user?.name || req.session.userName;
            existing.profilePicture = user?.profilePicture || '';
            existing.createdAt = new Date();
        } else {
            course.reviews.push({ userId: req.session.userId, userName: user?.name || req.session.userName, profilePicture: user?.profilePicture || '', rating, comment });
        }
        course.rating = course.reviews.length ? Math.round((course.reviews.reduce((sum, r) => sum + r.rating, 0) / course.reviews.length) * 10) / 10 : 0;
        await course.save();
        res.redirect(`/courses/${req.params.id}#reviews`);
    } catch (err) { console.error('Review error:', err); res.redirect(`/courses/${req.params.id}#reviews`); }
});

// Delete the current student's review.
app.post('/courses/:id/review/delete', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.redirect('/courses');
        const before = course.reviews.length;
        course.reviews = course.reviews.filter(r => !r.userId || r.userId.toString() !== req.session.userId.toString());
        if (course.reviews.length !== before) {
            course.rating = course.reviews.length ? Math.round((course.reviews.reduce((sum, r) => sum + r.rating, 0) / course.reviews.length) * 10) / 10 : 0;
            await course.save();
        }
        res.redirect(`/courses/${req.params.id}#reviews`);
    } catch (err) { console.error('Delete review error:', err); res.redirect(`/courses/${req.params.id}#reviews`); }
});

// ─────────────────────────────────────────────────────────
//  QUIZ SYSTEM
// ─────────────────────────────────────────────────────────

// ─── CERTIFICATE HELPERS ─────────────────────────────────
const CERTIFICATE_PASS_PERCENT = 60;

function makeCertificateId() {
    return `LH-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function getCertificateEligibility(course, userId) {
    const uid = userId.toString();
    const progress = (course.progress || []).find(p => p.userId && p.userId.toString() === uid);
    const completedLessons = progress ? (progress.completedLessons || []) : [];
    const allLessonsComplete = course.lessons.length > 0 && completedLessons.length >= course.lessons.length;
    const quizzes = (course.quizzes || []).filter(q => q.questions && q.questions.length);

    let passedQuiz = null;
    if (quizzes.length) {
        const attempts = await QuizAttempt.find({ userId, courseId: course._id, passed: true }).sort({ attemptedAt: -1 }).lean();
        const passedNames = new Set(attempts.map(a => a.quizName));
        const allRequiredQuizzesPassed = quizzes.every(q => passedNames.has(q.name || 'Course Quiz'));
        if (allRequiredQuizzesPassed) passedQuiz = attempts[0] || null;
        return { eligible: allLessonsComplete && allRequiredQuizzesPassed, allLessonsComplete, quizzesRequired: true, quizPassed: allRequiredQuizzesPassed, passedQuiz };
    }
    return { eligible: false, allLessonsComplete, quizzesRequired: true, quizPassed: false, passedQuiz: null };
}

async function ensureCertificate(course, userId, studentName) {
    const eligibility = await getCertificateEligibility(course, userId);
    if (!eligibility.eligible) return null;
    let certificate = await Certificate.findOne({ userId, courseId: course._id }).lean();
    if (certificate) return certificate;
    const instructor = await User.findById(course.teacherId).select('name').lean();
    try {
        certificate = await Certificate.create({
            certificateId: makeCertificateId(),
            userId, studentName, courseId: course._id, courseName: course.title,
            instructorName: instructor?.name || course.teacherName || 'LearnHub Instructor',
            platformName: 'LearnHub', completionDate: new Date()
        });
        await createNotification(userId, 'certificate', 'Certificate generated', `Your certificate for ${course.title} is ready to view and download.`, `/courses/${course._id}/certificate`);
        return certificate.toObject();
    } catch (err) {
        if (err.code === 11000) return Certificate.findOne({ userId, courseId: course._id }).lean();
        throw err;
    }
}

app.get('/courses/:id/quiz', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id).lean();
        if (!course) return res.redirect('/courses');
        const enrolled = (course.enrolledStudents || []).some(id => id.toString() === req.session.userId.toString());
        if (!enrolled) return res.redirect(`/courses/${req.params.id}`);
        const quizzes = (course.quizzes || []).filter(q => q.questions && q.questions.length);
        if (!quizzes.length) return res.redirect(`/courses/${req.params.id}/learn`);
        const quizIndex = Math.max(0, Math.min(Number(req.query.quiz) || 0, quizzes.length - 1));
        const quiz = quizzes[quizIndex];
        const safeQuiz = { _id: quiz._id, name: quiz.name, questions: quiz.questions.map(q => ({ _id: q._id, question: q.question, options: q.options })) };
        res.render('quiz', { name: req.session.userName, role: req.session.userRole, course, quiz: safeQuiz, quizIndex });
    } catch (err) { console.error('Quiz page error:', err); res.redirect('/courses'); }
});

app.post('/courses/:id/quiz/submit', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id).lean();
        if (!course) return res.redirect('/courses');
        const enrolled = (course.enrolledStudents || []).some(id => id.toString() === req.session.userId.toString());
        if (!enrolled) return res.redirect(`/courses/${req.params.id}`);
        const quizIndex = Math.max(0, Math.min(Number(req.body.quizIndex) || 0, (course.quizzes || []).length - 1));
        const quiz = course.quizzes?.[quizIndex];
        if (!quiz || !quiz.questions?.length) return res.redirect(`/courses/${req.params.id}/learn`);
        const answers = Array.isArray(req.body.answers) ? req.body.answers : Object.keys(req.body).filter(k => k.startsWith('answers[')).map(k => req.body[k]);
        let correct = 0;
        quiz.questions.forEach((q, i) => { if (Number(answers[i]) === q.correctAnswer) correct++; });
        const total = quiz.questions.length;
        const wrong = total - correct;
        const percentage = Math.round((correct / total) * 100);
        const passed = percentage >= 60;
        const attempt = await QuizAttempt.create({ userId: req.session.userId, userName: req.session.userName, courseId: course._id, courseName: course.title, quizName: quiz.name || 'Course Quiz', totalQuestions: total, correctAnswers: correct, wrongAnswers: wrong, score: correct, percentage, passed });
        await createNotification(req.session.userId, 'quiz', 'Quiz result available', `You scored ${correct}/${total} (${percentage}%) on ${quiz.name || 'Course Quiz'} — ${passed ? 'PASSED' : 'FAILED'}.`, `/courses/${course._id}/quiz`);
        const certificate = passed ? await ensureCertificate(course, req.session.userId, req.session.userName) : null;
        res.render('quiz-result', { name: req.session.userName, role: req.session.userRole, course, quiz, certificate, result: { totalQuestions: total, correctAnswers: correct, wrongAnswers: wrong, score: correct, percentage, passed, attemptId: attempt._id } });
    } catch (err) { console.error('Quiz submit error:', err); res.redirect(`/courses/${req.params.id}/quiz`); }
});

// Certificate: view and print-friendly PDF download.
app.get('/courses/:id/certificate', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id).lean();
        if (!course || !(course.enrolledStudents || []).some(id => id.toString() === req.session.userId.toString())) return res.redirect('/courses');
        const certificate = await ensureCertificate(course, req.session.userId, req.session.userName);
        if (!certificate) return res.redirect(`/courses/${req.params.id}/learn?certificate=locked`);
        res.render('certificate', { name: req.session.userName, role: req.session.userRole, certificate, course });
    } catch (err) { console.error('Certificate view error:', err); res.redirect(`/courses/${req.params.id}`); }
});

app.get('/certificates/:certificateId/download', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const certificate = await Certificate.findOne({ certificateId: req.params.certificateId, userId: req.session.userId }).lean();
        if (!certificate) return res.status(404).send('Certificate not found.');
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${certificate.certificateId}.pdf"`);
        doc.pipe(res);
        const W = doc.page.width, H = doc.page.height;
        doc.rect(0, 0, W, H).fill('#f8fafc');
        doc.lineWidth(3).strokeColor('#1e3a8a').rect(28, 28, W - 56, H - 56).stroke();
        doc.lineWidth(1).strokeColor('#cbd5e1').rect(42, 42, W - 84, H - 84).stroke();
        doc.fillColor('#1e3a8a').fontSize(32).font('Helvetica-Bold').text('LearnHub', 0, 75, { align: 'center' });
        doc.fillColor('#111827').fontSize(30).font('Helvetica-Bold').text('CERTIFICATE OF COMPLETION', 0, 130, { align: 'center' });
        doc.fillColor('#6b7280').fontSize(14).font('Helvetica').text('This certificate is proudly presented to', 0, 190, { align: 'center' });
        doc.fillColor('#111827').fontSize(34).font('Helvetica-Bold').text(certificate.studentName, 70, 220, { width: W - 140, align: 'center' });
        doc.moveTo(210, 267).lineTo(W - 210, 267).lineWidth(1).strokeColor('#94a3b8').stroke();
        doc.fillColor('#6b7280').fontSize(14).font('Helvetica').text('For successfully completing', 0, 286, { align: 'center' });
        doc.fillColor('#1e3a8a').fontSize(26).font('Helvetica-Bold').text(certificate.courseName, 70, 315, { width: W - 140, align: 'center' });
        doc.fillColor('#374151').fontSize(12).font('Helvetica').text(`Instructor: ${certificate.instructorName}`, 80, 390, { width: W - 160, align: 'center' });
        doc.text(`Completion Date: ${new Date(certificate.completionDate).toLocaleDateString()}`, 80, 412, { width: W - 160, align: 'center' });
        doc.fillColor('#64748b').fontSize(10).text(`Certificate ID: ${certificate.certificateId}  •  ${certificate.platformName}`, 80, H - 72, { width: W - 160, align: 'center' });
        doc.end();
    } catch (err) { console.error('Certificate PDF error:', err); res.status(500).send('Could not generate certificate PDF.'); }
});

app.get('/quiz-history', requireLogin, requireRole('student'), async (req, res) => {
    try {
        const attempts = await QuizAttempt.find({ userId: req.session.userId }).sort({ attemptedAt: -1 }).lean();
        res.render('quiz-history', { name: req.session.userName, role: req.session.userRole, attempts });
    } catch (err) { console.error('Quiz history error:', err); res.redirect('/dashboard'); }
});

// Delete a course
app.post('/courses/:id/delete', requireLogin, requireRole('teacher', 'admin'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id); if (!course) return res.redirect('/courses');
        if (req.session.userRole === 'teacher' && course.teacherId.toString() !== req.session.userId.toString()) return res.redirect('/courses');
        await Course.findByIdAndDelete(req.params.id); res.redirect('/courses');
    } catch (err) { console.error('Delete course error:', err); res.redirect('/courses'); }
});

// ─────────────────────────────────────────────────────────
//  INSTRUCTOR / ADMIN MANAGEMENT
// ─────────────────────────────────────────────────────────
app.get('/instructor/courses/:id/students', requireLogin, requireRole('teacher','admin'), async (req,res) => {
    try {
        const course = await Course.findById(req.params.id).lean();
        if (!course || (req.session.userRole === 'teacher' && course.teacherId.toString() !== req.session.userId.toString())) return res.status(403).render('access-denied',{name:req.session.userName,role:req.session.userRole});
        const students = await User.find({_id: {$in: course.enrolledStudents || []}}, {password:0,resetPasswordToken:0,verificationToken:0}).lean();
        const uidMap = new Map(students.map(s => [s._id.toString(), s]));
        const rows = (course.enrolledStudents || []).map(id => { const p=(course.progress||[]).find(x=>x.userId?.toString()===id.toString()); const total=(course.lessons||[]).length; const done=p?.completedLessons?.length||0; return {student:uidMap.get(id.toString()), progress: total ? Math.round(done/total*100):0, completed: done>=total&&total>0}; });
        res.render('instructor-students',{name:req.session.userName,role:req.session.userRole,course,rows});
    } catch(e){console.error(e);res.redirect('/dashboard');}
});

app.get('/courses/:id/edit', requireLogin, requireRole('teacher','admin'), async (req,res)=>{
    try { const course=await Course.findById(req.params.id).lean(); if(!course) return res.redirect('/courses'); if(req.session.userRole==='teacher'&&course.teacherId.toString()!==req.session.userId.toString()) return res.status(403).render('access-denied',{name:req.session.userName,role:req.session.userRole}); const categories=await getCategories(); res.render('edit-course',{name:req.session.userName,role:req.session.userRole,course,categories}); }
    catch(e){console.error(e);res.redirect('/dashboard');}
});
app.post('/courses/:id/edit', requireLogin, requireRole('teacher','admin'), handleCourseUpload, async (req,res)=>{
    try {
        const course=await Course.findById(req.params.id); if(!course) return res.redirect('/courses'); if(req.session.userRole==='teacher'&&course.teacherId.toString()!==req.session.userId.toString()) return res.status(403).send('Not authorized.');
        const {title,description,category,duration,level,thumbnail,learningOutcomes,lessons,quizName,quizQuestions,status}=req.body;
        if(!title||title.trim().length<3||!description||description.trim().length<10) return res.status(400).send('Invalid course title or description.');
        course.title=title.trim(); course.description=description.trim(); course.category=category||'General'; course.duration=duration||'4 weeks'; course.level=level||'Beginner'; course.learningOutcomes=normalizeList(learningOutcomes); course.lessons=parseLessons(lessons); course.quizzes=quizQuestions?[{name:String(quizName||'Course Quiz').trim()||'Course Quiz',questions:parseQuizzes(quizQuestions)}]:[];
        if(req.file) course.thumbnail=`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`; else if(thumbnail!==undefined) course.thumbnail=String(thumbnail||'').trim();
        if(req.session.userRole==='admin' && ['draft','pending','published','rejected'].includes(status)) course.status=status;
        else if(req.session.userRole==='teacher' && course.status==='rejected') course.status='pending';
        await course.save();
        if(course.status==='published') { const students=await User.find({role:'student'}).select('_id').lean(); await notifyUsers(students.map(s=>s._id),'course','Course updated',`${course.title} has been updated.`, `/courses/${course._id}`); }
        res.redirect(`/courses/${course._id}`);
    } catch(e){console.error(e);res.status(500).send('Could not update course.');}
});

app.get('/admin', requireLogin, requireRole('admin'), (req,res)=>res.redirect('/dashboard'));
app.get('/admin/courses', requireLogin, requireRole('admin'), async(req,res)=>{ const courses=await Course.find().sort({createdAt:-1}).lean(); res.render('admin-courses',{name:req.session.userName,role:req.session.userRole,courses}); });
app.post('/admin/courses/:id/status', requireLogin, requireRole('admin'), async(req,res)=>{ try{ const status=['draft','pending','published','rejected'].includes(req.body.status)?req.body.status:null; if(!status) return res.redirect('/admin/courses'); const c=await Course.findByIdAndUpdate(req.params.id,{status},{new:true}); if(c&&status==='published'){const students=await User.find({role:'student'}).select('_id').lean();await notifyUsers(students.map(s=>s._id),'course','New course available',`${c.title} is now available on LearnHub.`, `/courses/${c._id}`);} res.redirect('/admin/courses'); }catch(e){console.error(e);res.redirect('/admin/courses');} });
app.get('/admin/categories', requireLogin, requireRole('admin'), async(req,res)=>res.render('admin-categories',{name:req.session.userName,role:req.session.userRole,categories:await getCategories()}));
app.post('/admin/categories', requireLogin, requireRole('admin'), async(req,res)=>{ try{const name=String(req.body.name||'').trim();if(name)await Category.create({name});res.redirect('/admin/categories');}catch(e){res.redirect('/admin/categories');} });
app.post('/admin/categories/:id/delete', requireLogin, requireRole('admin'), async(req,res)=>{try{await Category.findByIdAndDelete(req.params.id);res.redirect('/admin/categories');}catch(e){res.redirect('/admin/categories');}});
app.get('/admin/enrollments', requireLogin, requireRole('admin'), async(req,res)=>{const courses=await Course.find().lean();const rows=[];for(const c of courses)for(const id of (c.enrolledStudents||[])){const u=await User.findById(id,{password:0}).lean();const p=(c.progress||[]).find(x=>x.userId?.toString()===id.toString());rows.push({course:c,student:u,progress:c.lessons.length?Math.round((p?.completedLessons?.length||0)/c.lessons.length*100):0});}res.render('admin-enrollments',{name:req.session.userName,role:req.session.userRole,rows});});
app.get('/admin/quizzes', requireLogin, requireRole('admin'), async(req,res)=>{const attempts=await QuizAttempt.find().sort({attemptedAt:-1}).limit(300).lean();res.render('admin-quizzes',{name:req.session.userName,role:req.session.userRole,attempts});});
app.get('/admin/reviews', requireLogin, requireRole('admin'), async(req,res)=>{const courses=await Course.find({'reviews.0':{$exists:true}}).lean();const reviews=[];courses.forEach(c=>(c.reviews||[]).forEach(r=>reviews.push({...r,courseId:c._id,courseTitle:c.title})));reviews.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));res.render('admin-reviews',{name:req.session.userName,role:req.session.userRole,reviews});});
app.post('/admin/reviews/delete', requireLogin, requireRole('admin'), async(req,res)=>{try{const c=await Course.findById(req.body.courseId);if(c){c.reviews=(c.reviews||[]).filter(r=>r._id.toString()!==String(req.body.reviewId));c.rating=c.reviews.length?Math.round(c.reviews.reduce((n,r)=>n+r.rating,0)/c.reviews.length*10)/10:0;await c.save();}res.redirect('/admin/reviews');}catch(e){res.redirect('/admin/reviews');}});
app.get('/admin/notifications', requireLogin, requireRole('admin'), async(req,res)=>{const notifications=await Notification.find().sort({createdAt:-1}).limit(300).lean();res.render('admin-notifications',{name:req.session.userName,role:req.session.userRole,notifications});});
app.post('/admin/notifications/clear', requireLogin, requireRole('admin'), async(req,res)=>{await Notification.deleteMany({});res.redirect('/admin/notifications');});

// ─────────────────────────────────────────────────────────
//  PROFILE
// ─────────────────────────────────────────────────────────

app.get('/profile', requireLogin, async (req, res) => {
    try {
        // Get fresh user data and never expose the password to the template.
        const user = await User.findById(req.session.userId, { password: 0 }).lean();
        if (!user) return res.redirect('/login');

        res.render('profile', {
            name: req.session.userName,
            role: req.session.userRole,
            user,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.redirect('/dashboard');
    }
});

// Update profile details and optional profile picture.
app.post('/profile/update', requireLogin, handleProfileUpload, async (req, res) => {
    try {
        await databaseConnection;

        const name = String(req.body.name || '').trim();
        const expertise = String(req.body.expertise || '').trim();
        const bio = String(req.body.bio || '').trim();

        if (!name) {
            return res.redirect('/profile?error=' + encodeURIComponent('Name is required.'));
        }
        if (name.length < 2 || name.length > 50) {
            return res.redirect('/profile?error=' + encodeURIComponent('Name must be between 2 and 50 characters.'));
        }
        if (bio.length > 500) {
            return res.redirect('/profile?error=' + encodeURIComponent('Bio must be 500 characters or less.'));
        }

        const existing = await User.findOne({
            name: name,
            _id: { $ne: req.session.userId }
        });

        if (existing) {
            return res.redirect('/profile?error=' + encodeURIComponent('That username is already taken.'));
        }

        const update = { name, bio, expertise };

        if (req.file) {
            // multer has already checked the size and MIME type.
            const supportedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            if (!supportedTypes.includes(req.file.mimetype)) {
                return res.redirect('/profile?error=' + encodeURIComponent('Unsupported image format.'));
            }
            update.profilePicture =
                `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        }

        await User.findByIdAndUpdate(req.session.userId, update);
        req.session.userName = name;

        return res.redirect('/profile?success=' + encodeURIComponent('Your profile has been updated successfully.'));
    } catch (err) {
        console.error('Profile update error:', err);
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'Profile picture must be 2 MB or smaller.'
            : (err.message || 'Could not update your profile. Please try again.');
        res.redirect('/profile?error=' + encodeURIComponent(message));
    }
});

// Remove the current profile picture and return to the profile page.
app.post('/profile/remove-picture', requireLogin, async (req, res) => {
    try {
        await databaseConnection;
        await User.findByIdAndUpdate(req.session.userId, { profilePicture: null });
        res.redirect('/profile?success=' + encodeURIComponent('Profile picture removed.'));
    } catch (err) {
        console.error('Remove profile picture error:', err);
        res.redirect('/profile?error=' + encodeURIComponent('Could not remove the profile picture.'));
    }
});

// Change password from the authenticated profile page.
app.post('/profile/change-password', requireLogin, async (req, res) => {
    try {
        await databaseConnection;

        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');
        const confirmPassword = String(req.body.confirmPassword || '');

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.redirect('/profile?error=' + encodeURIComponent('Please fill in all password fields.'));
        }

        if (newPassword.length < 6) {
            return res.redirect('/profile?error=' + encodeURIComponent('New password must be at least 6 characters long.'));
        }

        if (newPassword !== confirmPassword) {
            return res.redirect('/profile?error=' + encodeURIComponent('New passwords do not match.'));
        }

        if (currentPassword === newPassword) {
            return res.redirect('/profile?error=' + encodeURIComponent('New password must be different from your current password.'));
        }

        const user = await User.findById(req.session.userId);
        if (!user) return res.redirect('/login');

        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) {
            return res.redirect('/profile?error=' + encodeURIComponent('Current password is incorrect.'));
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.resetPasswordToken = null;
        user.resetPasswordTokenExpires = null;
        await user.save();

        res.redirect('/profile?success=' + encodeURIComponent('Password changed successfully.'));
    } catch (err) {
        console.error('Change password error:', err);
        res.redirect('/profile?error=' + encodeURIComponent('Could not change your password. Please try again.'));
    }
});

// ─────────────────────────────────────────────────────────
//  ADMIN — Manage Users
// ─────────────────────────────────────────────────────────

app.get('/admin/users', requireLogin, requireRole('admin'), async (req, res) => {
    try {
        const users = await User.find({}, { password: 0 }).lean();
        res.render('admin-users', { name: req.session.userName, role: req.session.userRole, userId: req.session.userId, users, error: req.query.error, success: req.query.success });
    } catch (err) {
        console.error('Admin users error:', err);
        res.redirect('/dashboard');
    }
});

app.post('/admin/users/create', requireLogin, requireRole('admin'), async (req,res)=>{
    try { const name=String(req.body.name||'').trim(), email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||''), role=['student','teacher','admin'].includes(req.body.role)?req.body.role:'student'; if(name.length<2||!email||password.length<6) return res.redirect('/admin/users?error=Invalid%20user%20details'); const exists=await User.findOne({$or:[{email},{name}]}); if(exists) return res.redirect('/admin/users?error=Email%20or%20username%20already%20exists'); await User.create({name,email,password:await bcrypt.hash(password,10),role,emailVerified:true}); res.redirect('/admin/users?success=User%20created'); } catch(e){console.error(e);res.redirect('/admin/users?error=Could%20not%20create%20user');}
});

app.post('/admin/users/:id/delete', requireLogin, requireRole('admin'), async (req, res) => {
    try {
        if (req.params.id === req.session.userId.toString()) return res.redirect('/admin/users?error=You%20cannot%20delete%20your%20own%20account');
        await Course.updateMany({}, { $pull: { enrolledStudents: req.params.id, completedStudents: req.params.id, progress: { userId: req.params.id } } });
        await Course.updateMany({}, { $pull: { reviews: { userId: req.params.id } } });
        const affected = await Course.find({}).lean();
        for (const c of affected) { const reviews=c.reviews||[]; const avg=reviews.length?Math.round(reviews.reduce((n,r)=>n+r.rating,0)/reviews.length*10)/10:0; await Course.updateOne({_id:c._id},{$set:{rating:avg}}); }
        await Promise.all([QuizAttempt.deleteMany({userId:req.params.id}), Certificate.deleteMany({userId:req.params.id}), Notification.deleteMany({userId:req.params.id}), User.findByIdAndDelete(req.params.id)]);
        res.redirect('/admin/users?success=User%20deleted');
    } catch (err) { console.error('Delete user error:', err); res.redirect('/admin/users?error=Could%20not%20delete%20user'); }
});

app.post('/admin/users/:id/role', requireLogin, requireRole('admin'), async (req, res) => {
    try {
        const { role } = req.body;
        const validRoles = ['admin', 'teacher', 'student'];
        if (req.params.id === req.session.userId.toString()) return res.redirect('/admin/users?error=You%20cannot%20change%20your%20own%20role');
        if (validRoles.includes(role)) await User.findByIdAndUpdate(req.params.id, { role });
        res.redirect('/admin/users');
    } catch (err) {
        console.error('Change role error:', err);
        res.redirect('/admin/users');
    }
});


// ─────────────────────────────────────────────────────────
//  PROFESSIONAL LMS FEATURES
// ─────────────────────────────────────────────────────────
function safeDate(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
async function getStudentCourse(courseId, userId) {
    const c = await Course.findOne({_id:courseId, enrolledStudents:userId});
    return c;
}

// Attendance: student history + instructor marking + admin oversight
app.get('/courses/:id/attendance', requireLogin, async (req,res) => {
    try {
        const course=await Course.findById(req.params.id).lean(); if(!course) return res.status(404).send('Course not found');
        const isTeacher=String(course.teacherId)===String(req.session.userId);
        if(req.session.userRole==='student' && !(course.enrolledStudents||[]).some(x=>String(x)===String(req.session.userId))) return res.render('access-denied',{name:req.session.userName,role:req.session.userRole});
        const filter={courseId:course._id};
        if(req.session.userRole==='student') filter.studentId=req.session.userId;
        const records=await Attendance.find(filter).populate('studentId','name email').sort({date:-1}).lean();
        const grouped={}; records.forEach(r=>{const k=String(r.studentId?._id||r.studentId); grouped[k] ||= {student:r.studentId,records:[],present:0,absent:0}; grouped[k].records.push(r); r.status==='present'?grouped[k].present++:grouped[k].absent++;});
        const rows=Object.values(grouped).map(x=>({...x,total:x.present+x.absent,percentage:x.present+x.absent?Math.round(x.present/(x.present+x.absent)*100):0}));
        const students=req.session.userRole==='teacher'&&isTeacher ? await User.find({_id:{$in:course.enrolledStudents||[]},role:'student'},{name:1,email:1}).lean() : [];
        res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Attendance — '+course.title,section:'attendance',course,rows,students,records});
    } catch(e){console.error(e);res.status(500).send(e.message)}
});
app.post('/courses/:id/attendance/mark', requireLogin, requireRole('teacher','admin'), async (req,res)=>{
    try{
        const course=await Course.findById(req.params.id); if(!course) return res.redirect('/courses');
        if(req.session.userRole==='teacher' && String(course.teacherId)!==String(req.session.userId)) return res.status(403).send('Not your course');
        const studentId=req.body.studentId, status=req.body.status==='present'?'present':'absent';
        const date=safeDate(req.body.date)||new Date();
        await Attendance.create({courseId:course._id,studentId,status,markedBy:req.session.userId,date,lessonIndex:req.body.lessonIndex?Number(req.body.lessonIndex):null});
        await createNotification(studentId,'system','Attendance updated',`${course.title}: marked ${status}.`,`/courses/${course._id}/attendance`);
        res.redirect(`/courses/${course._id}/attendance`);
    }catch(e){console.error(e);res.status(400).send(e.message)}
});
app.get('/admin/attendance', requireLogin, requireRole('admin'), async (req,res)=>{
    const records=await Attendance.find().populate('courseId','title').populate('studentId','name email').populate('markedBy','name').sort({date:-1}).limit(500).lean();
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'All Attendance',section:'admin-attendance',records,rows:[]});
});

// Live classes + calendar
app.get('/calendar', requireLogin, async(req,res)=>{
    const now=new Date(), courseQuery=req.session.userRole==='student'?{enrolledStudents:req.session.userId}:{};
    const courses=await Course.find(courseQuery,{title:1}).lean(); const ids=courses.map(c=>c._id);
    const classes=await LiveClass.find(req.session.userRole==='admin'?{}:{courseId:{$in:ids}}).populate('courseId','title').populate('teacherId','name').sort({date:1}).lean();
    const quizzes=await QuizAttempt.find({userId:req.session.userId}).sort({attemptedAt:1}).limit(100).lean();
    const instructorCourses=req.session.userRole==='teacher'?await Course.find({teacherId:req.session.userId},{title:1}).lean():[]; res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'My Calendar',section:'calendar',classes,quizzes,now,courses:instructorCourses});
});
app.post('/instructor/classes/create', requireLogin, requireRole('teacher'), async(req,res)=>{
    const course=await Course.findOne({_id:req.body.courseId,teacherId:req.session.userId}); if(!course) return res.status(403).send('Not your course');
    const cls=await LiveClass.create({courseId:course._id,title:req.body.title,description:req.body.description,date:safeDate(req.body.date)||new Date(),durationMinutes:Number(req.body.durationMinutes)||60,meetingLink:req.body.meetingLink||'',teacherId:req.session.userId});
    await notifyUsers(course.enrolledStudents,'system','Upcoming live class',`${cls.title} for ${course.title}.`,`/calendar`);
    res.redirect('/calendar');
});
app.post('/instructor/classes/:id/cancel', requireLogin, requireRole('teacher','admin'), async(req,res)=>{ const c=await LiveClass.findById(req.params.id); if(c && (req.session.userRole==='admin'||String(c.teacherId)===String(req.session.userId))){c.status='cancelled';await c.save();} res.redirect('/calendar'); });

// Assignments
app.get('/courses/:id/assignments', requireLogin, async(req,res)=>{
    const course=await Course.findById(req.params.id).lean(); if(!course) return res.status(404).send('Course not found');
    const allowed=req.session.userRole==='admin'||String(course.teacherId)===String(req.session.userId)||(course.enrolledStudents||[]).some(x=>String(x)===String(req.session.userId));
    if(!allowed) return res.render('access-denied',{name:req.session.userName,role:req.session.userRole});
    const assignments=await Assignment.find({courseId:course._id}).sort({dueDate:1}).lean();
    const subs=req.session.userRole==='student'?await AssignmentSubmission.find({studentId:req.session.userId,assignmentId:{$in:assignments.map(a=>a._id)}}).lean():[];
    const subMap=Object.fromEntries(subs.map(x=>[String(x.assignmentId),x]));
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Assignments — '+course.title,section:'assignments',course,assignments,subMap});
});
app.post('/courses/:id/assignments/create', requireLogin, requireRole('teacher'), attachmentUpload.single('attachment'), async(req,res)=>{
    const course=await Course.findOne({_id:req.params.id,teacherId:req.session.userId}); if(!course) return res.status(403).send('Not your course');
    await Assignment.create({courseId:course._id,title:req.body.title,description:req.body.description,dueDate:safeDate(req.body.dueDate)||new Date(),maxMarks:Number(req.body.maxMarks)||100,attachmentName:req.file?.originalname||'',attachmentUrl:dataUrlFromFile(req.file),teacherId:req.session.userId});
    res.redirect(`/courses/${course._id}/assignments`);
});
app.post('/assignments/:id/submit', requireLogin, requireRole('student'), attachmentUpload.single('file'), async(req,res)=>{
    const a=await Assignment.findById(req.params.id).populate('courseId'); if(!a || !a.courseId.enrolledStudents.some(x=>String(x)===String(req.session.userId))) return res.status(403).send('Not allowed');
    await AssignmentSubmission.findOneAndUpdate({assignmentId:a._id,studentId:req.session.userId},{text:req.body.text||'',fileName:req.file?.originalname||'',fileUrl:dataUrlFromFile(req.file),submittedAt:new Date(),marks:null,feedback:''},{upsert:true,new:true});
    await createNotification(a.teacherId,'system','New assignment submission',`${req.session.userName} submitted ${a.title}.`,`/courses/${a.courseId._id}/assignments`);
    res.redirect(`/courses/${a.courseId._id}/assignments`);
});
app.get('/assignments/:id/submissions', requireLogin, requireRole('teacher','admin'), async(req,res)=>{
    const a=await Assignment.findById(req.params.id).populate('courseId','title teacherId').lean(); if(!a) return res.status(404).send('Not found');
    if(req.session.userRole==='teacher'&&String(a.courseId.teacherId)!==String(req.session.userId)) return res.status(403).send('Not allowed');
    const submissions=await AssignmentSubmission.find({assignmentId:a._id}).populate('studentId','name email').sort({submittedAt:-1}).lean();
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Grade Assignment',section:'grade-assignment',assignment:a,submissions});
});
app.post('/assignments/:id/submissions/:submissionId/grade', requireLogin, requireRole('teacher','admin'), async(req,res)=>{
    const a=await Assignment.findById(req.params.id).populate('courseId'); if(!a) return res.status(404).send('Not found');
    if(req.session.userRole==='teacher'&&String(a.courseId.teacherId)!==String(req.session.userId)) return res.status(403).send('Not allowed');
    await AssignmentSubmission.findByIdAndUpdate(req.params.submissionId,{marks:Math.max(0,Number(req.body.marks)||0),feedback:req.body.feedback||'',gradedAt:new Date()});
    res.redirect(`/assignments/${a._id}/submissions`);
});

// Resources
app.get('/courses/:id/resources', requireLogin, async(req,res)=>{
    const course=await Course.findById(req.params.id).lean(); if(!course) return res.status(404).send('Not found');
    const resources=(course.lessons||[]).flatMap((l,i)=>(l.resources||[]).map(r=>({...r,lessonIndex:i,lessonTitle:l.title})));
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Course Resources',section:'resources',course,resources});
});


app.post('/courses/:id/resources/add', requireLogin, requireRole('teacher'), attachmentUpload.single('file'), async(req,res)=>{
    const c=await Course.findOne({_id:req.params.id,teacherId:req.session.userId}); if(!c) return res.status(403).send('Not your course');
    const i=Number(req.body.lessonIndex); if(!c.lessons[i]) return res.redirect(`/courses/${c._id}/resources`);
    c.lessons[i].resources ||= []; const resourceUrl=req.file?dataUrlFromFile(req.file):(req.body.url||''); c.lessons[i].resources.push({name:req.body.name||req.file?.originalname,type:req.body.type||req.file?.mimetype||'Resource',url:resourceUrl}); await c.save();
    res.redirect(`/courses/${c._id}/resources`);
});

// Discussion forum
app.get('/courses/:id/discussion', requireLogin, async(req,res)=>{
    const course=await Course.findById(req.params.id).lean(); if(!course) return res.status(404).send('Not found');
    const posts=await DiscussionPost.find({courseId:course._id}).sort({createdAt:-1}).lean();
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Discussion — '+course.title,section:'discussion',course,posts});
});
app.post('/courses/:id/discussion', requireLogin, async(req,res)=>{
    const course=await Course.findById(req.params.id); if(!course) return res.redirect('/courses');
    const enrolled=(course.enrolledStudents||[]).some(x=>String(x)===String(req.session.userId));
    if(req.session.userRole==='student'&&!enrolled) return res.status(403).send('Enroll first');
    await DiscussionPost.create({courseId:course._id,userId:req.session.userId,userName:req.session.userName,title:req.body.title,body:req.body.body});
    res.redirect(`/courses/${course._id}/discussion`);
});
app.post('/discussion/:id/reply', requireLogin, async(req,res)=>{
    const parent=await DiscussionPost.findById(req.params.id); if(!parent) return res.redirect('/courses');
    const course=await Course.findById(parent.courseId);
    await DiscussionPost.create({courseId:parent.courseId,userId:req.session.userId,userName:req.session.userName,title:'Re: '+parent.title,body:req.body.body});
    res.redirect(`/courses/${course._id}/discussion`);
});
app.post('/discussion/:id/like', requireLogin, async(req,res)=>{
    const p=await DiscussionPost.findById(req.params.id); if(p){const i=p.likes.findIndex(x=>String(x)===String(req.session.userId)); if(i>=0)p.likes.splice(i,1);else p.likes.push(req.session.userId);await p.save();} res.redirect('back');
});
app.post('/discussion/:id/answer', requireLogin, requireRole('teacher','admin'), async(req,res)=>{
    const p=await DiscussionPost.findById(req.params.id); if(p){p.answerId=req.body.answerId||p._id;await p.save();} res.redirect('back');
});

// Notes, bookmarks, wishlist
app.get('/my-learning-tools', requireLogin, async(req,res)=>{
    const [notes,bookmarks,wishlist,badges,logs]=await Promise.all([
        Note.find({userId:req.session.userId}).populate('courseId','title lessons').sort({updatedAt:-1}).lean(),
        Bookmark.find({userId:req.session.userId}).populate('courseId','title lessons').sort({createdAt:-1}).lean(),
        Wishlist.find({userId:req.session.userId}).populate('courseId','title thumbnail category level rating').sort({createdAt:-1}).lean(),
        Badge.find({userId:req.session.userId}).sort({earnedAt:-1}).lean(),
        LearningLog.find({userId:req.session.userId}).sort({date:-1}).limit(30).lean()
    ]);
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'My Learning Tools',section:'tools',notes,bookmarks,wishlist,badges,logs});
});
app.post('/notes', requireLogin, async(req,res)=>{await Note.findOneAndUpdate({userId:req.session.userId,courseId:req.body.courseId,lessonIndex:Number(req.body.lessonIndex)},{content:req.body.content},{upsert:true});res.redirect(`/courses/${req.body.courseId}/learn?lesson=${Number(req.body.lessonIndex)||0}`);});
app.post('/notes/:id/delete', requireLogin, async(req,res)=>{await Note.deleteOne({_id:req.params.id,userId:req.session.userId});res.redirect('/my-learning-tools');});
app.post('/bookmarks/toggle', requireLogin, async(req,res)=>{const q={userId:req.session.userId,courseId:req.body.courseId,lessonIndex:Number(req.body.lessonIndex)};const x=await Bookmark.findOne(q);if(x)await x.deleteOne();else await Bookmark.create(q);res.redirect(`/courses/${req.body.courseId}/learn?lesson=${q.lessonIndex}`);});
app.post('/wishlist/toggle', requireLogin, async(req,res)=>{const q={userId:req.session.userId,courseId:req.body.courseId};const x=await Wishlist.findOne(q);if(x)await x.deleteOne();else await Wishlist.create(q);res.redirect('/courses');});
app.post('/learning-time', requireLogin, async(req,res)=>{const mins=Math.min(1440,Math.max(1,Number(req.body.minutes)||1));await LearningLog.create({userId:req.session.userId,courseId:req.body.courseId,minutes:mins});await updateLearningStreak(req.session.userId);res.redirect(req.get('referer')||'/dashboard');});

// Student performance + instructor/admin analytics
app.get('/analytics', requireLogin, async(req,res)=>{
    const uid=req.session.userId;
    if(req.session.userRole==='student'){
        const courses=await Course.find({enrolledStudents:uid}).lean();
        const at=await QuizAttempt.find({userId:uid}).lean(); const assignments=await Assignment.find({courseId:{$in:courses.map(c=>c._id)}}).lean();
        const subs=await AssignmentSubmission.find({studentId:uid,assignmentId:{$in:assignments.map(a=>a._id)}}).lean();
        const att=await Attendance.find({studentId:uid}).lean(); const logs=await LearningLog.find({userId:uid}).lean();
        const attendancePct=att.length?Math.round(att.filter(x=>x.status==='present').length/att.length*100):0;
        const quizAvg=at.length?Math.round(at.reduce((n,x)=>n+x.percentage,0)/at.length):0;
        const assignAvg=subs.filter(x=>x.marks!=null).length?Math.round(subs.filter(x=>x.marks!=null).reduce((n,x)=>n+x.marks,0)/subs.filter(x=>x.marks!=null).length):0;
        const progress=courses.length?Math.round(courses.reduce((n,c)=>{const p=c.progress?.find(x=>String(x.userId)===String(uid));return n+(c.lessons.length?Math.round((p?.completedLessons?.length||0)/c.lessons.length*100):0)},0)/courses.length):0;
        res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'My Performance',section:'analytics',stats:{progress,attendancePct,quizAvg,assignAvg,learningMinutes:logs.reduce((n,x)=>n+x.minutes,0)},courses,attempts:at});
    } else {
        const filter=req.session.userRole==='teacher'?{teacherId:uid}:{};
        const courses=await Course.find(filter).lean(); const ids=courses.map(c=>c._id);
        const at=await QuizAttempt.find({courseId:{$in:ids}}).lean(); const att=await Attendance.find({courseId:{$in:ids}}).lean();
        const totalEnrollments=courses.reduce((n,c)=>n+c.enrolledStudents.length,0);
        const completion=courses.length?Math.round(courses.reduce((n,c)=>n+(c.enrolledStudents.length?c.completedStudents.length/c.enrolledStudents.length*100:0),0)/courses.length):0;
        res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Advanced Analytics',section:'instructor-analytics',courses,stats:{totalStudents:new Set(courses.flatMap(c=>c.enrolledStudents.map(String))).size,totalEnrollments,completion,quizAvg:at.length?Math.round(at.reduce((n,x)=>n+x.percentage,0)/at.length):0,attendance:att.length?Math.round(att.filter(x=>x.status==='present').length/att.length*100):0}});
    }
});

// Instructor profiles
app.get('/instructors/:id', requireLogin, async(req,res)=>{
    const instructor=await User.findOne({_id:req.params.id,role:'teacher'},{password:0}).lean(); if(!instructor) return res.status(404).send('Instructor not found');
    const courses=await Course.find({teacherId:instructor._id}).lean(); const reviewCount=courses.reduce((n,c)=>n+c.reviews.length,0); const rating=reviewCount?Math.round(courses.reduce((n,c)=>n+c.reviews.reduce((a,r)=>a+r.rating,0),0)/reviewCount*10)/10:0;
    res.render('feature',{name:req.session.userName,role:req.session.userRole,title:instructor.name+' — Instructor',section:'instructor-profile',instructor,courses,stats:{students:new Set(courses.flatMap(c=>c.enrolledStudents.map(String))).size,rating,reviewCount}});
});

// Messaging
app.get('/messages', requireLogin, async(req,res)=>{
    const messages=await Message.find({$or:[{senderId:req.session.userId},{receiverId:req.session.userId}]}).populate('senderId','name role').populate('receiverId','name role').sort({createdAt:-1}).lean();
    const users=await User.find({_id:{$ne:req.session.userId}},{name:1,role:1,email:1}).sort({name:1}).lean();
    res.render('feature',{name:req.session.userName,role:req.session.userRole,userId:req.session.userId,title:'Messages',section:'messages',messages,users});
});
app.post('/messages', requireLogin, async(req,res)=>{if(!req.body.receiverId||!req.body.body)return res.redirect('/messages');await Message.create({senderId:req.session.userId,receiverId:req.body.receiverId,body:req.body.body});await createNotification(req.body.receiverId,'system','New message',`${req.session.userName} sent you a message.`,`/messages`);res.redirect('/messages');});
app.post('/messages/:id/read', requireLogin, async(req,res)=>{await Message.updateOne({_id:req.params.id,receiverId:req.session.userId},{readAt:new Date()});res.redirect('/messages');});

// Reports / complaints
app.post('/reports', requireLogin, async(req,res)=>{await Report.create({reporterId:req.session.userId,courseId:req.body.courseId||null,targetUserId:req.body.targetUserId||null,reason:req.body.reason,details:req.body.details||''});await createNotification(req.session.userId,'system','Report submitted','Your report was sent to an administrator.','/dashboard');res.redirect(req.get('referer')||'/dashboard');});
app.get('/admin/reports', requireLogin, requireRole('admin'), async(req,res)=>{const reports=await Report.find().populate('reporterId','name email').populate('courseId','title').populate('targetUserId','name').sort({createdAt:-1}).lean();res.render('feature',{name:req.session.userName,role:req.session.userRole,title:'Reports & Complaints',section:'reports',reports});});
app.post('/admin/reports/:id/resolve', requireLogin, requireRole('admin'), async(req,res)=>{await Report.findByIdAndUpdate(req.params.id,{status:'resolved'});res.redirect('/admin/reports');});

// Badge automation endpoint can be called after learning/quiz completion
app.post('/badges/check', requireLogin, async(req,res)=>{
    const uid=req.session.userId; const courses=await Course.find({enrolledStudents:uid}).lean(); const completed=courses.filter(c=>c.completedStudents.some(x=>String(x)===String(uid))).length;
    if(completed>=1) await awardBadge(uid,'course-completed','Course Completed','🏆');
    if(completed>=5) await awardBadge(uid,'five-courses','5 Courses Completed','📚');
    const at=await QuizAttempt.find({userId:uid}).lean(); if(at.some(x=>x.percentage>=90)) await awardBadge(uid,'quiz-master','Quiz Master','⭐');
    const attendance=await Attendance.find({studentId:uid}).lean(); if(attendance.length&&attendance.filter(x=>x.status==='present').length/attendance.length>=.9) await awardBadge(uid,'attendance90','90% Attendance','🎯');
    res.redirect('/my-learning-tools');
});

// ─────────────────────────────────────────────────────────
//  GLOBAL ERROR HANDLER
//  Catches any errors that slip through the routes
// ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).send(`
        <h2>Something went wrong</h2>
        <p>${err.message}</p>
        <a href="/dashboard">Go back to Dashboard</a>
    `);
});

// ─────────────────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 9000;

function startServer(port) {
    const server = app.listen(port, () => {
        console.log(`🚀 Server running at http://localhost:${port}`);
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            const nextPort = port + 1;
            console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
            startServer(nextPort);
            return;
        }

        throw error;
    });
}

// Vercel imports this file as a serverless function and calls the exported
// app directly — it should NOT call app.listen(). Only start a normal
// listening server when running locally (e.g. `npm run dev` / `npm start`).
if (!process.env.VERCEL) {
    startServer(PORT);
}

module.exports = app;

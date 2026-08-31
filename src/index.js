// ─────────────────────────────────────────────────────────
// index.js  —  Online Learning Platform Server
// ─────────────────────────────────────────────────────────

// ── IMPORTS ──────────────────────────────────────────────
const path       = require('path');
const express    = require('express');
const bcrypt     = require('bcrypt');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const { User, Course, databaseConnection } = require('./config');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./email');
const crypto = require('crypto');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/learning-platform';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (process.env.NODE_ENV === 'production' && !SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production. Add it in Vercel Environment Variables.');
}

// ── APP SETUP ────────────────────────────────────────────
const app = express();
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

// ─────────────────────────────────────────────────────────
//  MIDDLEWARE HELPERS
// ─────────────────────────────────────────────────────────

// Only logged-in users can access the page
function requireLogin(req, res, next) {
    if (!req.session.userId) return res.redirect('/login');
    next();
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

        const match = await bcrypt.compare(password, user.password);
        if (!match)
            return res.render('login', { error: 'Invalid email or password.' });

        // New accounts must verify their email before they can log in.
        // Existing users created before this feature (without emailVerified)
        // are still allowed to log in.
        if (user.emailVerified === false) {
            return res.render('login', {
                error: 'Please verify your email before logging in. Check your inbox for the verification link.'
            });
        }

        // Save user info in session
        req.session.userId   = user._id;
        req.session.userName = user.name;
        req.session.userRole = user.role;

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
        const { username, email, password, role } = req.body;

        if (!username || !email || !password)
            return res.render('signup', { error: 'All fields are required.' });

        // Validate role
        const validRoles = ['admin', 'teacher', 'student'];
        const userRole = validRoles.includes(role) ? role : 'student';

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
//  DASHBOARD  (role-based)
// ─────────────────────────────────────────────────────────

app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        const { userName, userRole, userId } = req.session;
        let data = { name: userName, role: userRole };

        if (userRole === 'admin') {
            data.totalUsers   = await User.countDocuments();
            data.totalCourses = await Course.countDocuments();
            data.recentUsers  = await User.find().sort({ createdAt: -1 }).limit(5).lean();

        } else if (userRole === 'teacher') {
            data.myCourses = await Course.find({ teacherId: userId }).lean();

        } else {
            // student
            data.enrolledCourses = await Course.find({ enrolledStudents: userId }).lean();
            data.totalCourses    = await Course.countDocuments();
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

// Browse all courses
app.get('/courses', requireLogin, async (req, res) => {
    try {
        const { userId, userName, userRole } = req.session;
        const courses = await Course.find().lean();

        // For each course, mark whether the logged-in student is enrolled
        const coursesWithStatus = courses.map(c => ({
            ...c,
            isEnrolled: c.enrolledStudents.map(id => id.toString()).includes(userId.toString())
        }));

        res.render('courses', { name: userName, role: userRole, courses: coursesWithStatus });

    } catch (err) {
        console.error('Courses error:', err);
        res.redirect('/dashboard');
    }
});

// Show add course form — MUST be before /courses/:id
app.get('/courses/add', requireLogin, requireRole('teacher', 'admin'), (req, res) => {
    res.render('add-course', { name: req.session.userName, role: req.session.userRole });
});

// Handle add course form
app.post('/courses/add', requireLogin, requireRole('teacher', 'admin'), async (req, res) => {
    try {
        const { title, description, category, duration, level } = req.body;

        if (!title || !description)
            return res.render('add-course', {
                name: req.session.userName,
                role: req.session.userRole,
                error: 'Title and description are required.'
            });

        await Course.create({
            title,
            description,
            category:    category || 'General',
            duration:    duration || '4 weeks',
            level:       level    || 'Beginner',
            teacherId:   req.session.userId,
            teacherName: req.session.userName
        });

        res.redirect('/courses');

    } catch (err) {
        console.error('Add course error:', err);
        res.render('add-course', {
            name: req.session.userName,
            role: req.session.userRole,
            error: 'Could not create course. Please try again.'
        });
    }
});

// View a single course — MUST be after /courses/add
app.get('/courses/:id', requireLogin, async (req, res) => {
    try {
        const { userId, userName, userRole } = req.session;

        const course = await Course.findById(req.params.id).lean();
        if (!course) return res.redirect('/courses');

        const isEnrolled = course.enrolledStudents
            .map(id => id.toString())
            .includes(userId.toString());

        const isOwner = course.teacherId.toString() === userId.toString();

        res.render('course-detail', { name: userName, role: userRole, course, isEnrolled, isOwner });

    } catch (err) {
        console.error('Course detail error:', err);
        res.redirect('/courses');
    }
});

// Enroll in a course (students only)
app.post('/courses/:id/enroll', requireLogin, requireRole('student'), async (req, res) => {
    try {
        await Course.findByIdAndUpdate(req.params.id, {
            $addToSet: { enrolledStudents: req.session.userId }
        });
        res.redirect(`/courses/${req.params.id}`);
    } catch (err) {
        console.error('Enroll error:', err);
        res.redirect('/courses');
    }
});

// Unenroll from a course (students only)
app.post('/courses/:id/unenroll', requireLogin, requireRole('student'), async (req, res) => {
    try {
        await Course.findByIdAndUpdate(req.params.id, {
            $pull: { enrolledStudents: req.session.userId }
        });
        res.redirect(`/courses/${req.params.id}`);
    } catch (err) {
        console.error('Unenroll error:', err);
        res.redirect('/courses');
    }
});

// Delete a course (teacher who owns it, or admin)
app.post('/courses/:id/delete', requireLogin, requireRole('teacher', 'admin'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.redirect('/courses');

        // Teachers can only delete their own courses
        if (req.session.userRole === 'teacher' &&
            course.teacherId.toString() !== req.session.userId.toString()) {
            return res.redirect('/courses');
        }

        await Course.findByIdAndDelete(req.params.id);
        res.redirect('/courses');

    } catch (err) {
        console.error('Delete course error:', err);
        res.redirect('/courses');
    }
});

// ─────────────────────────────────────────────────────────
//  PROFILE
// ─────────────────────────────────────────────────────────

app.get('/profile', requireLogin, async (req, res) => {
    try {
        // Get fresh user data (exclude password field)
        const user = await User.findById(req.session.userId, { password: 0 }).lean();
        res.render('profile', { name: req.session.userName, role: req.session.userRole, user });
    } catch (err) {
        console.error('Profile error:', err);
        res.redirect('/dashboard');
    }
});

app.post('/profile/update', requireLogin, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.redirect('/profile');

        // Check if name is taken by another user
        const existing = await User.findOne({ name: name.trim(), _id: { $ne: req.session.userId } });
        if (existing) {
            const user = await User.findById(req.session.userId, { password: 0 }).lean();
            return res.render('profile', {
                name: req.session.userName,
                role: req.session.userRole,
                user,
                error: 'That username is already taken.'
            });
        }

        await User.findByIdAndUpdate(req.session.userId, { name: name.trim() });
        req.session.userName = name.trim();
        res.redirect('/profile');

    } catch (err) {
        console.error('Profile update error:', err);
        res.redirect('/profile');
    }
});

// ─────────────────────────────────────────────────────────
//  ADMIN — Manage Users
// ─────────────────────────────────────────────────────────

app.get('/admin/users', requireLogin, requireRole('admin'), async (req, res) => {
    try {
        const users = await User.find({}, { password: 0 }).lean();
        res.render('admin-users', { name: req.session.userName, role: req.session.userRole, users });
    } catch (err) {
        console.error('Admin users error:', err);
        res.redirect('/dashboard');
    }
});

app.post('/admin/users/:id/delete', requireLogin, requireRole('admin'), async (req, res) => {
    try {
        if (req.params.id === req.session.userId.toString())
            return res.redirect('/admin/users');
        await User.findByIdAndDelete(req.params.id);
        res.redirect('/admin/users');
    } catch (err) {
        console.error('Delete user error:', err);
        res.redirect('/admin/users');
    }
});

app.post('/admin/users/:id/role', requireLogin, requireRole('admin'), async (req, res) => {
    try {
        const { role } = req.body;
        const validRoles = ['admin', 'teacher', 'student'];
        if (validRoles.includes(role)) {
            await User.findByIdAndUpdate(req.params.id, { role });
        }
        res.redirect('/admin/users');
    } catch (err) {
        console.error('Change role error:', err);
        res.redirect('/admin/users');
    }
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

// email.js — sends email verification messages using SMTP
const nodemailer = require('nodemailer');

const smtpPort = Number(process.env.SMTP_PORT || 587);

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

async function sendVerificationEmail({ to, name, token }) {
    const appUrl = (process.env.APP_URL || 'http://localhost:9000').replace(/\/$/, '');
    const verifyUrl = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;

    await transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        to,
        subject: 'Verify your LearnHub email',
        text: `Hi ${name},\n\nPlease verify your LearnHub account by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
        html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;">
                <h2>Welcome to LearnHub, ${escapeHtml(name)}!</h2>
                <p>Thanks for creating your account. Please verify your email address to activate your account.</p>
                <p>
                    <a href="${verifyUrl}"
                       style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
                       Verify Email
                    </a>
                </p>
                <p>This verification link expires in 24 hours.</p>
            </div>
        `
    });
}

// Keep the user's name safe when it is inserted into the HTML email.
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = { sendVerificationEmail };

const nodemailer = require("nodemailer");

const buildTransporter = () => {
  const hasService = !!process.env.SMTP_SERVICE;
  const hasHost = !!process.env.SMTP_HOST;

  if (!hasService && !hasHost) {
    throw new Error(
      "Email service is not configured. Set SMTP_SERVICE or SMTP_HOST in backend .env",
    );
  }

  return nodemailer.createTransport({
    service: process.env.SMTP_SERVICE || undefined,
    host: process.env.SMTP_HOST || undefined,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const sendVerificationOtpEmail = async ({ toEmail, username, otp }) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error(
      "Email credentials missing. Set SMTP_USER and SMTP_PASS in backend .env",
    );
  }

  const transporter = buildTransporter();
  const appName = "Game Plug";
  const from = process.env.SMTP_FROM || `"${appName}" <${process.env.SMTP_USER}>`;

  await transporter.sendMail({
    from,
    to: toEmail,
    subject: `${appName} - Your verification code`,
    text: `Hello ${username},\n\nYour ${appName} verification code is: ${otp}\n\nThis code will expire in 10 minutes.\n\nIf you did not request this, please ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #111827;">
        <h2 style="margin-bottom: 8px;">Verify your email</h2>
        <p style="margin-top: 0; color: #6B7280;">Hello ${username},</p>
        <p>Use this OTP code to verify your ${appName} account:</p>
        <div style="font-size: 32px; letter-spacing: 8px; font-weight: 700; background: #F3F4F6; border-radius: 10px; padding: 16px; text-align: center; margin: 20px 0;">${otp}</div>
        <p style="margin: 0 0 4px 0;"><strong>This code expires in 10 minutes.</strong></p>
        <p style="color: #6B7280; font-size: 14px;">If you didn't create this account, you can safely ignore this email.</p>
      </div>
    `,
  });
};

module.exports = {
  sendVerificationOtpEmail,
};

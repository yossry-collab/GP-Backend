const DEFAULT_ALLOWED_EMAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "yahoo.fr",
  "live.com",
];

const EMAIL_PROVIDER_ERROR_MESSAGE =
  "Please use a valid email provider (Gmail, Outlook, Yahoo...).";

const EMAIL_FORMAT_ERROR_MESSAGE = "Please enter a valid email address.";

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseDomainsFromEnv = () => {
  const raw = String(process.env.ALLOWED_EMAIL_PROVIDERS || "").trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
};

const ALLOWED_EMAIL_DOMAINS = Array.from(
  new Set([...DEFAULT_ALLOWED_EMAIL_DOMAINS, ...parseDomainsFromEnv()]),
);

const normalizeEmail = (email = "") => email.trim().toLowerCase();

const extractDomain = (email = "") => {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return "";
  }

  return normalized.slice(atIndex + 1);
};

const isEmailFormatValid = (email = "") => {
  return EMAIL_FORMAT_REGEX.test(normalizeEmail(email));
};

const isTrustedEmailProvider = (email = "") => {
  const domain = extractDomain(email);
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
};

const validateTrustedEmail = (email = "") => {
  const normalized = normalizeEmail(email);

  if (!normalized || !isEmailFormatValid(normalized)) {
    return {
      isValid: false,
      normalizedEmail: normalized,
      message: EMAIL_FORMAT_ERROR_MESSAGE,
      reason: "invalid_format",
    };
  }

  if (!isTrustedEmailProvider(normalized)) {
    return {
      isValid: false,
      normalizedEmail: normalized,
      message: EMAIL_PROVIDER_ERROR_MESSAGE,
      reason: "provider_not_allowed",
    };
  }

  return {
    isValid: true,
    normalizedEmail: normalized,
    message: "",
    reason: "",
  };
};

module.exports = {
  DEFAULT_ALLOWED_EMAIL_DOMAINS,
  ALLOWED_EMAIL_DOMAINS,
  EMAIL_PROVIDER_ERROR_MESSAGE,
  EMAIL_FORMAT_ERROR_MESSAGE,
  normalizeEmail,
  extractDomain,
  isEmailFormatValid,
  isTrustedEmailProvider,
  validateTrustedEmail,
};

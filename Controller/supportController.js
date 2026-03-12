const Order = require("../Models/orderModel");
const Product = require("../Models/productModel");
const SupportKnowledge = require("../Models/supportKnowledgeModel");
const SupportTicket = require("../Models/supportTicketModel");
const User = require("../Models/userModel");
const { LoyaltyBalance } = require("../Models/loyaltyModel");
const Notification = require("../Models/notificationModel");
const { createNotification } = require("./notificationController");
const supportKnowledgeSeed = require("../data/supportKnowledgeSeed");
const {
  generateSupportAssistantReply,
} = require("../Services/supportAssistantService");

const getUserId = (req) => req.user.userId || req.user._id;

const normalizeLocale = (locale) => (locale === "fr" ? "fr" : "en");

const toArticlePayload = (article, locale = "en") => {
  const normalizedLocale = normalizeLocale(locale);
  const localized =
    article.translations.find((entry) => entry.locale === normalizedLocale) ||
    article.translations.find((entry) => entry.locale === "en") ||
    article.translations[0];

  return {
    _id: article._id,
    slug: article.slug,
    category: article.category,
    tags: article.tags,
    sortOrder: article.sortOrder,
    locale: localized.locale,
    title: localized.title,
    question: localized.question,
    summary: localized.summary,
    answer: localized.answer,
    updatedAt: article.updatedAt,
  };
};

const ensureDefaultSupportKnowledge = async () => {
  const count = await SupportKnowledge.countDocuments();
  if (count === 0) {
    await SupportKnowledge.insertMany(supportKnowledgeSeed);
  }
};

const getKnowledgeArticles = async ({ locale = "en", category, search }) => {
  await ensureDefaultSupportKnowledge();

  const filter = { isPublished: true };
  if (category) {
    filter.category = category;
  }

  const articles = await SupportKnowledge.find(filter)
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  return articles
    .map((article) => toArticlePayload(article, locale))
    .filter((article) => {
      if (!search) return true;
      const haystack = [
        article.title,
        article.question,
        article.answer,
        article.summary,
        ...(article.tags || []),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(search.toLowerCase());
    });
};

const buildSupportContext = async (userId) => {
  const user = await User.findById(userId)
    .select("username email phonenumber role")
    .lean();

  if (!user) {
    return null;
  }

  const [orders, loyaltyBalance, unreadNotifications, openTickets, featuredProducts] =
    await Promise.all([
      Order.find({ userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("items totalPrice totalItems status paymentStatus createdAt")
        .lean(),
      LoyaltyBalance.findOne({ userId })
        .select("points lifetimePoints tier streakDays tierExpiresAt")
        .lean(),
      Notification.countDocuments({ userId, read: false }),
      SupportTicket.countDocuments({
        userId,
        status: { $in: ["open", "in_progress", "waiting_on_customer"] },
      }),
      Product.find({ featured: true })
        .sort({ updatedAt: -1 })
        .limit(3)
        .select("name category price stock discountPercentage platform")
        .lean(),
    ]);

  const recentOrders = orders.map((order) => ({
    _id: order._id,
    totalPrice: order.totalPrice,
    totalItems: order.totalItems,
    status: order.status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    items: (order.items || []).map((item) => ({
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      category: item.category,
      price: item.price,
    })),
  }));

  return {
    user: {
      _id: user._id,
      email: user.email,
      username: user.username,
      phonenumber: user.phonenumber || "",
      role: user.role,
    },
    recentOrders,
    loyalty: loyaltyBalance || {
      points: 0,
      lifetimePoints: 0,
      tier: "free",
      streakDays: 0,
      tierExpiresAt: null,
    },
    unreadNotifications,
    openTickets,
    featuredProducts,
  };
};

exports.getKnowledgeBase = async (req, res) => {
  try {
    const locale = normalizeLocale(req.query.locale);
    const category = req.query.category;
    const search = req.query.search?.trim();
    const shapedArticles = await getKnowledgeArticles({ locale, category, search });

    res.status(200).json({
      message: "Support knowledge retrieved successfully",
      count: shapedArticles.length,
      articles: shapedArticles,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving support knowledge",
      error: error.message,
    });
  }
};

exports.getSupportContext = async (req, res) => {
  try {
    const userId = getUserId(req);

    const context = await buildSupportContext(userId);

    if (!context) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json({
      message: "Support context retrieved successfully",
      context,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving support context",
      error: error.message,
    });
  }
};

exports.askSupportAssistant = async (req, res) => {
  try {
    const userId = getUserId(req);
    const locale = normalizeLocale(req.body.locale);
    const message = req.body.message?.trim();
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    if (!message) {
      return res.status(400).json({ message: "Message is required." });
    }

    const [context, articles] = await Promise.all([
      buildSupportContext(userId),
      getKnowledgeArticles({ locale, search: message }),
    ]);

    if (!context) {
      return res.status(404).json({ message: "User not found." });
    }

    const assistantReply = await generateSupportAssistantReply({
      locale,
      message,
      history,
      articles,
      supportContext: context,
    });

    res.status(200).json({
      message: "Support assistant reply generated successfully",
      reply: assistantReply.reply,
      source: assistantReply.source,
      matchedArticles: assistantReply.matchedArticles,
      needsEscalation: assistantReply.needsEscalation,
      suggestedPrompts: assistantReply.suggestedPrompts,
      modelError: assistantReply.modelError,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error generating support assistant reply",
      error: error.message,
    });
  }
};

exports.createSupportTicket = async (req, res) => {
  try {
    const userId = getUserId(req);
    const {
      subject,
      category = "other",
      priority = "medium",
      language = "en",
      orderId,
      message,
      summary = "",
      aiSummary = "",
      source = "chatwoot",
      metadata = {},
    } = req.body;

    if (!subject?.trim() || !message?.trim()) {
      return res.status(400).json({
        message: "Subject and message are required.",
      });
    }

    let linkedOrder = null;
    if (orderId) {
      linkedOrder = await Order.findById(orderId).select("userId").lean();
      if (!linkedOrder) {
        return res.status(404).json({ message: "Linked order not found." });
      }
      if (linkedOrder.userId.toString() !== userId.toString()) {
        return res.status(403).json({
          message: "You are not authorized to create a ticket for this order.",
        });
      }
    }

    const ticket = await SupportTicket.create({
      userId,
      orderId: linkedOrder?._id || null,
      subject: subject.trim(),
      category,
      priority,
      language: normalizeLocale(language),
      source,
      summary: summary.trim(),
      customerMessage: message.trim(),
      aiSummary: aiSummary.trim(),
      metadata,
      messages: [
        {
          sender: "customer",
          message: message.trim(),
        },
      ],
    });

    await createNotification(
      userId,
      "system",
      "Support ticket created",
      `Your support request ${ticket._id.toString().slice(-8).toUpperCase()} has been created and is waiting for review.`,
      { ticketId: ticket._id, category: ticket.category, status: ticket.status }
    );

    res.status(201).json({
      message: "Support ticket created successfully",
      ticket,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error creating support ticket",
      error: error.message,
    });
  }
};

exports.getMySupportTickets = async (req, res) => {
  try {
    const userId = getUserId(req);
    const tickets = await SupportTicket.find({ userId })
      .sort({ createdAt: -1 })
      .select("subject category priority status language source orderId summary customerMessage createdAt updatedAt")
      .lean();

    res.status(200).json({
      message: "Support tickets retrieved successfully",
      count: tickets.length,
      tickets,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving support tickets",
      error: error.message,
    });
  }
};

exports.getSupportTicketById = async (req, res) => {
  try {
    const userId = getUserId(req);
    const ticket = await SupportTicket.findOne({ _id: req.params.id, userId })
      .populate({ path: "orderId", select: "totalPrice totalItems status paymentStatus createdAt" })
      .lean();

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found." });
    }

    res.status(200).json({
      message: "Support ticket retrieved successfully",
      ticket,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving support ticket",
      error: error.message,
    });
  }
};